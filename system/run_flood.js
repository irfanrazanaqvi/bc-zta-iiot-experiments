/**
 * Ledger-flood sweep (E4b). While 50 devices are served (1 request/s each), 16 spam accounts submit logEvent transactions to the validator
 * node the PEP is attached to at a fixed OFFERED rate (tx/s) for the whole measurement window. For each offered rate the script records
 *   - what the node accepted / rejected (with reasons) and what the chain actually committed (tx/s from block data, block fill),
 *   - the access latency, goodput and failures of the PEP in the given MODE (bczta = cached decisions, bcsync = synchronous on-chain logging).
 * Every account sends strictly in nonce order and re-sends the same signed transaction after a rejection, so no nonce gaps are created.
 * Env: MODE (bczta|bcsync), RATES, DURATION_S, WARMUP_S, RPC_URL, AGENT_PEP, PEP_HOST, OUT, QUICK=1, DEPLOYMENT, NETEM_VAL_MS
 */
const fs = require("fs");
const path = require("path");
const { h, now, sleep, IFACES, Rpc, ethers } = require("./lib");
const { onboard } = require("./onboard");
const { runLoad, getStats } = require("./loadgen");
const { makeStarter, pushConfig, drain, blockStats, blockNumber, txpoolCount } = require("./harness");

const QUICK = !!process.env.QUICK;
const MODE = process.env.MODE || "bczta";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const RATES = (process.env.RATES || (QUICK ? "0,40,120" : "0,100,200,400,800,1200")).split(",").map(Number);
const DURATION = Number(process.env.DURATION_S || (QUICK ? 6 : 20)), WARMUP = Number(process.env.WARMUP_S || (QUICK ? 2 : 5));
const NDEV = 50, PORT = 9000;
const OUT = process.env.OUT || path.join(__dirname, "output_flood");
const CONFIG = path.join(OUT, "config.json");

function classify(e) {
  const m = String(e.message || e);
  if (/already known|known transaction/i.test(m)) return "known";
  if (/nonce too low/i.test(m)) return "nonce_low";
  if (/ECONNRESET|socket hang up|ECONNREFUSED|ETIMEDOUT/i.test(m)) return "connection";
  return m.replace(/0x[0-9a-fA-F]+/g, "0x…").replace(/\d+/g, "#").slice(0, 60);
}

/** Offers `rate` tx/s over `seconds` from 16 accounts; returns when the window is over. */
async function flood({ rpc, wallets, startNonces, rate, seconds, cfg }) {
  const K = wallets.length, perSender = Math.ceil((rate * seconds) / K) + 50;      // an accepted tx is never re-signed, so this is an upper bound
  const fee = cfg.fee.type === 2 ? { type: 2, maxFeePerGas: BigInt(cfg.fee.maxFeePerGas), maxPriorityFeePerGas: BigInt(cfg.fee.maxPriorityFeePerGas) } : { type: 0, gasPrice: BigInt(cfg.fee.gasPrice) };
  const data = IFACES.AuditLog.encodeFunctionData("logEvent", [h("flood"), h("flood"), 9]);
  const raws = await Promise.all(wallets.map(async (w, k) => {
    const a = [];
    for (let j = 0; j < perSender; j++) a.push(await w.signTransaction({ to: cfg.addrs.AL, data, gasLimit: 300000, nonce: startNonces[k] + j, chainId: cfg.chainId, value: 0, ...fee }));
    return a;
  }));
  return {
    run: async (t0) => {     // t0: wall-clock start (ms)
      const res = { attempts: 0, accepted: 0, rejected: 0, reasons: {} };
      const interval = (K * 1000) / rate, deadline = t0 + seconds * 1000;
      await Promise.all(wallets.map(async (w, k) => {
        let idx = 0, due = t0 + (k * interval) / K;
        while (due < deadline) {
          const wait = due - Date.now(); if (wait > 1) await sleep(wait);
          due += interval;
          res.attempts++;
          try { await rpc.one("eth_sendRawTransaction", [raws[k][idx]]); idx++; res.accepted++; }
          catch (e) {
            const why = classify(e);
            if (why === "known" || why === "nonce_low") { idx++; res.accepted++; }
            else { res.rejected++; res.reasons[why] = (res.reasons[why] || 0) + 1; }
          }
          if (idx >= perSender) break;
        }
      }));
      return res;
    },
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rpc = new Rpc(RPC_URL);
  const ob = await onboard({ rpcUrl: RPC_URL, nLoad: NDEV, variants: [], nRev: 0 });
  fs.writeFileSync(CONFIG, JSON.stringify(ob.config));
  await pushConfig(ob.config);
  const { config, devices } = ob;
  const startProc = makeStarter(CONFIG);
  const wallets = ob.spamKeys.map((k) => new ethers.Wallet(k));
  const pepAddrs = config.senderKeys.map((k) => new ethers.Wallet(k).address);
  const result = { meta: { date: new Date().toISOString(), mode: MODE, rpc: RPC_URL, chainId: config.chainId, rates: RATES, duration_s: DURATION, warmup_s: WARMUP, devices: NDEV, spam_accounts: wallets.length,
    deployment: process.env.DEPLOYMENT || "single-host", netem_validator_ms: Number(process.env.NETEM_VAL_MS || 0), quick: QUICK }, rates: [] };
  const window = WARMUP + DURATION;

  for (const rate of RATES) {
    const startNonces = await Promise.all(wallets.map((w) => rpc.one("eth_getTransactionCount", [w.address, "latest"]).then((x) => parseInt(x, 16))));
    const pep = await startProc("pep", "pep.js", { MODE, PORT: String(PORT), INVALIDATION: "events", TTL_S: "30" }, "pep ready");
    const fl = rate > 0 ? await flood({ rpc, wallets, startNonces, rate, seconds: window + 2, cfg: config }) : null;
    const poolBefore = await txpoolCount(rpc);
    let fp = null, bn0 = null, t0Win = null;
    const load = await runLoad({ port: PORT, devices: devices.slice(0, NDEV), resource: config.resource, durationS: DURATION, warmupS: WARMUP, timeoutMs: 40000,
      onStart: () => { t0Win = Date.now(); blockNumber(rpc).then((b) => { bn0 = b; }); if (fl) fp = fl.run(t0Win); } });
    const fres = fp ? await fp : { attempts: 0, accepted: 0, rejected: 0, reasons: {} };
    const bn1 = await blockNumber(rpc);
    const poolEnd = await txpoolCount(rpc);
    const st = await getStats(PORT);
    await pep.stop();
    // ledger throughput during the window (all transactions in the blocks, spam + audit)
    const blocks = bn0 != null ? await blockStats(rpc, bn0, bn1) : null;
    const drainS = await drain(rpc, [...pepAddrs, ...wallets.map((w) => w.address)]);
    const committed = (await Promise.all(wallets.map((w, k) => rpc.one("eth_getTransactionCount", [w.address, "latest"]).then((x) => parseInt(x, 16) - startNonces[k])))).reduce((a, b) => a + b, 0);
    const entry = { offered_tps: rate, flood: { ...fres, accepted_tps: fres.accepted / window, committed_total: committed, evicted_after_accept: Math.max(0, fres.accepted - committed) },
      ledger: blocks, txpool_before: poolBefore, txpool_end_of_window: poolEnd, drain_s: drainS,
      pep: { tx_sent: st.txSent, tx_confirmed: st.txConfirmed, anchors_sent: st.anchorsSent, anchors_confirmed: st.anchorsConfirmed, deny: st.deny }, load };
    result.rates.push(entry);
    console.log(`FLOOD ${MODE} offered ${rate}/s: accepted ${fres.accepted}/${fres.attempts} (rej ${fres.rejected} ${JSON.stringify(fres.reasons)}) committed ${blocks?.tps?.toFixed(1)} tx/s (${blocks?.tx_per_block?.toFixed(0)}/block) | PEP mean ${load.mean_ms?.toFixed(1)} p95 ${load.p95_ms?.toFixed(1)} ok ${load.ok}/${load.measured} fail ${load.failed_or_timeout} | drain ${drainS.toFixed(0)}s`);
    fs.writeFileSync(path.join(OUT, "flood_results.partial.json"), JSON.stringify(result));
  }
  fs.writeFileSync(path.join(OUT, "flood_results.json"), JSON.stringify(result, null, 2));
  fs.unlinkSync(path.join(OUT, "flood_results.partial.json"));
  console.log("wrote", OUT);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
