/**
 * Live-network benchmark for the BC-ZTA contracts (ethers v6). Works against Hyperledger Besu (IBFT 2.0)
 * or any EVM JSON-RPC node (e.g. `npx hardhat node`, useful only to test the script itself).
 *
 * Measures, with real transactions:
 *  S1  write confirmation latency (send -> block observed), sequential          [AuditLog.logEvent, anchorBatch]
 *  S2  read latency of on-chain policy evaluation (eth_call)                    [AccessControl.evaluateRequest]
 *  S3  committed throughput + latency vs offered rate, per-event logging        [AuditLog.logEvent]
 *  S4  batched anchoring: one anchorBatch per second regardless of event rate   [AuditLog.anchorBatch]
 *  S5  revocation visibility delay: revokeDID sent -> isActive()==false         [IdentityRegistry]
 *
 * Usage:
 *   USE_SOLCJS=1 npx hardhat compile            # produces ./artifacts
 *   RPC_URL=http://127.0.0.1:8545 node benchmark/run_benchmark.js [--quick]
 * Env: RPC_URL, DEPLOYER_KEY (funded; default = Hardhat/genesis account #0), RATES="10,25,50,100,200",
 *      DURATION_S=20, WORKERS=8, SEQ_N=50, READ_N=500, REVOKE_N=10, OUT=benchmark/output
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const QUICK = process.argv.includes("--quick");
const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RATES = (process.env.RATES || (QUICK ? "10,25" : "10,25,50,100,200")).split(",").map(Number);
const DURATION = Number(process.env.DURATION_S || (QUICK ? 4 : 20));
const WORKERS = Number(process.env.WORKERS || 8);
const SEQ_N = Number(process.env.SEQ_N || (QUICK ? 10 : 50));
const READ_N = Number(process.env.READ_N || (QUICK ? 50 : 500));
const REVOKE_N = Number(process.env.REVOKE_N || (QUICK ? 3 : 10));
const OUT = process.env.OUT || path.join(__dirname, "output");

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const stats = (a) => {
  if (!a.length) return { n: 0, mean_ms: null, p50_ms: null, p95_ms: null, max_ms: null };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: a.length, mean_ms: a.reduce((x, y) => x + y, 0) / a.length, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: s[s.length - 1] };
};
function artifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. Run: USE_SOLCJS=1 npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p));
}

/** Observes new blocks (polling) and resolves pending tx hashes at the moment their block is first seen. */
class BlockWatcher {
  constructor(provider, pollMs = 25) { this.p = provider; this.pollMs = pollMs; this.waiters = new Map(); this.last = null; this.run = false; }
  async start() { this.last = await this.p.getBlockNumber(); this.run = true; this.loop(); }
  stop() { this.run = false; }
  watch(hash) { return new Promise((res) => this.waiters.set(hash, res)); }
  async loop() {
    while (this.run) {
      try {
        const bn = await this.p.getBlockNumber();
        for (let n = this.last + 1; n <= bn; n++) {
          const blk = await this.p.getBlock(n);
          const t = now();
          for (const hash of blk.transactions) { const w = this.waiters.get(hash); if (w) { this.waiters.delete(hash); w({ t, block: n }); } }
        }
        this.last = bn;
      } catch (e) { /* transient RPC error: retry */ }
      await sleep(this.pollMs);
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
  const dAddr = await deployer.getAddress();
  console.log(`RPC ${RPC} chainId ${net.chainId}; deployer ${dAddr}`);
  const fee = await provider.getFeeData();
  const feeOpts = fee.maxFeePerGas != null ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n } : { gasPrice: fee.gasPrice };
  const watcher = new BlockWatcher(provider);

  // ---- deploy contracts ------------------------------------------------------------------------------
  const dep = async (name, ...args) => {
    const a = artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args, feeOpts);
    await c.waitForDeployment();
    return c;
  };
  const IR = await dep("IdentityRegistry", dAddr);
  const TR = await dep("TrustReputation", [dAddr], 1);
  const AC = await dep("AccessControl", await IR.getAddress(), await TR.getAddress());
  const AL = await dep("AuditLog");
  console.log("deployed:", await IR.getAddress(), await TR.getAddress(), await AC.getAddress(), await AL.getAddress());
  await watcher.start();

  // ---- worker wallets (deterministic), funded once ----------------------------------------------------
  const workers = Array.from({ length: WORKERS }, (_, i) => new ethers.Wallet(h(`bc-zta-worker-${i}`), provider));
  for (const w of workers) { const tx = await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("10"), ...feeOpts }); await tx.wait(); }
  const nonces = await Promise.all(workers.map((w) => provider.getTransactionCount(w.address, "pending")));
  const alIface = AL.interface, alAddr = await AL.getAddress();

  const DID = h("did:iiot:bench-device"), RES = h("resource:bench");
  await (await IR.registerDID(DID, h("pk"), 0, feeOpts)).wait();
  await (await AC.setPolicy(RES, 0, 1, 50, 300, feeOpts)).wait();

  const result = { meta: { rpc: RPC, chainId: Number(net.chainId), quick: QUICK, date: new Date().toISOString(), workers: WORKERS, duration_s: DURATION } };

  // ---- S1: sequential write confirmation latency ---------------------------------------------------------
  const seq = async (label, build) => {
    const lat = [];
    for (let i = 0; i < SEQ_N; i++) {
      const t0 = now();
      const tx = await deployer.sendTransaction({ ...(await build(i)), ...feeOpts });
      const p = watcher.watch(tx.hash);
      const { t } = await p;
      lat.push(t - t0);
    }
    return stats(lat);
  };
  result.S1_write_confirmation = {
    "AuditLog.logEvent": await seq("logEvent", async (i) => ({ to: alAddr, data: alIface.encodeFunctionData("logEvent", [DID, RES, 1]), gasLimit: 300000 })),
    "AuditLog.anchorBatch": await seq("anchor", async (i) => ({ to: alAddr, data: alIface.encodeFunctionData("anchorBatch", [h("root" + i), 1000]), gasLimit: 250000 })),
  };
  console.log("S1", JSON.stringify(result.S1_write_confirmation));

  // ---- S2: on-chain read latency -------------------------------------------------------------------------
  const rd = [];
  for (let i = 0; i < READ_N; i++) { const t0 = now(); await AC.evaluateRequest(DID, RES, 0); rd.push(now() - t0); }
  result.S2_read_latency = { "AccessControl.evaluateRequest (eth_call)": stats(rd) };
  console.log("S2", JSON.stringify(result.S2_read_latency));

  // ---- S3 / S4: offered-rate sweeps ------------------------------------------------------------------------
  // Wait until every worker has no pending transactions, then re-sync nonces from the chain.
  async function drain(maxMs = 90000) {
    const t0 = now();
    for (;;) {
      const [latest, pending] = await Promise.all([
        Promise.all(workers.map((w) => provider.getTransactionCount(w.address, "latest"))),
        Promise.all(workers.map((w) => provider.getTransactionCount(w.address, "pending"))),
      ]);
      if (latest.every((n, i) => n === pending[i]) || now() - t0 > maxMs) { latest.forEach((n, i) => (nonces[i] = n)); return; }
      await sleep(500);
    }
  }
  // Transactions are pre-signed before the timed loop so the single-threaded Node client is not the bottleneck;
  // each worker then broadcasts its share (sequential per worker, bounded concurrency = WORKERS) at the offered rate.
  async function sweep(rate, makeTx) {
    await drain();
    const total = rate * DURATION, sent = [], lat = [], errors = {};
    const txType = feeOpts.gasPrice != null ? 0 : 2;
    const raws = new Array(total);
    const counters = nonces.slice();
    for (let i = 0; i < total; i++) {
      const wi = i % WORKERS;
      raws[i] = await workers[wi].signTransaction({ ...makeTx(i), nonce: counters[wi]++, chainId: net.chainId, type: txType, ...feeOpts });
    }
    let failed = 0;
    const pending = [];
    const t0 = now();
    const runWorker = async (wi) => {
      for (let i = wi; i < total; i += WORKERS) {
        const wait = t0 + (i * 1000) / rate - now();
        if (wait > 0) await sleep(wait);
        const sendT = now();
        try {
          const hash = await provider.send("eth_sendRawTransaction", [raws[i]]);
          pending.push(watcher.watch(hash).then(({ t }) => { lat.push(t - sendT); sent.push(t); }));
        } catch (e) {
          failed++;
          const m = String(e.shortMessage || e.message || e).slice(0, 80);
          errors[m] = (errors[m] || 0) + 1;
        }
      }
    };
    await Promise.all(workers.map((_, wi) => runWorker(wi)));
    await Promise.race([Promise.allSettled(pending), sleep(60000)]);
    const span = sent.length ? (Math.max(...sent) - t0) / 1000 : null;
    return { offered_tps: rate, duration_s: DURATION, submitted: total, confirmed: sent.length, failed, errors,
             committed_tps: span ? sent.length / span : 0, ...stats(lat) };
  }
  result.S3_per_event_logging = [];
  for (const r of RATES) {
    const row = await sweep(r, (i) => ({ to: alAddr, data: alIface.encodeFunctionData("logEvent", [DID, RES, 1]), gasLimit: 300000 }));
    result.S3_per_event_logging.push(row);
    console.log("S3", JSON.stringify(row));
    await drain();
  }
  // S4: whatever the event rate, anchor one batch per second
  await drain();
  const row4 = await sweep(1, (i) => ({ to: alAddr, data: alIface.encodeFunctionData("anchorBatch", [h("batch" + i), 1000]), gasLimit: 250000 }));
  result.S4_batch_anchoring = { note: "1 anchorBatch tx/s covers up to the offered event rate of S3 (batch size = events/s)", ...row4 };
  console.log("S4", JSON.stringify(row4));

  // ---- S5: revocation visibility ---------------------------------------------------------------------------
  const rv = [];
  for (let i = 0; i < REVOKE_N; i++) {
    const did = h("did:iiot:revoke-" + Date.now() + "-" + i);
    await (await IR.registerDID(did, h("pk" + i), 0, feeOpts)).wait();
    if (!(await IR.isActive(did))) throw new Error("expected active");
    const t0 = now();
    const tx = await IR.revokeDID(did, feeOpts);
    // poll a read-only client, as a gateway without event subscription would
    while (await IR.isActive(did)) await sleep(20);
    rv.push(now() - t0);
    await tx.wait();
  }
  result.S5_revocation_visibility = stats(rv);
  console.log("S5", JSON.stringify(result.S5_revocation_visibility));

  watcher.stop();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, QUICK ? "measured_results_QUICK_TEST.json" : "measured_results.json"), JSON.stringify(result, null, 2));
  const csv = ["offered_tps,committed_tps,mean_ms,p95_ms,confirmed,failed"]
    .concat(result.S3_per_event_logging.map((r) => [r.offered_tps, r.committed_tps.toFixed(1), r.mean_ms?.toFixed(1), r.p95_ms?.toFixed(1), r.confirmed, r.failed].join(",")));
  fs.writeFileSync(path.join(OUT, QUICK ? "s3_QUICK_TEST.csv" : "s3_throughput.csv"), csv.join("\n") + "\n");
  console.log(`wrote ${OUT}`);
  provider.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
