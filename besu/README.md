# Local 4-validator Besu IBFT 2.0 network

Follows the official Besu IBFT 2.0 private-network tutorial (genesis and keys from
`besu operator generate-blockchain-config`). **It was written without access to a Docker daemon, so the Docker
files were checked for syntax only; run `./check.sh` first and fix any version-specific flag complaints.**
The benchmark script was tested end-to-end against a local Hardhat node (functional test only; those
numbers say nothing about Besu).

## 1. Start the network
```bash
cd besu
./setup.sh              # needs Docker; BESU_VERSION=<tag> ./setup.sh to pin a version
docker compose up -d
./check.sh              # expect 4 validators and a rising block number (2 s block period)
```
Ports: HTTP RPC 8545-8548, WebSocket 8645-8648 (nodes 1-4).
Genesis: chainId 2026, `blockperiodseconds: 2`, `zeroBaseFee: true`, London EVM (contracts are compiled with
`evmVersion: london`, so no PUSH0 opcode), four pre-funded well-known test accounts (Hardhat accounts 0-3;
**test keys only, never for a real network**).

## 2. Run the benchmark (primary path)
```bash
cd ..                                   # package root
npm install --legacy-peer-deps
USE_SOLCJS=1 npx hardhat compile        # or without USE_SOLCJS if the compiler can be downloaded
RPC_URL=http://127.0.0.1:8545 node benchmark/run_benchmark.js          # full run, a few minutes
node benchmark/run_benchmark.js --quick # short smoke test
```
Results: `benchmark/output/measured_results.json` and `s3_throughput.csv`.
Run at least 3 times and report mean and spread. Record host CPU/RAM, Besu version and the Docker setup in the
paper, because all four validators share one machine.

## 3. Putting the numbers in the paper
| Measured field | Replaces / complements |
|---|---|
| `S1_write_confirmation` (logEvent, anchorBatch) | Blockchain-only latency in Table 5 (model: about 1 s) |
| `S2_read_latency` | `chain_read_ms` assumption (model: 8 ms) and the cache-miss tail |
| `S3_per_event_logging` | Ledger-capacity assumption (300 tx/s) and the saturation point in Fig. 4 |
| `S4_batch_anchoring` | On-chain write load of BC-ZTA |
| `S5_revocation_visibility` | Block-finality part of the revocation delay (Section VI-E) |

Then set the measured values in `PARAMS` of `simulation/simulate_experiment.py` (`chain_read_ms`,
`chain_capacity_tps`, ...) and re-run it so Figs. 3-5 use measured ledger behaviour. The edge-cache path and
gateway cost still need a gateway implementation to be measured end to end.

## 4. Optional: Hyperledger Caliper
`benchmark/caliper/` holds an **untested** template (logEvent at 50/100 tps and batch anchoring). Caliper adds
standard reports but needs the contract JSON copied in and a WebSocket endpoint; the Node benchmark covers the
same scenarios and more.
