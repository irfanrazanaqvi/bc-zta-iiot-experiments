// Local experiment (no cloud): what can a malicious OPERATOR change after the fact, and who notices?
// Three ways of storing audit records are compared with the same 1,000 records (10 batches of 100):
//   central   : a mutable log at the operator, nothing published outside it (the audit trail of baseline B6)
//   hashchain : a hash-chained log whose head is published on the operator's own site
//   anchored  : BC-ZTA, batch Merkle roots anchored in the real AuditLog contract (Hardhat in-process network)
// The verifier is a third party that sees only what each system publishes outside the operator's control.
// The operator can edit the database and holds the contract admin key, but is not part of the validator quorum.
const { ethers } = require("hardhat");
const fs = require("fs");
const kk = (a, b) => (a < b ? ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [a, b]) : ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [b, a]));
const root = (ls) => { let c = ls; while (c.length > 1) { const n = []; for (let i = 0; i < c.length; i += 2) n.push(i + 1 < c.length ? kk(c[i], c[i + 1]) : c[i]); c = n; } return c[0]; };
const rec = (i, tag = "") => ({ did: "d" + (i % 97), res: "r" + (i % 7), t: 1700000000 + i, gw: "gw0", seq: i, dec: 1, sigh: ethers.id("s" + tag + i) });
const leaf = (r) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(r)));
const N = 1000, B = 100;
const chainHead = (rs) => rs.reduce((h, r) => ethers.keccak256(ethers.concat([h, leaf(r)])), ethers.ZeroHash);
const batches = (rs) => Array.from({ length: rs.length / B }, (_, b) => rs.slice(b * B, (b + 1) * B));

async function main() {
  const [admin, other] = await ethers.getSigners();
  const AL = await (await ethers.getContractFactory("AuditLog")).deploy();
  const honest = Array.from({ length: N }, (_, i) => rec(i));
  for (const b of batches(honest)) await (await AL.anchorBatch(root(b.map(leaf)), b.length)).wait();
  const published = { head: chainHead(honest) };   // what the hash-chain operator published
  const nAnch = Number(await AL.totalAnchors());
  const anchoredRoots = []; for (let i = 0; i < nAnch; i++) anchoredRoots.push((await AL.getAnchor(i)).root);

  // verifiers: return true when tampering is detected
  const vCentral = () => false;                                                         // nothing outside the operator to compare with
  const vChain = (rs, head) => chainHead(rs) !== head;                                  // compares with the head the operator published
  const vAnchored = (rs, anchors) => {                                                  // compares every batch with the on-chain roots and counts anchors
    const bs = batches(rs.length % B === 0 ? rs : rs.concat(Array(B - (rs.length % B)).fill(null).map((_, k) => rec(1e6 + k, "pad"))));
    if (anchors.length !== N / B) return true;                                          // a replaced or extra anchor shows up as a count mismatch
    return bs.some((b, i) => root(b.map(leaf)) !== anchors[i]) || rs.some((r, i) => r.seq !== i);
  };
  const attacks = {
    modify_record:        { logs: () => { const r = honest.slice(); r[417] = rec(417, "x"); return r; } },
    delete_record:        { logs: () => { const r = honest.slice(); r.splice(417, 1); return r; } },
    insert_record:        { logs: () => { const r = honest.slice(); r.splice(417, 0, rec(417, "ins")); return r; } },
    rewrite_whole_log:    { logs: () => honest.map((r, i) => (i % 50 === 0 ? rec(i, "rw") : r)), rechain: true },
    reanchor_new_root:    { logs: () => { const r = honest.slice(); r[417] = rec(417, "x"); return r; }, reanchor: true },
    gateway_omits_record: { logs: () => honest, omitBeforeAnchor: true },
  };
  const out = { date: new Date().toISOString(), records: N, batch: B, attacks: {} };
  for (const [name, a] of Object.entries(attacks)) {
    let logs = a.logs();
    let head = published.head, anchors = anchoredRoots.slice();
    if (a.rechain) head = chainHead(logs);                                              // operator recomputes the chain and republishes the head
    if (a.reanchor) {                                                                   // operator (admin) authorises itself and anchors a forged batch root
      await (await AL.setGateway(other.address, true)).wait();
      const bs = batches(logs); await (await AL.connect(other).anchorBatch(root(bs[4].map(leaf)), B)).wait();
      const n = Number(await AL.totalAnchors()); anchors = []; for (let i = 0; i < n; i++) anchors.push((await AL.getAnchor(i)).root);
      await (await AL.setGateway(other.address, false)).wait();
    }
    let vA = vAnchored(logs, anchors), vC = vChain(logs, head);
    if (name === "gateway_omits_record") { vA = false; vC = false; }                    // dropped before anchoring: no system here can tell
    out.attacks[name] = { central: vCentral(), hashchain: vC, anchored: vA };
    console.log(name, JSON.stringify(out.attacks[name]));
  }
  fs.writeFileSync(process.env.OUT || "benchmark/results/local-verify-2026-11-08/operator_tamper.json", JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
