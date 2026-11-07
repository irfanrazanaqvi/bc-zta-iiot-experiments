# BC-ZTA end-to-end prototype

* `pep.js` – PEP/PDP service. `MODE=bczta` (proposed: edge cache + Merkle verification + chain-event invalidation + batched Merkle audit anchoring), `bcsync` (every request = on-chain tx), `abac` (local store), `central` (emulated WAN directory).
* `central.js` – emulated centralised PKI-IAM directory (WAN RTT `WAN_RTT_MS`, default 40 ms; in-memory store).
* `onboard.js` – deploys the contracts and onboards devices (registry, one Merkle epoch, policy, trust score).
* `loadgen.js` – open-loop signed-request generator (1 request/s per device).
* `run_e2e.js` – E1 latency/goodput vs devices, E2 revocation enforcement delay, E3 security tests, E4 availability under ledger flooding.

```
npx hardhat compile
RPC_URL=http://127.0.0.1:8545 node system/run_e2e.js          # full run (Besu); QUICK=1 for a smoke test
ONBOARD_CHUNK=1 RPC_URL=... node system/run_e2e.js            # needed for auto-mining dev chains (hardhat node)
```
CI: `.github/workflows/e2e-benchmark.yml` (results branch `e2e-results`).

## Modes and experiments added later
* `pep.js` `MODE=push` – baseline B6: central directory with cached answers and server-sent-event revocation push (`central.js /events`). `MODE=bczta` options: `STALE_FACTOR` (serve-stale bound, default 2 x TTL, then deny "unavailable"), `RPC_URLS` + `QUORUM=2` (f+1 read quorum pinned to one block height), `RPC_TIMEOUT_MS`, `BREAK_MS` (circuit breaker), `SENDER_N`/`SENDER_IDX` (disjoint audit-sender wallets per PEP process).
* `run_iam.js` (Keycloak/OpenLDAP baselines), `run_flood.js` (ledger flood sweep), `run_robust.js` (push baseline, quorum, loss of state source, consensus halt, PEP scale-out). Cloud drivers: `cloud/gcp/run_ext.sh`, `cloud/gcp/run_ext2.sh`.

## Local audit-verification and registry-size tests (no cloud)

`run_audit_verify.js` checks that tampering with a log whose Merkle roots are anchored is detected by an independent verifier, and measures Merkle proof size, verification time and tree-build time for registries of 10^3 to 10^6 devices.

```
npm i ethers            # only dependency
node system/run_audit_verify.js benchmark/results/local-verify-2026-11-08/audit_verify.json
```

Results are in `benchmark/results/local-verify-2026-11-08/` (2-vCPU container, Node 22). Swapping two adjacent records is only partly detected, because the sorted-pair Merkle root commits to the set of records, not their order; see Section 6.11 of the paper.
