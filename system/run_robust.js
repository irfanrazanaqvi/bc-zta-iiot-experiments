/**
 * Robustness and fairness experiments added after review (extended evaluation 2).
 *  P1  access latency of two additional designs: B6 "central + push" (PEP caches the directory's answers and the directory pushes revocations:
 *      event-driven invalidation WITHOUT a blockchain) and BC-ZTA with a f+1 = 2 node read quorum (PEP no longer trusts a single ledger node).
 *  P2  revocation enforcement delay of B6 and of BC-ZTA with read quorum (same method as run_iam.js X2).
 *  P3  loss of the state source: BC-ZTA PEP is cut off from its ledger node (iptables DROP) / B6 directory stopped, TTL 10 s, so the fail-closed
 *      bound is 2 x TTL = 20 s: requests are granted from cache, then from stale state, then denied, and recover after the source returns.
 *  P4  consensus halt (runs last): two of four validators stopped (IBFT needs 3 of 4): decisions continue, but a revocation submitted during the halt can only
 *      be enforced after consensus resumes.
 *  P5  horizontal scaling: k PEP processes (k = 1, 2, 4) on one VM behind a device-sharding load generator, offered rate sweep.
 * Env: RPC_URL, RPC_URLS (comma list of validator RPCs, >= 2), AGENT_PEP, AGENT_DIR, AGENT_VAL3, AGENT_VAL4, DIR_HOST, PEP_HOST, LEDGER_IP (RPC node IP seen by the PEP),
 *      PARTS=p1,p2,p3,p4,p5, OUT, QUICK=1, TTL_S, PEP_COUNTS, PEP_RATES
 */
const fs = require("fs");
const path = require("path");
const { now, sleep, stats, Rpc, ethers } = require("./lib");
const { onboard } = require("./onboard");
const { runLoad, makeReq, post, getStats } = require("./loadgen");
const { makeStarter, pushConfig, drain, agentPost } = require("./harness");

const QUICK = !!process.env.QUICK;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const RPC_URLS = process.env.RPC_URLS || `${RPC_URL},${RPC_URL}`;
const DIR_HOST = process.env.DIR_HOST || "127.0.0.1";
const LEDGER_IP = process.env.LEDGER_IP || null;
const PARTS = (process.env.PARTS || "p1,p2,p3,p4,p5").split(",");
const COUNTS = (process.env.COUNTS || (QUICK ? "10,25" : "25,100,200")).split(",").map(Number);
const DURATION = Number(process.env.DURATION_S || (QUICK ? 5 : 20)), WARMUP = Number(process.env.WARMUP_S || (QUICK ? 2 : 5));
const REV_REPS = Number(process.env.REV_REPS || (QUICK ? 3 : 8));
const TTL = Number(process.env.TTL_S || 10);                              // TTL of the outage tests (fail-closed bound = 2 x TTL)
const RUN_S = Number(process.env.OUTAGE_DURATION_S || (QUICK ? 60 : 100)), CUT_S = Number(process.env.OUTAGE_STOP_S || (QUICK ? 10 : 20)), BACK_S = Number(process.env.OUTAGE_START_S || (QUICK ? 40 : 70));
const PEP_COUNTS = (process.env.PEP_COUNTS || (QUICK ? "1,2" : "1,2,4")).split(",").map(Number);
const PEP_RATES = (process.env.PEP_RATES || (QUICK ? "100,200" : "200,400,800,1200,1600")).split(",").map(Number);
const PF_DUR = Number(process.env.PEP_DURATION_S || (QUICK ? 4 : 12)), PF_WARM = Number(process.env.PEP_WARMUP_S || (QUICK ? 2 : 3));
const OUT = process.env.OUT || path.join(__dirname, "output_robust");
const PORT = 9000, CONFIG = path.join(OUT, "config.json");
const AG = { pep: process.env.AGENT_PEP, dir: process.env.AGENT_DIR, val3: process.env.AGENT_VAL3, val4: process.env.AGENT_VAL4 };

const MODES = {
  bczta: { mode: "bczta", env: { INVALIDATION: "events", TTL_S: "30" } },
  "bczta-q2": { mode: "bczta", env: { INVALIDATION: "events", TTL_S: "30", RPC_URLS, QUORUM: "2" } },
  push: { mode: "push", env: { TTL_S: "30", CENTRAL_URL: `http://${DIR_HOST}:9100` } },
};
/** Summary of a per-second series: granted fraction before / in windows of the loss / after the source returns. */
function summarize(series, cutS, backS, ttlS) {
  const sel = (a, b) => series.filter((s) => s.k >= a && s.k < b);
  const frac = (a) => { const n = a.reduce((x, s) => x + s.n, 0); return n ? a.reduce((x, s) => x + s.ok, 0) / n : null; };
  const win = (a, b) => frac(sel(cutS + a, Math.min(cutS + b, backS)));
  const firstBad = series.find((s) => s.k >= cutS && s.n && s.ok < 0.5 * s.n);
  let rec = null; for (let i = 0; i < series.length - 2 && rec === null; i++) { if (series[i].k >= backS && [0, 1, 2].every((o) => series[i + o].n && series[i + o].ok >= 0.9 * series[i + o].n)) rec = series[i].k - backS; }
  return { granted_before: frac(sel(0, cutS)), granted_cut_0_to_ttl: win(1, ttlS), granted_ttl_to_2ttl: win(ttlS, 2 * ttlS), granted_after_2ttl: win(2 * ttlS + 1, 1e9),
    granted_after_restore: frac(sel(RUN_S - 15, RUN_S)), seconds_until_denials: firstBad ? firstBad.k - cutS : null, seconds_to_recover: rec };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rpc = new Rpc(RPC_URL);
  const variants = ["push", "bczta-q2"];
  const ob = await onboard({ rpcUrl: RPC_URL, nLoad: Math.max(...COUNTS, 100), variants, nRev: REV_REPS });
  fs.writeFileSync(CONFIG, JSON.stringify(ob.config));
  await pushConfig(ob.config);
  const { config, devices, contracts, feeSend } = ob;
  const dev = (n) => devices.find((d) => d.name === n);
  const startProc = makeStarter(CONFIG);
  const pepAddrs = config.senderKeys.map((k) => new ethers.Wallet(k).address);
  const envFor = (m, extra = {}) => ({ MODE: MODES[m].mode, PORT: String(PORT), ...MODES[m].env, ...extra });
  const result = { meta: { date: new Date().toISOString(), rpc: RPC_URL, parts: PARTS, counts: COUNTS, duration_s: DURATION, ttl_s: TTL, rev_reps: REV_REPS, quick: QUICK, deployment: process.env.DEPLOYMENT || "single-host",
    netem_wan_ms: Number(process.env.NETEM_WAN_MS || 0), netem_validator_ms: Number(process.env.NETEM_VAL_MS || 0) } };
  const save = () => fs.writeFileSync(path.join(OUT, "robust_results.partial.json"), JSON.stringify(result));
  const centralEnv = { PORT: "9100", WAN_RTT_MS: String(process.env.NETEM_WAN_MS || 40) };
  const needCentral = PARTS.some((p) => ["p1", "p2", "p3"].includes(p));
  // the directory's responses are delayed by netem on the dir VM (cloud) or by WAN_RTT_MS (single host): use only one of them
  const central = needCentral ? await startProc("dir", "central.js", { PORT: "9100", WAN_RTT_MS: process.env.AGENT_DIR ? "0" : centralEnv.WAN_RTT_MS }, "central ready") : null;
  const centralPost = (p, body) => post(9100, p, body, 30000, DIR_HOST);

  // ---------------- P1 latency ----------------
  if (PARTS.includes("p1")) {
    result.P1 = {};
    for (const m of ["push", "bczta-q2", "bczta"]) {
      result.P1[m] = [];
      for (const N of COUNTS) {
        const pep = await startProc("pep", "pep.js", envFor(m), "pep ready");
        const t0 = now();
        const r = await runLoad({ port: PORT, devices: devices.slice(0, N), resource: config.resource, durationS: DURATION, warmupS: WARMUP });
        const st = await getStats(PORT), wall = (now() - t0) / 1000;
        r.pep = { cache_hit_ratio: st.cacheHit + st.cacheMiss ? st.cacheHit / (st.cacheHit + st.cacheMiss) : null, chain_reads: st.chainReads, quorum_mismatch: st.quorumMismatch || 0, cpu_cores_avg: (st.cpu.user + st.cpu.system) / 1e6 / wall, deny: st.deny };
        delete r.series; result.P1[m].push(r);
        console.log(`P1 ${m} N=${N}: mean ${r.mean_ms?.toFixed(1)} ms p95 ${r.p95_ms?.toFixed(1)} ms goodput ${r.goodput_rps.toFixed(1)}/s fail ${r.failed_or_timeout} denied ${r.denied}`);
        await pep.stop();
        if (m !== "push") await drain(rpc, pepAddrs);
      }
    }
    save();
  }

  // ---------------- P2 revocation delay ----------------
  if (PARTS.includes("p2")) {
    result.P2 = {};
    const revoke = { push: (d) => centralPost("/admin/revoke", { did: d.did }), "bczta-q2": async (d) => { await contracts.IR.revokeDID(d.did, feeSend); } };
    for (const v of variants) {
      const pep = await startProc("pep", "pep.js", envFor(v === "push" ? "push" : "bczta-q2", { TTL_S: String(TTL) }), "pep ready");
      const delays = [];
      for (let j = 0; j < REV_REPS; j++) {
        const d = dev(`rev-${v}-${j}`);
        const wait = (0.5 + Math.random() * 1.5) * 1000;
        let T0 = null, revokeDone = null, tDeny = null;
        const tStart = now(), inflight = [];
        for (let it = 0; it < 6000 && tDeny === null; it++) {
          if (T0 === null && now() - tStart >= wait) { T0 = now(); revokeDone = revoke[v](d); }
          inflight.push(makeReq(d, config.resource, Date.now()).then((rq) => post(PORT, "/access", rq, 60000)).then((r) => {
            if (T0 !== null && tDeny === null && r.out && !r.out.ok && r.out.reason === "revoked") tDeny = now();
          }));
          await sleep(25);
        }
        await Promise.allSettled(inflight); await revokeDone;
        if (tDeny) delays.push(tDeny - T0);
        await sleep(300);
      }
      result.P2[v] = { reps: REV_REPS, ...stats(delays), samples_ms: delays };
      console.log("P2", v, JSON.stringify({ n: delays.length, mean: result.P2[v].mean_ms, p95: result.P2[v].p95_ms, max: result.P2[v].max_ms }));
      await pep.stop(); if (v !== "push") await drain(rpc, pepAddrs);
    }
    save();
  }

  // ---------------- P3 loss of the state source (fail-closed bound) ----------------
  if (PARTS.includes("p3")) {
    result.P3 = {};
    const cases = [["bczta", "bczta", () => agentPost(AG.pep, "/svc", { name: "ledgercut", action: "stop", ip: LEDGER_IP }), () => agentPost(AG.pep, "/svc", { name: "ledgercut", action: "start", ip: LEDGER_IP })],
      ["push", "push", () => central.stop(), () => startProc("dir", "central.js", { PORT: "9100", WAN_RTT_MS: process.env.AGENT_DIR ? "0" : centralEnv.WAN_RTT_MS }, "central ready").then((c) => { Object.assign(central, c); })]];
    for (const [label, m, cut, restore] of cases) {
      if (label === "bczta" && !AG.pep) { console.warn("AGENT_PEP missing: skipping ledger cut"); continue; }
      const pep = await startProc("pep", "pep.js", envFor(m, { TTL_S: String(TTL), STALE_FACTOR: "2" }), "pep ready");
      const ev = { source: label === "bczta" ? "ledger node unreachable (iptables DROP)" : "directory stopped", cut_at_s: CUT_S, restore_at_s: BACK_S, ttl_s: TTL, stale_bound_s: 2 * TTL };
      let tw = null; const timers = [];
      const r = await runLoad({ port: PORT, devices: devices.slice(0, 50), resource: config.resource, durationS: RUN_S, warmupS: 0, timeoutMs: 15000,
        onStart: () => { tw = Date.now();
          timers.push(setTimeout(() => Promise.resolve(cut()).then(() => { ev.cut_done_s = (Date.now() - tw) / 1000; }).catch((e) => { ev.cut_error = String(e.message); }), CUT_S * 1000));
          timers.push(setTimeout(() => Promise.resolve(restore()).then(() => { ev.restore_done_s = (Date.now() - tw) / 1000; }).catch((e) => { ev.restore_error = String(e.message); }), BACK_S * 1000)); } });
      const st = await getStats(PORT).catch(() => null);
      await pep.stop();
      if (label === "bczta") await agentPost(AG.pep, "/svc", { name: "ledgercut", action: "start", ip: LEDGER_IP }).catch(() => {});   // idempotent safety net (ignore "rule not found")
      ev.summary = summarize(r.series, CUT_S, BACK_S, TTL);
      ev.pep = st ? { stale_served: st.staleServed, unavailable: st.unavailable, deny: st.deny } : null;
      result.P3[label] = { ...ev, ...r };
      console.log("P3", label, JSON.stringify(ev.summary), JSON.stringify(ev.pep), ev.cut_error || "", ev.restore_error || "");
      if (label === "bczta") await drain(rpc, pepAddrs);
    }
    save();
  }

  // ---------------- P5 horizontal scaling ----------------
  if (PARTS.includes("p5")) {
    result.P5 = {};
    for (const k of PEP_COUNTS) {
      result.P5[k] = [];
      for (const rate of PEP_RATES) {
        const N = Math.min(100, rate), rps = Math.round(rate / N);
        const procs = [], ports = [];
        for (let i = 0; i < k; i++) { const port = 9000 + i; ports.push(port); procs.push(await startProc("pep", "pep.js", envFor("bczta", { PORT: String(port), SENDER_N: String(k), SENDER_IDX: String(i) }), "pep ready", `pep-${i}`)); }
        const t0 = now();
        const r = await runLoad({ ports, devices: devices.slice(0, N), resource: config.resource, durationS: PF_DUR, warmupS: PF_WARM, timeoutMs: 10000, rps });
        const sts = await Promise.all(ports.map((p) => getStats(p).catch(() => null)));
        r.pep = { cpu_cores_total: sts.every(Boolean) ? sts.reduce((a, st) => a + (st.cpu.user + st.cpu.system) / 1e6, 0) / ((now() - t0) / 1000) : null };
        delete r.series; result.P5[k].push({ offered_rps: N * rps, ...r });
        console.log(`P5 k=${k} offered ${N * rps}/s: goodput ${r.goodput_rps.toFixed(0)}/s mean ${r.mean_ms?.toFixed(0)} p95 ${r.p95_ms?.toFixed(0)} ms fail ${r.failed_or_timeout} late ${r.late}`);
        for (const p of procs) await p.stop();
        await sleep(1500);
      }
      await drain(rpc, pepAddrs);
    }
    save();
  }

  // ---------------- P4 consensus halt (2 of 4 validators stopped) ----------------
  if (PARTS.includes("p4")) {
    if (!AG.val3 || !AG.val4) console.warn("AGENT_VAL3/AGENT_VAL4 missing: skipping P4");
    else {
      const pep = await startProc("pep", "pep.js", envFor("bczta", { TTL_S: String(TTL) }), "pep ready");
      const HALT_AT = CUT_S, HALT_S = QUICK ? 15 : 40, REVOKE_AT = HALT_AT + 5, DUR = HALT_AT + HALT_S + 30;
      const WAIT_MAX = Number(process.env.RECOVER_WAIT_S || 240);         // how long after the restart we keep waiting for consensus to resume
      const SECOND_RESTART_AFTER = 90;                                    // if no new block 90 s after the restart, restart the two validators once more
      const victim = dev("atk-revoked");
      const ev = { halt_at_s: HALT_AT, halt_s: HALT_S, revoke_submitted_at_s: REVOKE_AT };
      let tw = null, T0 = null, tDeny = null, tRestart = null, bnAtHalt = null, bnBeforeRestore = null, bnAfter = null;
      const probes = []; const timers = []; const blockSeries = [];
      const probeLoop = async () => {
        while (tw === null) await sleep(50);
        while (tDeny === null && Date.now() - tw < (HALT_AT + HALT_S + WAIT_MAX) * 1000) {
          const el = (Date.now() - tw) / 1000;
          if (T0 === null && el >= REVOKE_AT) { T0 = now(); contracts.IR.revokeDID(victim.did, feeSend).catch((e) => { ev.revoke_error = String(e.message); }); }
          probes.push(makeReq(victim, config.resource, Date.now()).then((rq) => post(PORT, "/access", rq, 60000)).then((r) => { if (T0 !== null && tDeny === null && r.out && !r.out.ok && r.out.reason === "revoked") tDeny = now(); }));
          await sleep(100);
        }
      };
      const probing = probeLoop();
      const bn = async () => parseInt(await rpc.one("eth_blockNumber"), 16);
      const r = await runLoad({ port: PORT, devices: devices.slice(0, 50), resource: config.resource, durationS: DUR, warmupS: 0, timeoutMs: 15000,
        onStart: () => { tw = Date.now();
          (async () => {   // block-height sampler (5 s): shows when consensus stops and when it resumes
            let secondDone = false;
            while (tDeny === null && Date.now() - tw < (HALT_AT + HALT_S + WAIT_MAX) * 1000) {
              const el = (Date.now() - tw) / 1000; let h = null;
              try { h = await bn(); } catch (e) { /* node unreachable */ }
              blockSeries.push({ t: Math.round(el * 10) / 10, block: h });
              if (tRestart !== null && !secondDone && bnBeforeRestore !== null && (Date.now() - tRestart) / 1000 > SECOND_RESTART_AFTER && h !== null && h <= bnBeforeRestore + 1) {
                secondDone = true; ev.second_restart_at_s = Math.round(el * 10) / 10;
                await Promise.all([agentPost(AG.val3, "/svc", { name: "besu", action: "stop" }), agentPost(AG.val4, "/svc", { name: "besu", action: "stop" })].map((q) => q.catch(() => {})));
                await Promise.all([agentPost(AG.val3, "/svc", { name: "besu", action: "start" }), agentPost(AG.val4, "/svc", { name: "besu", action: "start" })].map((q) => q.catch(() => {})));
              }
              await sleep(5000);
            }
          })();
          timers.push(setTimeout(async () => { try { bnAtHalt = await bn(); await Promise.all([agentPost(AG.val3, "/svc", { name: "besu", action: "stop" }), agentPost(AG.val4, "/svc", { name: "besu", action: "stop" })]); ev.halt_done_s = (Date.now() - tw) / 1000; } catch (e) { ev.halt_error = String(e.message); } }, HALT_AT * 1000));
          timers.push(setTimeout(async () => { try { bnBeforeRestore = await bn(); tRestart = now(); await Promise.all([agentPost(AG.val3, "/svc", { name: "besu", action: "start" }), agentPost(AG.val4, "/svc", { name: "besu", action: "start" })]); ev.restart_done_s = (Date.now() - tw) / 1000; } catch (e) { ev.restart_error = String(e.message); } }, (HALT_AT + HALT_S) * 1000)); } });
      await probing; await Promise.allSettled(probes);
      await Promise.all([agentPost(AG.val3, "/svc", { name: "besu", action: "start" }).catch(() => {}), agentPost(AG.val4, "/svc", { name: "besu", action: "start" }).catch(() => {})]);
      try { bnAfter = await bn(); } catch (e) { /* ignore */ }
      const S = r.series, frac = (a, b) => { const x = S.filter((s) => s.k >= a && s.k < b); const n = x.reduce((u, s) => u + s.n, 0); return n ? x.reduce((u, s) => u + s.ok, 0) / n : null; };
      ev.blocks = { at_halt: bnAtHalt, before_restore: bnBeforeRestore, after: bnAfter };
      ev.block_series = blockSeries;
      { const rs = tRestart !== null ? (tRestart - tw) / 1000 : null; const r0 = rs === null ? null : blockSeries.find((x) => x.t >= rs && x.block !== null && bnBeforeRestore !== null && x.block > bnBeforeRestore + 1); ev.chain_resumed_after_restart_s = r0 ? Math.round((r0.t - rs) * 10) / 10 : null; }
      ev.decisions_granted = { before_halt: frac(0, HALT_AT), during_halt: frac(HALT_AT + 2, HALT_AT + HALT_S), after: frac(HALT_AT + HALT_S + 10, DUR) };
      ev.revocation_enforced_after_submit_ms = tDeny && T0 ? tDeny - T0 : null;
      ev.revocation_enforced_after_restart_ms = tDeny && tRestart ? tDeny - tRestart : null;
      result.P4 = { ...ev, ...r };
      console.log("P4", JSON.stringify(ev));
      await pep.stop(); await sleep(3000); await drain(rpc, pepAddrs, 120000);
      save();
    }
  }

  fs.writeFileSync(path.join(OUT, "robust_results.json"), JSON.stringify(result, null, 2));
  try { fs.unlinkSync(path.join(OUT, "robust_results.partial.json")); } catch (e) { /* none */ }
  if (central) await central.stop().catch(() => {});
  console.log("wrote", OUT);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
