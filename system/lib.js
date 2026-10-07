// Shared helpers for the BC-ZTA end-to-end prototype: JSON-RPC client, Merkle tree, ABIs, block watcher.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function artifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}; run: npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p));
}
const IFACES = {};
for (const n of ["IdentityRegistry", "TrustReputation", "AccessControl", "AuditLog"]) IFACES[n] = new ethers.Interface(artifact(n).abi);

/** Minimal keep-alive JSON-RPC client with batching (one HTTP request per call()). */
class Rpc {
  constructor(url) {
    const u = new URL(url);
    this.opts = { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" },
                  agent: new http.Agent({ keepAlive: true, maxSockets: 256 }) };
    this.id = 1;
  }
  call(reqs) {
    const body = JSON.stringify(reqs.map(([m, p]) => ({ jsonrpc: "2.0", id: this.id++, method: m, params: p || [] })));
    const ids = JSON.parse(body).map((x) => x.id);
    return new Promise((resolve, reject) => {
      const rq = http.request(this.opts, (res) => {
        const ch = [];
        res.on("data", (c) => ch.push(c));
        res.on("end", () => {
          try {
            let j = JSON.parse(Buffer.concat(ch).toString());
            if (!Array.isArray(j)) j = [j];
            const byId = new Map(j.map((x) => [x.id, x]));
            resolve(ids.map((id) => { const r = byId.get(id); if (!r) throw new Error("missing rpc response"); if (r.error) { const e = new Error(r.error.message); e.rpc = r.error; throw e; } return r.result; }));
          } catch (e) { reject(e); }
        });
      });
      rq.on("error", reject);
      rq.end(body);
    });
  }
  one(m, p) { return this.call([[m, p]]).then((r) => r[0]); }
}

/** Sorted-pair keccak Merkle tree, identical to the on-chain verifyMembership/verifyInBatch. */
const pair = (a, b) => (a < b ? ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [a, b]) : ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [b, a]));
function merkle(leaves) {
  let nodes = leaves.map((l, i) => ({ hash: l, members: [i] }));
  const proofs = leaves.map(() => []);
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 === nodes.length) { next.push(nodes[i]); continue; }
      const a = nodes[i], b = nodes[i + 1];
      for (const m of a.members) proofs[m].push(b.hash);
      for (const m of b.members) proofs[m].push(a.hash);
      next.push({ hash: pair(a.hash, b.hash), members: [...a.members, ...b.members] });
    }
    nodes = next;
  }
  return { root: nodes[0].hash, proofs };
}
function verifyProof(leaf, proof, root) { let c = leaf; for (const s of proof) c = pair(c, s); return c === root; }
function merkleRoot(leaves) { return merkle(leaves).root; }

/** Resolves pending tx hashes when their block is first observed (25 ms polling). */
class BlockWatcher {
  constructor(rpc, pollMs = 25) { this.rpc = rpc; this.pollMs = pollMs; this.waiters = new Map(); this.last = null; this.run = false; }
  async start() { this.last = parseInt(await this.rpc.one("eth_blockNumber"), 16); this.run = true; this.loop(); }
  stop() { this.run = false; }
  watch(hash) { return new Promise((res) => this.waiters.set(hash, res)); }
  async loop() {
    while (this.run) {
      try {
        const bn = parseInt(await this.rpc.one("eth_blockNumber"), 16);
        for (let n = this.last + 1; n <= bn; n++) {
          const blk = await this.rpc.one("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
          const t = now();
          for (const hash of blk.transactions) { const w = this.waiters.get(hash); if (w) { this.waiters.delete(hash); w({ t, block: n }); } }
        }
        this.last = Math.max(this.last, bn);
      } catch (e) { /* transient */ }
      await sleep(this.pollMs);
    }
  }
}

const stats = (a) => {
  if (!a.length) return { n: 0, mean_ms: null, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: a.length, mean_ms: a.reduce((x, y) => x + y, 0) / a.length, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), max_ms: s[s.length - 1] };
};

/** Pool of sender wallets that sign and broadcast raw transactions (one nonce counter each). */
class SenderPool {
  constructor(rpc, keys, chainId, feeOpts) { this.rpc = rpc; this.w = keys.map((k) => new ethers.Wallet(k)); this.chainId = chainId; this.fee = feeOpts; this.nonces = null; this.i = 0; }
  async init() { this.nonces = await Promise.all(this.w.map((w) => this.rpc.one("eth_getTransactionCount", [w.address, "pending"]).then((x) => parseInt(x, 16)))); }
  async send(to, data, gasLimit) {
    const k = this.i++ % this.w.length;
    const nonce = this.nonces[k]++;
    const raw = await this.w[k].signTransaction({ to, data, gasLimit, nonce, chainId: this.chainId, value: 0, ...this.fee });
    return this.rpc.one("eth_sendRawTransaction", [raw]);
  }
}

module.exports = { h, now, sleep, artifact, IFACES, Rpc, merkle, merkleRoot, verifyProof, BlockWatcher, stats, SenderPool, ethers };
