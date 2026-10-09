/**
 * End-to-end evaluation of BC-ZTA against three baselines on a live EVM chain (Besu IBFT 2.0 in CI).
 *  E1  access latency / goodput vs number of devices, per architecture
 *  E2  revocation enforcement delay (time from revocation until the PEP first denies), per architecture
 *  E3  security tests (forgery, replay, stale timestamp, unknown DID, tampered Merkle proof, class violation, low trust)
 *  E4  availability of access decisions while the ledger is flooded with transactions
 * Env: RPC_URL, DEVICE_COUNTS, DURATION_S, WARMUP_S, REV_REPS, REV_TTL_S, WAN_RTT_MS, OUT, QUICK=1
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { h, now, sleep, stats, IFACES, Rpc, SenderPool, ethers } = require("./lib");
const { onboard } = require("./onboard");
const { runLoad, makeReq, post, getStats } = require("./loadgen");

const QUICK = !!process.env.QUICK;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const COUNTS = (process.env.DEVICE_COUNTS || (QUICK ? "10,25" : "10,25,50,100,200")).split(",").map(Number);
const DURATION = Number(process.env.DURATION_S || (QUICK ? 5 : 20));
const WARMUP = Number(process.env.WARMUP_S || (QUICK ? 2 : 5));
const REV_REPS = Number(process.env.REV_REPS || (QUICK ? 3 : 8));
const REV_TTL = Number(process.env.REV_TTL_S || (QUICK ? 4 : 10));
const WAN = Number(process.env.WAN_RTT_MS || 40);
const OUT = process.env.OUT || path.join(__dirname, "output");
const PORT = 9000, CPORT = 9100;
const MODES = [["central", "central", {}], ["abac", "abac", {}], ["bczta", "bczta", { INVALIDATION: "events", TTL_S: "30" }], ["bcsync", "bcsync", {}]];
const CONFIG = path.join(OUT, "config.json");

const AGENT = { pep: process.env.AGENT_PEP, dir: process.env.AGENT_DIR };   // set for multi-host runs
const CENTRAL_HOST = process.env.CENTRAL_HOST || "127.0.0.1";
const agentPost = (base, p, body) => new Promise((resolve, reject) => {
  const u = new URL(base + p);
  const rq = require("http").request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: 90000 }, (res) => {
    const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error("agent " + p + ": " + Buffer.concat(c).toString()))));
  });
  rq.on("error", reject); rq.end(typeof body === "string" ? body : JSON.stringify(body));
});
async function startProc(where, file, env, readyText) {
  if (!AGENT[where]) { const p = await spawnProc(file, env, readyText); return { stop: () => stop(p) }; }
  await agentPost(AGENT[where], "/start", { file, env, ready: readyText });
  return { stop: () => agentPost(AGENT[where], "/stop", { file }) };
}
function spawnProc(file, env, readyText) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(__dirname, file)], { env: { ...process.env, CONFIG, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let done = false;
    p.stdout.on("data", (d) => { if (!done && String(d).includes(readyText)) { done = true; resolve(p); } });
    p.on("exit", (c) => { if (!done) reject(new Error(file + " exited " + c)); });
    setTimeout(() => { if (!done) reject(new Error(file + " start timeout")); }, 60000);
  });
}
const stop = (p) => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 3000); });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rpc = new Rpc(RPC_URL);
  const variants = ["central", "abac", "bcsync", "bczta-events", "bczta-ttl"];
  const ob = await onboard({ rpcUrl: RPC_URL, nLoad: Math.max(...COUNTS), variants, nRev: REV_REPS });
  fs.writeFileSync(CONFIG, JSON.stringify(ob.config));
  for (const w of ["pep", "dir"]) if (AGENT[w]) await agentPost(AGENT[w], "/config", JSON.stringify(ob.config));
  const { config, devices, deployer, feeSend } = ob;
  const dev = (name) => devices.find((d) => d.name === name);
  const result = { meta: { date: new Date().toISOString(), rpc: RPC_URL, chainId: config.chainId, counts: COUNTS, duration_s: DURATION, warmup_s: WARMUP, wan_rtt_ms: WAN, deployment: process.env.DEPLOYMENT || "single-host", netem_wan_ms: Number(process.env.NETEM_WAN_MS || 0), netem_validator_ms: Number(process.env.NETEM_VAL_MS || 0), quick: QUICK } };
  const central = await startProc("dir", "central.js", { PORT: String(CPORT), WAN_RTT_MS: String(WAN) }, "central ready");

  const drain = async (maxMs = 180000) => {
    const t0 = now();
    const addrs = config.senderKeys.map((k) => new ethers.Wallet(k).address);
    for (;;) {
      const rs = await Promise.all(addrs.flatMap((a) => [rpc.one("eth_getTransactionCount", [a, "latest"]), rpc.one("eth_getTransactionCount", [a, "pending"])]));
      let same = true; for (let i = 0; i < rs.length; i += 2) if (rs[i] !== rs[i + 1]) same = false;
      if (same || now() - t0 > maxMs) return;
      await sleep(1000);
    }
  };

  // ---------------- E1: latency / goodput vs devices ----------------
  result.E1 = {};
  for (const [label, mode, env] of MODES) {
    result.E1[label] = [];
    for (const N of COUNTS) {
      const pep = await startProc("pep", "pep.js", { MODE: mode, PORT: String(PORT), CENTRAL_URL: process.env.CENTRAL_URL || `http://127.0.0.1:${CPORT}`, ...env }, "pep ready");
      const t0 = now();
      const r = await runLoad({ port: PORT, devices: devices.slice(0, N), resource: config.resource, durationS: DURATION, warmupS: WARMUP });
      const st = await getStats(PORT);
      const wall = (now() - t0) / 1000;
      r.pep = { cache_hit_ratio: st.cacheHit + st.cacheMiss ? st.cacheHit / (st.cacheHit + st.cacheMiss) : null, chain_reads: st.chainReads, tx_sent: st.txSent, tx_confirmed: st.txConfirmed,
                anchors_sent: st.anchorsSent, anchors_confirmed: st.anchorsConfirmed, anchored_events: st.anchorLeaves, cpu_cores_avg: (st.cpu.user + st.cpu.system) / 1e6 / wall };
      result.E1[label].push(r);
      console.log(`E1 ${label} N=${N}: mean ${r.mean_ms?.toFixed(1)} ms p95 ${r.p95_ms?.toFixed(1)} ms goodput ${r.goodput_rps.toFixed(1)}/s fail ${r.failed_or_timeout} denied ${r.denied}`);
      await pep.stop();
      if (mode === "bcsync" || mode === "bczta") await drain();
    }
  }

  // ---------------- E2: revocation enforcement delay ----------------
  const authority = deployer;
  const IRc = ob.contracts.IR;
  const revoke = {
    central: async (d) => { await post(CPORT, "/admin/revoke", { did: d.did }, 30000, CENTRAL_HOST); },
    abac: async (d) => { await post(PORT, "/admin/revoke", { did: d.did }); },
    chain: async (d) => { await IRc.revokeDID(d.did, feeSend); },
  };
  result.E2 = {};
  for (const [variant, mode, env, how] of [["central", "central", {}, "central"], ["abac", "abac", {}, "abac"], ["bcsync", "bcsync", {}, "chain"],
        ["bczta-events", "bczta", { INVALIDATION: "events", TTL_S: String(REV_TTL) }, "chain"], ["bczta-ttl", "bczta", { INVALIDATION: "ttl", TTL_S: String(REV_TTL) }, "chain"]]) {
    const pep = await startProc("pep", "pep.js", { MODE: mode, PORT: String(PORT), CENTRAL_URL: process.env.CENTRAL_URL || `http://127.0.0.1:${CPORT}`, ...env }, "pep ready");
    const delays = [];
    for (let j = 0; j < REV_REPS; j++) {
      const d = dev(`rev-${variant}-${j}`);
      const wait = (variant === "bczta-ttl" ? Math.random() * REV_TTL : 0.5 + Math.random() * 1.5) * 1000;
      let T0 = null, revokeDone = null, tDeny = null;
      const tStart = now(), inflight = [];
      // open-loop probe: a new signed request every 50 ms, so detection is not limited by the latency of an in-flight request
      for (let it = 0; it < 6000 && tDeny === null; it++) {
        if (T0 === null && now() - tStart >= wait) { T0 = now(); revokeDone = revoke[how](d); }
        inflight.push(makeReq(d, config.resource, Date.now()).then((rq) => post(PORT, "/access", rq, 60000)).then((r) => {
          if (T0 !== null && tDeny === null && r.out && !r.out.ok && r.out.reason === "revoked") tDeny = now();
        }));
        await sleep(50);
      }
      await Promise.allSettled(inflight);
      await revokeDone;
      if (tDeny) delays.push(tDeny - T0);
      await sleep(300);
    }
    result.E2[variant] = { ttl_s: variant.startsWith("bczta") ? REV_TTL : null, reps: REV_REPS, ...stats(delays), samples_ms: delays };
    console.log("E2", variant, JSON.stringify({ mean: result.E2[variant].mean_ms, p95: result.E2[variant].p95_ms, max: result.E2[variant].max_ms }));
    await pep.stop();
    if (mode !== "abac" && mode !== "central") await drain();
  }

  // ---------------- E3: security tests (proposed architecture) ----------------
  const pep = await startProc("pep", "pep.js", { MODE: "bczta", PORT: String(PORT), INVALIDATION: "events", TTL_S: "30", CENTRAL_URL: process.env.CENTRAL_URL || `http://127.0.0.1:${CPORT}` }, "pep ready");
  const NSEC = QUICK ? 10 : 50;
  const ghost = new ethers.Wallet(h("bc-zta-ghost"));
  const sec = {};
  const run = async (name, fn) => { let allowed = 0, denied = 0; const reasons = {}; for (let i = 0; i < NSEC; i++) { const r = await fn(i); if (r && r.ok) allowed++; else { denied++; const k = r && r.reason || "none"; reasons[k] = (reasons[k] || 0) + 1; } } sec[name] = { attempts: NSEC, allowed, denied, reasons }; console.log("E3", name, JSON.stringify(sec[name])); };
  const send = async (d, opts = {}, ts = Date.now()) => (await post(PORT, "/access", await makeReq(d, config.resource, ts, opts))).out;
  await run("legitimate_requests (control)", () => send(dev("atk-legit")));
  await run("forged_signature", () => send(dev("atk-legit"), { signer: ghost }));
  await run("replayed_request", async () => { const rq = await makeReq(dev("atk-replay"), config.resource, Date.now()); await post(PORT, "/access", rq); return (await post(PORT, "/access", rq)).out; });
  await run("stale_timestamp", () => send(dev("atk-legit"), {}, Date.now() - 60000));
  await run("unregistered_DID", async () => { const gd = { did: h("did:iiot:ghost-" + Math.random()), wallet: ghost, proof: [], cls: 0 }; return send(gd); });
  await run("tampered_merkle_proof", () => { const d = dev("atk-tamper"); const p = [...d.proof]; p[0] = h("tampered"); return send(d, { proof: p }); });
  await run("device_class_outside_policy", () => send(dev("atk-class3")));
  await run("low_trust_score", () => send(dev("atk-lowtrust")));
  // revoked device: accepted before revocation, then the number of requests still accepted after the revocation tx is confirmed
  {
    const d = dev("atk-revoked");
    const before = []; for (let i = 0; i < 5; i++) before.push((await send(d))?.ok);
    const tx = await IRc.revokeDID(d.did, feeSend); const t0 = now(); await tx.wait(); const tConf = now();
    let acceptedAfter = 0, firstDeny = null;
    for (let i = 0; i < 100; i++) { const r = await send(d); if (r?.ok) acceptedAfter++; else if (firstDeny === null) firstDeny = now() - tConf; await sleep(10); }
    sec["revoked_device"] = { accepted_before_revocation: before.filter(Boolean).length, accepted_after_tx_confirmed: acceptedAfter, first_denial_after_confirmation_ms: firstDeny };
    console.log("E3 revoked_device", JSON.stringify(sec["revoked_device"]));
  }
  result.E3 = sec;
  await pep.stop();
  await drain();

  // ---------------- E4: availability under ledger flooding ----------------
  result.E4 = {};
  {
    const N = Math.min(50, Math.max(...COUNTS));
    const spamRate = Number(process.env.SPAM_TPS || 200), spamSec = DURATION + WARMUP + 10;
    for (const withSpam of [false, true]) {
      const pepx = await startProc("pep", "pep.js", { MODE: "bczta", PORT: String(PORT), INVALIDATION: "events", TTL_S: "30", CENTRAL_URL: process.env.CENTRAL_URL || `http://127.0.0.1:${CPORT}` }, "pep ready");
      let spamP = Promise.resolve(), spamInfo = null;
      if (withSpam) {
        const sp = new SenderPool(rpc, ob.spamKeys, config.chainId, config.fee.type === 2 ? { type: 2, maxFeePerGas: BigInt(config.fee.maxFeePerGas), maxPriorityFeePerGas: BigInt(config.fee.maxPriorityFeePerGas) } : { type: 0, gasPrice: BigInt(config.fee.gasPrice) });
        await sp.init();
        const total = spamRate * spamSec, raws = [];
        for (let i = 0; i < total; i++) { const k = i % sp.w.length; raws.push(await sp.w[k].signTransaction({ to: config.addrs.AL, data: IFACES.AuditLog.encodeFunctionData("logEvent", [h("spam"), h("spam"), 9]), gasLimit: 300000, nonce: sp.nonces[k]++, chainId: config.chainId, value: 0, ...sp.fee })); }
        spamInfo = { offered_tps: spamRate, seconds: spamSec, txs: total };
        spamP = (async () => { const t0 = now(); let sent = 0, errs = 0; for (let i = 0; i < total; i++) { const w = t0 + (i * 1000) / spamRate - now(); if (w > 1) await sleep(w); rpc.one("eth_sendRawTransaction", [raws[i]]).then(() => sent++).catch(() => errs++); } await sleep(500); spamInfo.sent = sent; spamInfo.rejected = errs; })();
      }
      const r = await runLoad({ port: PORT, devices: devices.slice(0, N), resource: config.resource, durationS: DURATION, warmupS: WARMUP });
      await spamP; await pepx.stop();
      result.E4[withSpam ? "bczta_under_flood" : "bczta_idle_ledger"] = { ...r, flood: spamInfo };
      console.log("E4", withSpam ? "flood" : "idle", `mean ${r.mean_ms?.toFixed(1)} p95 ${r.p95_ms?.toFixed(1)} ok ${r.ok}/${r.measured}`);
      await drain(240000);
    }
  }
  await central.stop();
  fs.writeFileSync(path.join(OUT, "e2e_results.json"), JSON.stringify(result, null, 2));
  console.log("wrote", OUT);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
