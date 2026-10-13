// Small helpers shared by the extended experiments (run_flood.js, run_iam.js): start/stop processes locally or through the control agents,
// ledger drain, block statistics and transaction-pool statistics.
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { now, sleep, ethers } = require("./lib");

function agentPost(base, p, body, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout }, (res) => {
      const c = []; res.on("data", (d) => c.push(d));
      res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error("agent " + p + " " + res.statusCode + ": " + Buffer.concat(c).toString()))));
    });
    rq.on("timeout", () => rq.destroy(new Error("agent timeout " + p)));
    rq.on("error", reject); rq.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
function spawnProc(file, env, ready, config) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(__dirname, file)], { env: { ...process.env, CONFIG: config, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let done = false;
    p.stdout.on("data", (d) => { if (!done && String(d).includes(ready)) { done = true; resolve(p); } });
    p.on("exit", (c) => { if (!done) reject(new Error(file + " exited " + c)); });
    setTimeout(() => { if (!done) reject(new Error(file + " start timeout")); }, 60000);
  });
}
const stopLocal = (p) => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 3000); });
/** Returns startProc(where, file, env, readyText) -> {stop()}; `where` = "pep" | "dir" selects the agent when AGENT_PEP / AGENT_DIR are set. */
function makeStarter(config) {
  const AGENT = { pep: process.env.AGENT_PEP, dir: process.env.AGENT_DIR };
  return async function startProc(where, file, env, ready) {
    if (!AGENT[where]) { const p = await spawnProc(file, env, ready, config); return { stop: () => stopLocal(p) }; }
    await agentPost(AGENT[where], "/start", { file, env, ready });
    return { stop: () => agentPost(AGENT[where], "/stop", { file }) };
  };
}
async function pushConfig(cfg) { for (const w of ["pep", "dir"]) if (process.env["AGENT_" + w.toUpperCase()]) await agentPost(process.env["AGENT_" + w.toUpperCase()], "/config", JSON.stringify(cfg)); }

async function txpoolCount(rpc) {
  try { const s = await rpc.one("txpool_besuStatistics"); return { max: s.maxSize, local: s.localCount, remote: s.remoteCount, total: (s.localCount || 0) + (s.remoteCount || 0) }; }
  catch (e) { return null; }
}
/** Waits until every listed account has no pending (not yet mined) transactions and the pool is empty; returns the waiting time in seconds. */
async function drain(rpc, addrs, maxMs = 300000) {
  const t0 = now();
  for (;;) {
    try {
      const rs = await Promise.all(addrs.flatMap((a) => [rpc.one("eth_getTransactionCount", [a, "latest"]), rpc.one("eth_getTransactionCount", [a, "pending"])]));
      let same = true; for (let i = 0; i < rs.length; i += 2) if (rs[i] !== rs[i + 1]) same = false;
      const tp = await txpoolCount(rpc);
      if (same && (!tp || tp.total === 0)) return (now() - t0) / 1000;
    } catch (e) { /* retry */ }
    if (now() - t0 > maxMs) return -(now() - t0) / 1000;      // negative = timed out
    await sleep(1000);
  }
}
/** Transactions and gas of blocks (from, to], and the time span between the two end blocks (block timestamps). */
async function blockStats(rpc, from, to) {
  let txs = 0, gas = 0, n = 0;
  const get = (b) => rpc.one("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
  const b0 = await get(from);
  let last = b0;
  for (let b = from + 1; b <= to; b++) { const blk = await get(b); txs += blk.transactions.length; gas += parseInt(blk.gasUsed, 16); n++; last = blk; }
  const span = parseInt(last.timestamp, 16) - parseInt(b0.timestamp, 16);
  return { blocks: n, span_s: span, txs, tps: span > 0 ? txs / span : null, tx_per_block: n ? txs / n : null, gas_per_s: span > 0 ? gas / span : null };
}
const blockNumber = async (rpc) => parseInt(await rpc.one("eth_blockNumber"), 16);
module.exports = { agentPost, makeStarter, pushConfig, drain, blockStats, blockNumber, txpoolCount };
