// Policy Enforcement / Decision Point (PEP/PDP) service. MODE selects the architecture under test:
//   bczta  : proposed. Decides from edge-cached, Merkle-verified ledger state; invalidation by chain events (INVALIDATION=events)
//            or TTL only (ttl); audit records are anchored on-chain as one Merkle root per ANCHOR_MS.
//   bcsync : baseline B3. Every request reads state with eth_call and sends a logEvent transaction that must be
//            included in a block before the reply.
//   abac   : baseline B2. Local attribute store, no ledger.
//   central: baseline B1. One lookup per request at the (emulated-WAN) central directory server.
const http = require("http");
const fs = require("fs");
const { h, now, sleep, IFACES, Rpc, verifyProof, merkleRoot, BlockWatcher, SenderPool, ethers } = require("./lib");

const MODE = process.env.MODE || "bczta";
const INVALIDATION = process.env.INVALIDATION || "events";
const TTL_MS = Number(process.env.TTL_S || 30) * 1000;
const ANCHOR_MS = Number(process.env.ANCHOR_MS || 1000);
const PORT = Number(process.env.PORT || 9000);
const FRESH_MS = 5000;
const CENTRAL = new URL(process.env.CENTRAL_URL || "http://127.0.0.1:9100");
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
const rpc = new Rpc(cfg.rpc);
const fee = cfg.fee.type === 2 ? { type: 2, maxFeePerGas: BigInt(cfg.fee.maxFeePerGas), maxPriorityFeePerGas: BigInt(cfg.fee.maxPriorityFeePerGas) } : { type: 0, gasPrice: BigInt(cfg.fee.gasPrice) };
const IR = IFACES.IdentityRegistry, TR = IFACES.TrustReputation, AC = IFACES.AccessControl, AL = IFACES.AuditLog;
const A = cfg.addrs;
const local = new Map(cfg.devices.map((d) => [d.did, { known: true, revoked: false, pkh: d.pkh, cls: d.cls, trust: d.name === "atk-lowtrust" ? 20 : 70 }]));
const policy = { active: true, minClass: cfg.policy.minClass, maxClass: cfg.policy.maxClass, minTrust: cfg.policy.minTrust };
const proofs = new Map(cfg.devices.map((d) => [d.did, d.proof]));   // proofs are presented by devices in the request; kept here only for the unregistered case

const S = { requests: 0, allow: 0, deny: {}, cacheHit: 0, cacheMiss: 0, invalidations: 0, anchorsSent: 0, anchorsConfirmed: 0, anchorLeaves: 0, chainReads: 0, txSent: 0, txConfirmed: 0 };
const seen = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of seen) if (t - v > 15000) seen.delete(k); }, 2000).unref();

// ---------- state sources ----------
const cache = new Map();            // did -> {st, exp}
let rootCache = null;
async function readChainState(did) {
  S.chainReads++;
  const [rec, score, pol] = await rpc.call([
    ["eth_call", [{ to: A.IR, data: IR.encodeFunctionData("records", [did]) }, "latest"]],
    ["eth_call", [{ to: A.TR, data: TR.encodeFunctionData("getScore", [did]) }, "latest"]],
    ["eth_call", [{ to: A.AC, data: AC.encodeFunctionData("policies", [cfg.resource]) }, "latest"]],
  ]);
  const r = IR.decodeFunctionResult("records", rec), sc = TR.decodeFunctionResult("getScore", score), p = AC.decodeFunctionResult("policies", pol);
  return { known: r[0] !== ethers.ZeroHash, revoked: r[2], pkh: r[0], cls: Number(r[1]), trust: Number(sc[0]),
           policy: { active: p[4], minClass: Number(p[0]), maxClass: Number(p[1]), minTrust: Number(p[2]) } };
}
async function getRoot() {
  if (rootCache && now() < rootCache.exp) return rootCache.root;
  const r = await rpc.one("eth_call", [{ to: A.IR, data: IR.encodeFunctionData("epochRoot", [cfg.epoch]) }, "latest"]);
  rootCache = { root: r, exp: now() + 60000 };
  return r;
}
function central(did) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ did });
    const rq = http.request({ host: CENTRAL.hostname, port: CENTRAL.port, path: "/lookup", method: "POST", agent: centralAgent, headers: { "content-type": "application/json" } }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => { const j = JSON.parse(Buffer.concat(ch).toString()); resolve(j ? { known: true, revoked: j.revoked, pkh: j.pkh, cls: j.cls, trust: j.trust, policy } : { known: false }); });
    });
    rq.on("error", reject); rq.end(body);
  });
}
const centralAgent = new http.Agent({ keepAlive: true, maxSockets: 512 });

async function getState(did) {
  if (MODE === "abac") return { ...(local.get(did) || { known: false }), policy };
  if (MODE === "central") return central(did);
  if (MODE === "bcsync") return readChainState(did);
  const e = cache.get(did);
  if (e && now() < e.exp) { S.cacheHit++; return e.st; }
  S.cacheMiss++;
  const st = await readChainState(did);
  cache.set(did, { st, exp: now() + TTL_MS });
  return st;
}

// ---------- chain event subscription (cache invalidation) ----------
if (MODE === "bczta" && INVALIDATION === "events") {
  const topics = [IR.getEvent("DIDRevoked").topicHash, IR.getEvent("KeyUpdated").topicHash, TR.getEvent("ScoreUpdated").topicHash];
  (async () => {
    let last = parseInt(await rpc.one("eth_blockNumber"), 16);
    for (;;) {
      try {
        const bn = parseInt(await rpc.one("eth_blockNumber"), 16);
        if (bn > last) {
          const logs = await rpc.one("eth_getLogs", [{ fromBlock: "0x" + (last + 1).toString(16), toBlock: "0x" + bn.toString(16), address: [A.IR, A.TR], topics: [topics] }]);
          for (const l of logs) { if (l.topics[1]) { cache.delete(l.topics[1]); S.invalidations++; } }
          last = bn;
        }
      } catch (e) { /* retry */ }
      await sleep(20);
    }
  })();
}

// ---------- audit ----------
const watcher = new BlockWatcher(rpc);
let sender = null, auditBuf = [];
async function startChain() {
  if (MODE !== "bczta" && MODE !== "bcsync") return;
  sender = new SenderPool(rpc, cfg.senderKeys, cfg.chainId, fee);
  await sender.init();
  await watcher.start();
  if (MODE === "bczta") {
    setInterval(async () => {
      if (!auditBuf.length) return;
      const batch = auditBuf; auditBuf = [];
      const root = merkleRoot(batch);                        // real Merkle root over the batch
      try {
        const hash = await sender.send(A.AL, AL.encodeFunctionData("anchorBatch", [root, batch.length]), 250000);
        S.anchorsSent++; S.anchorLeaves += batch.length;
        watcher.watch(hash).then(() => S.anchorsConfirmed++);
      } catch (e) { /* counted as unconfirmed */ }
    }, ANCHOR_MS).unref();
  }
}

// ---------- request handling ----------
function deny(reason) { S.deny[reason] = (S.deny[reason] || 0) + 1; return { ok: false, reason }; }
async function decide(b) {
  const { did, res, ts, nonce, sig, proof, cls } = b;
  if (!did || !sig) return deny("malformed");
  if (Math.abs(Date.now() - ts) > FRESH_MS) return deny("stale");
  const key = did + ":" + nonce;
  if (seen.has(key)) return deny("replay");
  seen.set(key, Date.now());
  let addr;
  try { addr = ethers.verifyMessage(`${did}|${res}|${ts}|${nonce}`, sig); } catch (e) { return deny("badsig"); }
  const st = await getState(did);
  if (!st.known) return deny("unknown");
  if (st.revoked) return deny("revoked");
  if (ethers.keccak256(addr) !== st.pkh) return deny("sigmismatch");
  if (MODE === "bczta" || MODE === "bcsync") {
    const root = await getRoot();
    if (!proof || !verifyProof(did, proof, root)) return deny("merkle");
  }
  if (!st.policy.active || res !== cfg.resource) return deny("nopolicy");
  if (st.cls < st.policy.minClass || st.cls > st.policy.maxClass) return deny("class");
  if (st.trust < st.policy.minTrust) return deny("trust");
  if (MODE === "bcsync") {
    const hash = await sender.send(A.AL, AL.encodeFunctionData("logEvent", [did, res, 1]), 300000);
    S.txSent++;
    await Promise.race([watcher.watch(hash), sleep(30000).then(() => { throw new Error("timeout"); })]);
    S.txConfirmed++;
  } else if (MODE === "bczta") {
    auditBuf.push(ethers.solidityPackedKeccak256(["bytes32", "bytes32", "uint256", "bool"], [did, res, ts, true]));
  }
  return { ok: true };
}

const srv = http.createServer((req, res) => {
  if (req.url === "/stats") { res.end(JSON.stringify({ ...S, mode: MODE, cpu: process.cpuUsage() })); return; }
  const ch = [];
  req.on("data", (c) => ch.push(c));
  req.on("end", async () => {
    if (req.url === "/admin/revoke") { const b = JSON.parse(Buffer.concat(ch).toString()); const r = local.get(b.did); if (r) r.revoked = true; res.end("{}"); return; }
    S.requests++;
    let out;
    try { out = await decide(JSON.parse(Buffer.concat(ch).toString())); if (out.ok) S.allow++; }
    catch (e) { out = deny("error:" + String(e.message).slice(0, 30)); }
    res.end(JSON.stringify(out));
  });
});
srv.keepAliveTimeout = 60000;
startChain().then(() => srv.listen(PORT, () => console.log("pep ready", MODE, INVALIDATION)));
