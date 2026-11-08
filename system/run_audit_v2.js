// Local test (no cloud): audit record format v2 (sequence number, gateway id, decision, hash of device signature).
// The verifier re-hashes the presented records, compares the Merkle root with the anchored root, and additionally checks that
// sequence numbers run 0..N-1 in order. usage: NODE_PATH=<dir with ethers> node system/run_audit_v2.js <out.json>
const { ethers } = require('ethers');
const fs = require('fs');
const k = (a, b) => (a < b ? ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [a, b]) : ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [b, a]));
const root = (leaves) => { let c = leaves; while (c.length > 1) { const n = []; for (let i = 0; i < c.length; i += 2) n.push(i + 1 < c.length ? k(c[i], c[i + 1]) : c[i]); c = n; } return c[0]; };
const mk = (i, tag = '') => ({ did: 'did:bczta:' + (i % 997), res: 'r' + (i % 13), t: 1700000000 + i, gw: 'gw0', seq: i, dec: 1, sigh: ethers.id('sig' + tag + i) });
const leaf = (r) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(r)));
const seqOK = (rs) => rs.every((r, i) => r.seq === i);
const detect = (rs, anchored) => root(rs.map(leaf)) !== anchored || !seqOK(rs);
const TR = 100, out = { date: new Date().toISOString(), rows: [] };
for (const N of [50, 100, 500, 1000, 5000]) {
  const recs = Array.from({ length: N }, (_, i) => mk(i)), anchored = root(recs.map(leaf));
  const ops = {
    modify: (r) => { const q = r.slice(), i = Math.floor(Math.random() * N); q[i] = mk(i, 'x'); return q; },
    delete: (r) => { const q = r.slice(); q.splice(Math.floor(Math.random() * N), 1); return q; },
    insert: (r) => { const q = r.slice(); q.splice(Math.floor(Math.random() * N), 0, mk(N + 7, 'ins')); return q; },
    swap_adjacent: (r) => { const q = r.slice(), i = Math.floor(Math.random() * (N - 1)); [q[i], q[i + 1]] = [q[i + 1], q[i]]; return q; },
    // operator renumbers after a swap so that sequence numbers look contiguous: the leaf contents then differ, so the root changes
    swap_and_renumber: (r) => { const q = r.slice(), i = Math.floor(Math.random() * (N - 1)); [q[i], q[i + 1]] = [q[i + 1], q[i]]; return q.map((x, j) => ({ ...x, seq: j })); },
  };
  const row = { batch: N };
  for (const [m, f] of Object.entries(ops)) { let d = 0; for (let t = 0; t < TR; t++) d += detect(f(recs), anchored) ? 1 : 0; row[m] = { detected: d, trials: TR }; }
  row.honest_false_positive = detect(recs, anchored) ? 1 : 0;
  out.rows.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
