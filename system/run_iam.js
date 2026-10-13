/**
 * Comparison against REAL central identity services (extended evaluation).
 *   keycloak(-cached): Keycloak OIDC IdP, PEP introspects the device's access token (RFC 7662) on every request (or caches the answer for IAM_TTL_S).
 *   ldap(-cached)    : OpenLDAP, PEP runs one LDAP search per request (or caches for IAM_TTL_S).
 *   bczta            : the proposed architecture, measured in the same run as reference.
 *  X1  access latency / goodput vs number of devices          (PART e1)
 *  X2  revocation enforcement delay                           (PART e2)
 *  X3  availability while the central service is stopped and restarted (PART e6)
 *  X4  PEP capacity: offered request rate sweep with 100 devices (PART e7)
 * Env: RPC_URL, KC_URL, LDAP_URL, AGENT_PEP, AGENT_DIR (needed for X3: stops/starts Keycloak / slapd on the directory VM), PEP_HOST,
 *      COUNTS, DURATION_S, WARMUP_S, REV_REPS, IAM_TTL_S, PARTS=e1,e2,e6,e7, OUT, QUICK=1
 */
const fs = require("fs");
const path = require("path");
const { h, now, sleep, stats, Rpc, ethers } = require("./lib");
const { onboard } = require("./onboard");
const { runLoad, makeReq, post, getStats } = require("./loadgen");
const { makeStarter, pushConfig, drain, agentPost } = require("./harness");
const { Keycloak, introspect } = require("./iam/kc");
const { Ldap } = require("./iam/ldap");

const QUICK = !!process.env.QUICK;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const KC_URL = process.env.KC_URL || "http://127.0.0.1:8080", LDAP_URL = process.env.LDAP_URL || "ldap://127.0.0.1:389";
const COUNTS = (process.env.COUNTS || (QUICK ? "10,25" : "25,100,200")).split(",").map(Number);
const DURATION = Number(process.env.DURATION_S || (QUICK ? 5 : 20)), WARMUP = Number(process.env.WARMUP_S || (QUICK ? 2 : 5));
const REV_REPS = Number(process.env.REV_REPS || (QUICK ? 3 : 8));
const TTL = Number(process.env.IAM_TTL_S || (QUICK ? 4 : 10));
const PARTS = (process.env.PARTS || "e1,e2,e6,e7").split(",");
const OUT_DUR = Number(process.env.OUTAGE_DURATION_S || (QUICK ? 70 : 100)), OUT_STOP = Number(process.env.OUTAGE_STOP_S || (QUICK ? 10 : 20)), OUT_START = Number(process.env.OUTAGE_START_S || (QUICK ? 25 : 45));
const PF_RATES = (process.env.PEP_RATES || (QUICK ? "50,100" : "200,400,800,1600")).split(",").map(Number);
const PF_DUR = Number(process.env.PEP_DURATION_S || (QUICK ? 4 : 12)), PF_WARM = Number(process.env.PEP_WARMUP_S || (QUICK ? 2 : 3));
const OUT = process.env.OUT || path.join(__dirname, "output_iam");
const PORT = 9000, CONFIG = path.join(OUT, "config.json");
const IAM_ENV = { KC_URL, LDAP_URL };
const MODES = [["keycloak", "keycloak", { IAM_TTL_S: "0" }], ["keycloak-cached", "keycloak", { IAM_TTL_S: String(TTL) }], ["ldap", "ldap", { IAM_TTL_S: "0" }], ["ldap-cached", "ldap", { IAM_TTL_S: String(TTL) }],
  ["bczta", "bczta", { INVALIDATION: "events", TTL_S: "30" }]];
const svcOf = (label) => (label.startsWith("ldap") ? "ldap" : "kc");        // bczta: the Keycloak stop is a control (bczta does not depend on it)

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rpc = new Rpc(RPC_URL);
  const variants = ["keycloak", "keycloak-cached", "ldap", "ldap-cached", "bczta-events"];
  const nLoad = Math.max(...COUNTS, 100);
  const ob = await onboard({ rpcUrl: RPC_URL, nLoad, variants, nRev: REV_REPS });
  fs.writeFileSync(CONFIG, JSON.stringify(ob.config));
  await pushConfig(ob.config);
  const { config, devices, contracts, feeSend } = ob;
  const dev = (name) => devices.find((d) => d.name === name);
  const startProc = makeStarter(CONFIG);
  const pepAddrs = config.senderKeys.map((k) => new ethers.Wallet(k).address);
  const trustOf = (d) => (d.name === "atk-lowtrust" ? 20 : 70);

  // ---- central services: Keycloak realm + tokens, LDAP entries ----
  const kc = new Keycloak(KC_URL), ldap = new Ldap(LDAP_URL, { poolSize: 4 });
  const t0s = now();
  await kc.setupRealm(devices, { trustOf }); kc.keepAlive();
  await kc.issueTokens(devices);
  await ldap.setup(devices, { trustOf });
  console.log(`IAM ready: ${devices.length} Keycloak users with tokens, ${devices.length} LDAP entries (${((now() - t0s) / 1000).toFixed(0)} s)`);
  const waitKc = async (maxMs = 240000) => { const t = now(); for (;;) { try { const j = await introspect(KC_URL, devices[0].token, 3000); if (j.active) return { ok: true, s: (now() - t) / 1000 }; return { ok: false, s: (now() - t) / 1000 }; } catch (e) { if (now() - t > maxMs) throw new Error("keycloak did not come back"); await sleep(1000); } } };
  const waitLdap = async () => { const t = now(); await ldap.waitReady(180000); return { ok: true, s: (now() - t) / 1000 }; };
  const waitSvc = (svc) => (svc === "kc" ? waitKc() : waitLdap());

  const result = { meta: { date: new Date().toISOString(), rpc: RPC_URL, chainId: config.chainId, counts: COUNTS, duration_s: DURATION, warmup_s: WARMUP, ttl_s: TTL, parts: PARTS, rev_reps: REV_REPS,
    deployment: process.env.DEPLOYMENT || "single-host", netem_wan_ms: Number(process.env.NETEM_WAN_MS || 0), netem_validator_ms: Number(process.env.NETEM_VAL_MS || 0), keycloak: "26.4.0", openldap: "slapd (Debian)", quick: QUICK } };
  const save = () => fs.writeFileSync(path.join(OUT, "iam_results.partial.json"), JSON.stringify(result));
  const envFor = (mode, env) => ({ MODE: mode, PORT: String(PORT), ...IAM_ENV, ...env });

  // ---------------- X1: latency / goodput ----------------
  if (PARTS.includes("e1")) {
    result.E1 = {};
    for (const [label, mode, env] of MODES) {
      result.E1[label] = [];
      for (const N of COUNTS) {
        const pep = await startProc("pep", "pep.js", envFor(mode, env), "pep ready");
        const t0 = now();
        const r = await runLoad({ port: PORT, devices: devices.slice(0, N), resource: config.resource, durationS: DURATION, warmupS: WARMUP });
        const st = await getStats(PORT), wall = (now() - t0) / 1000;
        r.pep = { iam_lookups: st.iamLookups, cache_hit_ratio: st.cacheHit + st.cacheMiss ? st.cacheHit / (st.cacheHit + st.cacheMiss) : null, chain_reads: st.chainReads, cpu_cores_avg: (st.cpu.user + st.cpu.system) / 1e6 / wall, deny: st.deny };
        result.E1[label].push(r);
        console.log(`X1 ${label} N=${N}: mean ${r.mean_ms?.toFixed(1)} ms p95 ${r.p95_ms?.toFixed(1)} ms goodput ${r.goodput_rps.toFixed(1)}/s fail ${r.failed_or_timeout} denied ${r.denied} pepcpu ${r.pep.cpu_cores_avg.toFixed(2)}`);
        await pep.stop();
        if (mode === "bczta") await drain(rpc, pepAddrs);
      }
    }
    save();
  }

  // ---------------- X2: revocation enforcement delay ----------------
  if (PARTS.includes("e2")) {
    const revoke = { kc: (d) => kc.revoke(d.did), ldap: (d) => ldap.revoke(d.did), chain: async (d) => { await contracts.IR.revokeDID(d.did, feeSend); } };
    result.E2 = {};
    for (const [variant, mode, env, how] of [["keycloak", "keycloak", { IAM_TTL_S: "0" }, "kc"], ["keycloak-cached", "keycloak", { IAM_TTL_S: String(TTL) }, "kc"],
        ["ldap", "ldap", { IAM_TTL_S: "0" }, "ldap"], ["ldap-cached", "ldap", { IAM_TTL_S: String(TTL) }, "ldap"], ["bczta-events", "bczta", { INVALIDATION: "events", TTL_S: String(TTL) }, "chain"]]) {
      const pep = await startProc("pep", "pep.js", envFor(mode, env), "pep ready");
      const delays = [];
      for (let j = 0; j < REV_REPS; j++) {
        const d = dev(`rev-${variant}-${j}`);
        const wait = (variant.endsWith("cached") ? Math.random() * TTL : 0.5 + Math.random() * 1.5) * 1000;
        let T0 = null, revokeDone = null, tDeny = null;
        const tStart = now(), inflight = [];
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
      result.E2[variant] = { ttl_s: variant.endsWith("cached") || variant === "bczta-events" ? TTL : null, reps: REV_REPS, ...stats(delays), samples_ms: delays };
      console.log("X2", variant, JSON.stringify({ n: delays.length, mean: result.E2[variant].mean_ms, p95: result.E2[variant].p95_ms, max: result.E2[variant].max_ms }));
      await pep.stop();
      if (mode === "bczta") await drain(rpc, pepAddrs);
    }
    save();
  }

  // ---------------- X3: central service outage ----------------
  if (PARTS.includes("e6")) {
    if (!process.env.AGENT_DIR) console.warn("AGENT_DIR not set: the outage test needs the control agent on the directory VM");
    result.E6 = {};
    for (const [label, mode, env] of MODES) {
      const svc = svcOf(label);
      const pep = await startProc("pep", "pep.js", envFor(mode, env), "pep ready");
      const ev = { svc, stop_at_s: OUT_STOP, start_at_s: OUT_START, stop_done_s: null, start_done_s: null };
      let tw = null;
      const timers = [];
      const r = await runLoad({ port: PORT, devices: devices.slice(0, 50), resource: config.resource, durationS: OUT_DUR, warmupS: 0, timeoutMs: 15000,
        onStart: () => {
          tw = Date.now();
          timers.push(setTimeout(() => agentPost(process.env.AGENT_DIR, "/svc", { name: svc, action: "stop" }).then(() => { ev.stop_done_s = (Date.now() - tw) / 1000; }).catch((e) => { ev.stop_error = String(e.message); }), OUT_STOP * 1000));
          timers.push(setTimeout(() => agentPost(process.env.AGENT_DIR, "/svc", { name: svc, action: "start" }).then(() => { ev.start_done_s = (Date.now() - tw) / 1000; }).catch((e) => { ev.start_error = String(e.message); }), OUT_START * 1000));
        } });
      await pep.stop();
      // make sure the service is back (also if the timers failed) and that existing tokens are still valid
      await agentPost(process.env.AGENT_DIR, "/svc", { name: svc, action: "start" }).catch(() => {});
      const back = await waitSvc(svc);
      if (svc === "kc" && !back.ok) { await kc.issueTokens(devices); ev.tokens_reissued = true; }
      // summary
      const S = r.series, sum = (a, f) => a.reduce((x, b) => x + f(b), 0);
      const during = S.filter((b) => b.k >= OUT_STOP + 1 && b.k < OUT_START), before = S.filter((b) => b.k < OUT_STOP), after = S.filter((b) => b.k >= OUT_DUR - 15);
      const frac = (a) => (sum(a, (b) => b.n) ? sum(a, (b) => b.ok) / sum(a, (b) => b.n) : null);
      const firstBad = S.find((b) => b.k >= OUT_STOP && b.n && b.ok < 0.5 * b.n);
      let rec = null; for (let i = 0; i < S.length - 2 && rec === null; i++) { if (S[i].k >= OUT_START && [0, 1, 2].every((o) => S[i + o].n && S[i + o].ok >= 0.9 * S[i + o].n)) rec = S[i].k - OUT_START; }
      ev.summary = { ok_fraction_before: frac(before), ok_fraction_during_outage: frac(during), ok_fraction_late_after: frac(after), seconds_until_service_loss: firstBad ? firstBad.k - OUT_STOP : null, seconds_to_recover_after_start: rec, service_ready_after_start_s: back.s };
      result.E6[label] = { ...ev, ...r };
      console.log("X3", label, JSON.stringify(ev.summary), ev.stop_error || "", ev.start_error || "");
      if (mode === "bczta") await drain(rpc, pepAddrs);
    }
    save();
  }

  // ---------------- X4: PEP capacity under a request flood ----------------
  if (PARTS.includes("e7")) {
    result.E7 = {};
    for (const [label, mode, env] of [MODES[0], MODES[2], MODES[4]]) {
      result.E7[label] = [];
      for (const rate of PF_RATES) {
        const N = Math.min(100, rate), rps = Math.round(rate / N);
        const pep = await startProc("pep", "pep.js", envFor(mode, env), "pep ready");
        const t0 = now();
        const r = await runLoad({ port: PORT, devices: devices.slice(0, N), resource: config.resource, durationS: PF_DUR, warmupS: PF_WARM, timeoutMs: 10000, rps });
        const st = await getStats(PORT).catch(() => null);
        r.pep = st ? { cpu_cores_avg: (st.cpu.user + st.cpu.system) / 1e6 / ((now() - t0) / 1000), iam_lookups: st.iamLookups } : null;
        delete r.series;
        result.E7[label].push({ offered_rps: N * rps, ...r });
        console.log(`X4 ${label} offered ${N * rps}/s: goodput ${r.goodput_rps.toFixed(0)}/s mean ${r.mean_ms?.toFixed(0)} p95 ${r.p95_ms?.toFixed(0)} ms fail ${r.failed_or_timeout} late ${r.late}`);
        await pep.stop();
        await sleep(1500);
      }
      if (mode === "bczta") await drain(rpc, pepAddrs);
    }
    save();
  }

  fs.writeFileSync(path.join(OUT, "iam_results.json"), JSON.stringify(result, null, 2));
  try { fs.unlinkSync(path.join(OUT, "iam_results.partial.json")); } catch (e) { /* none */ }
  console.log("wrote", OUT);
  await ldap.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
