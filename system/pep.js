// Policy Enforcement / Decision Point (PEP/PDP) service. MODE selects the architecture under test:
//   bczta  : proposed. Decides from edge-cached, Merkle-verified ledger state; invalidation by chain events (INVALIDATION=events)
//            or TTL only (ttl); audit records are anchored on-chain as one Merkle root per ANCHOR_MS.
//   bcsync : baseline B3. Every request reads state with eth_call and sends a logEvent transaction that must be
//            included in a block before the reply.
//   abac   : baseline B2. Local attribute store, no ledger.
//   central: baseline B1. One lookup per request at the (emulated-WAN) central directory server.
//   keycloak: baseline B4. Real Keycloak IdP; the device presents an OIDC access token and the PEP introspects it (RFC 7662) at Keycloak.
//   ldap   : baseline B5. Real OpenLDAP directory; one LDAP search per request.
//   push   : baseline B6. Central directory (emulated WAN) like B1, but the PEP caches its answers (TTL_S) and the directory PUSHES revocations
//            to the PEP (server-sent events), i.e. event-driven invalidation without a blockchain. No ledger, no audit anchoring.
//   keycloak / ldap accept IAM_TTL_S > 0 to cache the central answer at the PEP (cached variants); 0 = lookup on every request.
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
const IAM_TTL_MS = Number(process.env.IAM_TTL_S || 0) * 1000;
const KC_URL = process.env.KC_URL || "http://127.0.0.1:8080", LDAP_URL = process.env.LDAP_URL || "ldap://127.0.0.1:389";
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
const rpc = new Rpc(cfg.rpc, { timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 2500) });
// Optional read quorum: RPC_URLS = comma list of validator RPC endpoints; QUORUM = number of nodes that must return identical state (f+1 = 2 for n = 4).
const RPC_URLS = (process.env.RPC_URLS || "").split(",").filter(Boolean);
const QUORUM = Number(process.env.QUORUM || 1);
const qrpcs = QUORUM > 1 ? RPC_URLS.slice(0, QUORUM).map((u) => new Rpc(u, { timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 2500) })) : null;
// Fail-closed bound: after the cache entry has expired and the ledger cannot be read, the last known state is still used for at most
// STALE_FACTOR x TTL after it was fetched (serve-stale); after that the PEP denies with reason "unavailable".
const STALE_MAX_MS = Number(process.env.STALE_FACTOR || 2) * TTL_MS;
// Circuit breaker: after a failed read of the state source (ledger node / directory), further reads are skipped for BREAK_MS and answered from the
// last known state (within the stale bound) instead of every request waiting for the RPC timeout.
const BREAK_MS = Number(process.env.BREAK_MS || 1000);
let srcDownUntil = 0;
async function viaSource(fn) {
  if (now() < srcDownUntil) throw new Error("source_down");
  try { const v = await fn(); S.srcOk = (S.srcOk || 0) + 1; return v; } catch (e) { S.srcFail = (S.srcFail || 0) + 1; if (e.message !== "ledger_inconsistent") srcDownUntil = now() + BREAK_MS; throw e; }
}
const fee = cfg.fee.type === 2 ? { type: 2, maxFeePerGas: BigInt(cfg.fee.maxFeePerGas), maxPriorityFeePerGas: BigInt(cfg.fee.maxPriorityFeePerGas) } : { type: 0, gasPrice: BigInt(cfg.fee.gasPrice) };
const IR = IFACES.IdentityRegistry, TR = IFACES.TrustReputation, AC = IFACES.AccessControl, AL = IFACES.AuditLog;
const A = cfg.addrs;
const local = new Map(cfg.devices.map((d) => [d.did, { known: true, revoked: false, pkh: d.pkh, cls: d.cls, trust: d.name === "atk-lowtrust" ? 20 : 70 }]));
const policy = { active: true, minClass: cfg.policy.minClass, maxClass: cfg.policy.maxClass, minTrust: cfg.policy.minTrust };
const proofs = new Map(cfg.devices.map((d) => [d.did, d.proof]));   // proofs are presented by devices in the request; kept here only for the unregistered case

const S = { staleServed: 0, unavailable: 0, requests: 0, allow: 0, deny: {}, cacheHit: 0, cacheMiss: 0, invalidations: 0, anchorsSent: 0, anchorsConfirmed: 0, anchorLeaves: 0, chainReads: 0, iamLookups: 0, txSent: 0, txConfirmed: 0 };
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
async function readChainStateQ(did) {
  if (!qrpcs) return readChainState(did);
  // pin all nodes to the same (lowest reported) block height, then require identical answers from every queried node
  S.chainReads++;
  const hs = await Promise.all(qrpcs.map((r) => r.one("eth_blockNumber")));
  const tag = "0x" + Math.min(...hs.map((x) => parseInt(x, 16))).toString(16);
  const calls = [
    ["eth_call", [{ to: A.IR, data: IR.encodeFunctionData("records", [did]) }, tag]],
    ["eth_call", [{ to: A.TR, data: TR.encodeFunctionData("getScore", [did]) }, tag]],
    ["eth_call", [{ to: A.AC, data: AC.encodeFunctionData("policies", [cfg.resource]) }, tag]],
  ];
  const outs = await Promise.all(qrpcs.map((r) => r.call(calls)));
  const ref = JSON.stringify(outs[0]);
  if (outs.some((o) => JSON.stringify(o) !== ref)) { S.quorumMismatch = (S.quorumMismatch || 0) + 1; throw new Error("ledger_inconsistent"); }
  const [rec, score, pol] = outs[0];
  const r = IR.decodeFunctionResult("records", rec), sc = TR.decodeFunctionResult("getScore", score), p = AC.decodeFunctionResult("policies", pol);
  return { known: r[0] !== ethers.ZeroHash, revoked: r[2], pkh: r[0], cls: Number(r[1]), trust: Number(sc[0]),
           policy: { active: p[4], minClass: Number(p[0]), maxClass: Number(p[1]), minTrust: Number(p[2]) } };
}
async function getRoot() {
  if (rootCache && now() < rootCache.exp) return rootCache.root;
  try {
    const r = await viaSource(() => rpc.one("eth_call", [{ to: A.IR, data: IR.encodeFunctionData("epochRoot", [cfg.epoch]) }, "latest"]));
    rootCache = { root: r, exp: now() + 60000, fetched: now() };
    return r;
  } catch (e) {
    if (rootCache && now() - rootCache.fetched <= STALE_MAX_MS) { S.staleServed++; return rootCache.root; }
    throw new Error("unavailable");
  }
}
function central(did) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ did });
    const rq = http.request({ host: CENTRAL.hostname, port: CENTRAL.port, path: "/lookup", method: "POST", agent: centralAgent, headers: { "content-type": "application/json" } }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => { const j = JSON.parse(Buffer.concat(ch).toString()); resolve(j ? { known: true, revoked: j.revoked, pkh: j.pkh, cls: j.cls, trust: j.trust, policy } : { known: false }); });
    });
    rq.on("error", reject); rq.setTimeout(3000, () => rq.destroy(new Error("central timeout"))); rq.end(body);
  });
}
const centralAgent = new http.Agent({ keepAlive: true, maxSockets: 512 });
let kcLib = null, ldapClient = null;
if (MODE === "keycloak") kcLib = require("./iam/kc");
if (MODE === "ldap") { const { Ldap } = require("./iam/ldap"); ldapClient = new Ldap(LDAP_URL, { poolSize: Number(process.env.LDAP_POOL || 16) }); }
async function keycloak(token, did) {
  if (!token) return { known: false };
  const j = await kcLib.introspect(KC_URL, token, 5000);
  if (j.active && j.username !== did) return { known: false };          // token issued to a different identity
  if (!j.active) return { known: true, revoked: true, pkh: j.pkh, cls: Number(j.device_class), trust: Number(j.trust), policy };
  return { known: true, revoked: false, pkh: j.pkh, cls: Number(j.device_class), trust: Number(j.trust), policy };
}
async function ldap(did) {
  const r = await ldapClient.lookup(did);
  return r ? { known: true, revoked: r.revoked, pkh: r.pkh, cls: r.cls, trust: r.trust, policy } : { known: false };
}

async function getState(did, token) {
  if (MODE === "keycloak" || MODE === "ldap") {
    const e = IAM_TTL_MS > 0 ? cache.get(did) : null;
    if (e && now() < e.exp) { S.cacheHit++; return e.st; }
    if (IAM_TTL_MS > 0) S.cacheMiss++;
    S.iamLookups++;
    const st = MODE === "keycloak" ? await keycloak(token, did) : await ldap(did);
    if (IAM_TTL_MS > 0 && st.known) cache.set(did, { st, exp: now() + IAM_TTL_MS });
    return st;
  }
  if (MODE === "abac") return { ...(local.get(did) || { known: false }), policy };
  if (MODE === "central") return central(did);
  if (MODE === "bcsync") return readChainState(did);
  const e = cache.get(did);
  if (e && now() < e.exp) { S.cacheHit++; return e.st; }
  S.cacheMiss++;
  try {
    const st = await viaSource(() => (MODE === "push" ? central(did) : readChainStateQ(did)));
    cache.set(did, { st, exp: now() + TTL_MS, fetched: now() });
    return st;
  } catch (err) {
    // source unreachable (or, with a read quorum, inconsistent): serve the last known state for at most STALE_MAX_MS, then fail closed
    if (e && err.message !== "ledger_inconsistent" && now() - e.fetched <= STALE_MAX_MS) { S.staleServed++; return e.st; }
    S.unavailable++;
    throw new Error(err.message === "ledger_inconsistent" ? "inconsistent" : "unavailable");
  }
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

// ---------- central push channel (baseline B6) ----------
if (MODE === "push") {
  const connect = () => {
    const rq = http.get({ host: CENTRAL.hostname, port: CENTRAL.port, path: "/events", agent: false }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 2); if (m.startsWith("data: ")) { cache.delete(m.slice(6)); S.invalidations++; } } });
      res.on("end", () => setTimeout(connect, 500)); res.on("error", () => {});
    });
    rq.on("error", () => setTimeout(connect, 500));
  };
  connect();
}

// ---------- audit ----------
const watcher = new BlockWatcher(rpc);
let sender = null, auditBuf = [];
async function startChain() {
  if (MODE !== "bczta" && MODE !== "bcsync") return;
  // several PEP processes on one host (scale-out test) use disjoint sender wallets so that their audit anchors do not collide on nonces
  const SN = Number(process.env.SENDER_N || 1), SI = Number(process.env.SENDER_IDX || 0);
  sender = new SenderPool(rpc, cfg.senderKeys.filter((_, j) => j % SN === SI), cfg.chainId, fee);
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
  const { did, res, ts, nonce, sig, proof, cls, token } = b;
  if (!did || !sig) return deny("malformed");
  if (Math.abs(Date.now() - ts) > FRESH_MS) return deny("stale");
  const key = did + ":" + nonce;
  if (seen.has(key)) return deny("replay");
  seen.set(key, Date.now());
  let addr;
  try { addr = ethers.verifyMessage(`${did}|${res}|${ts}|${nonce}`, sig); } catch (e) { return deny("badsig"); }
  let st;
  try { st = await getState(did, token); } catch (e) { if (e.message === "unavailable" || e.message === "inconsistent") return deny(e.message); throw e; }
  if (!st.known) return deny("unknown");
  if (st.revoked) return deny("revoked");
  if (ethers.keccak256(addr) !== st.pkh) return deny("sigmismatch");
  if (MODE === "bczta" || MODE === "bcsync") {
    let root;
    try { root = await getRoot(); } catch (e) { if (e.message === "unavailable") return deny("unavailable"); throw e; }
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
