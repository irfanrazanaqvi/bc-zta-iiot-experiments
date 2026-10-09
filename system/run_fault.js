/**
 * E5: validator-failure test. 50 devices are served by the BC-ZTA PEP for DURATION_S seconds; the cloud script stops one of the
 * four validators FAULT_AT_S seconds after the line "FAULT_WINDOW_START" and restarts it later. During the fault a device is revoked
 * on-chain at REVOKE_AT_S and the time until the PEP denies it is measured. IBFT 2.0 with 4 validators tolerates f = 1.
 * Env as run_e2e.js plus DURATION_S (default 70), REVOKE_AT_S (default 25 s into the window), OUT.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { now, sleep, stats } = require("./lib");
const { onboard } = require("./onboard");
const { runLoad, makeReq, post, getStats } = require("./loadgen");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const OUT = process.env.OUT || path.join(__dirname, "output_fault");
const DURATION = Number(process.env.DURATION_S || 70), WARMUP = 5, REVOKE_AT = Number(process.env.REVOKE_AT_S || 25);
const AGENT_PEP = process.env.AGENT_PEP, PORT = 9000;
const CONFIG = path.join(OUT, "config.json");
const agentPost = (base, p, body) => new Promise((resolve, reject) => {
  const u = new URL(base + p);
  const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: 90000 }, (res) => {
    const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(Buffer.concat(c).toString()))));
  });
  rq.on("error", reject); rq.end(typeof body === "string" ? body : JSON.stringify(body));
});
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ob = await onboard({ rpcUrl: RPC_URL, nLoad: 50, variants: [], nRev: 0 });
  fs.writeFileSync(CONFIG, JSON.stringify(ob.config));
  const { config, devices, feeSend } = ob;
  let stopPep;
  const env = { MODE: "bczta", PORT: String(PORT), INVALIDATION: "events", TTL_S: "30" };
  if (AGENT_PEP) {
    await agentPost(AGENT_PEP, "/config", JSON.stringify(config));
    await agentPost(AGENT_PEP, "/start", { file: "pep.js", env, ready: "pep ready" });
    stopPep = () => agentPost(AGENT_PEP, "/stop", { file: "pep.js" });
  } else {
    const p = spawn("node", [path.join(__dirname, "pep.js")], { env: { ...process.env, CONFIG, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => p.stdout.on("data", (d) => String(d).includes("pep ready") && r()));
    stopPep = async () => p.kill("SIGTERM");
  }
  const victim = devices.find((d) => d.name === "atk-revoked");
  const result = { meta: { date: new Date().toISOString(), rpc: RPC_URL, deployment: process.env.DEPLOYMENT || "single-host", duration_s: DURATION, revoke_at_s: REVOKE_AT } };
  let tWindow = null, tDeny = null, T0 = null;
  const probes = [];
  const probeLoop = async () => {
    while (tWindow === null) await sleep(50);
    while (tDeny === null && now() - tWindow < (DURATION + WARMUP) * 1000) {
      if (T0 === null && now() - tWindow >= (WARMUP + REVOKE_AT) * 1000) { T0 = now(); ob.contracts.IR.revokeDID(victim.did, feeSend).catch((e) => console.error("revoke failed", e.message)); }
      probes.push(makeReq(victim, config.resource, Date.now()).then((rq) => post(PORT, "/access", rq, 60000)).then((r) => {
        if (T0 !== null && tDeny === null && r.out && !r.out.ok && r.out.reason === "revoked") tDeny = now();
      }));
      await sleep(100);
    }
  };
  const probing = probeLoop();
  const load = await runLoad({ port: PORT, devices: devices.slice(0, 50), resource: config.resource, durationS: DURATION, warmupS: WARMUP,
    onStart: () => { tWindow = now(); console.log("FAULT_WINDOW_START"); } });
  await probing; await Promise.allSettled(probes);
  const st = await getStats(PORT);
  result.load = load;
  result.revocation_during_fault_ms = tDeny && T0 ? tDeny - T0 : null;
  result.pep = { anchors_sent: st.anchorsSent, anchors_confirmed: st.anchorsConfirmed, anchored_events: st.anchorLeaves, chain_reads: st.chainReads, invalidations: st.invalidations };
  fs.writeFileSync(path.join(OUT, "fault_results.json"), JSON.stringify(result, null, 2));
  console.log("E5", JSON.stringify({ mean: load.mean_ms, p95: load.p95_ms, ok: load.ok, measured: load.measured, late: load.late, revocation_ms: result.revocation_during_fault_ms, anchors: result.pep }));
  await stopPep();
  console.log("FAULT_DONE");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
