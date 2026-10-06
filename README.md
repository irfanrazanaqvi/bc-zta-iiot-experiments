# BC-ZTA: Blockchain-Assisted Zero-Trust Architecture for IIoT — experimental code

Companion code for the paper. It contains (1) four Solidity contracts with a 15-test suite,
(2) a gas-measurement script, (3) a documented Monte-Carlo / queueing model that produces the
latency, scalability and revocation results, and (4) the figure scripts.

## What is measured and what is modelled
| Item in paper | Source | Nature |
|---|---|---|
| Table 6 (gas per operation) | `scripts/measure_gas.js` -> `simulation/output/gas_measurements.json` | **Measured** (Hardhat EVM, london, optimizer 200) |
| Section 5.2 / 15 passing tests | `test/BCZTA.test.js` | **Executed** |
| Tables 4-5, Figs. 3-5 (incl. sensitivity), revocation delay, audit growth | `simulation/simulate_experiment.py` | **Model** with explicit assumed parameters (`PARAMS`) |
| Live Besu consensus timing, device CPU/memory | - | **Not measured**; replace the model with Besu + Hyperledger Caliper runs before publication |

## Setup
```bash
npm install --legacy-peer-deps      # Hardhat toolbox peer-dependency resolution
pip install -r requirements.txt
```

## Run
```bash
npx hardhat compile
npx hardhat test                    # 15 tests
npx hardhat run scripts/measure_gas.js
python3 simulation/simulate_experiment.py   # writes simulation/output/*
python3 figures/fig1_architecture.py <outdir>
python3 figures/fig2_workflow.py <outdir>   # Figs. 1-2 drawn at IEEE column width, text >= 8 pt
```
If the Solidity compiler cannot be downloaded (offline machine), use the bundled solcjs fallback:
`USE_SOLCJS=1 npx hardhat test`.

## Live Besu benchmark
See `besu/README.md` (4-validator IBFT 2.0 docker-compose, genesis generator) and `benchmark/run_benchmark.js`
(write confirmation, read latency, throughput vs offered rate, batch anchoring, revocation visibility).

## Deploying to Hyperledger Besu (IBFT 2.0)
```bash
export BESU_RPC_URL=http://<validator>:8545
export BESU_PRIVATE_KEY=0x<funded key>
npx hardhat run scripts/deploy.js --network besu
```

## Contracts (`contracts/`)
- `IdentityRegistry.sol` - DID registration (plant-authority only), key update, revocation, epoch Merkle commitments, membership proofs.
- `TrustReputation.sol` - score 0-100 (default 70), quorum-voted updates, rate limit, anomaly flag (-20, floored at 0).
- `AccessControl.sol` - ABAC policy (device-class range, minimum trust, session TTL), per-request evaluation, sessions.
- `AuditLog.sol` - per-event log and Merkle batch anchoring with inclusion verification.

## Model assumptions
All parameters (RTTs, ECDSA cost, cache hit ratio 0.90, ledger capacity 300 tx/s, block period 2 s, ...)
are listed in `simulation/output/table3_model_parameters.csv` and in `PARAMS`; changing them regenerates every result.
The seed (42) makes the run reproducible.
