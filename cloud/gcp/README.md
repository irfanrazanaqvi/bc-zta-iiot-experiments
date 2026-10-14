# Multi-VM evaluation on Google Cloud (7 VMs, internal IPs + Cloud NAT)

Roles: val1-val4 (Besu IBFT 2.0 validators, +5 ms netem), pep (PEP/PDP), dir (central directory baseline, +40 ms netem), ctl (load generator / orchestrator).
VMs have no external IPs (free-trial limit: 4 per region); internet goes through one Cloud NAT, SSH through IAP.

1. Open Cloud Shell on your project (`gcloud config list project`).
2. Upload `bczta-v2.zip` (menu, three dots, Upload), then:
   ```
   cd ~ && rm -rf bczta && mkdir bczta && cd bczta && unzip -oq ~/bczta-v2.zip && cd cloud/gcp
   chmod +x *.sh
   nohup ./run.sh > ~/run.log 2>&1 &
   tail -f ~/run.log
   ```
   Re-running `./run.sh` after an interruption skips finished steps and finished repetitions.
3. Takes about 3-4 hours. Result: `~/e2e-gcp-results.tar.gz` (Download it from the Cloud Shell menu).
4. `./cleanup.sh` deletes VMs, router/NAT and firewall rules. Cost: about US$2-3.

## Extended evaluation: real Keycloak / OpenLDAP baselines and ledger-flood sweep (`run_ext.sh`)

`run_ext.sh` is a second, independent script (same 7-VM layout; the `dir` VM is e2-standard-2 and hosts Keycloak 26.4.0 in Docker and OpenLDAP, both behind the 40 ms emulated WAN).
It runs, each repetition on a freshly started 4-validator chain:

* `system/run_iam.js` (3 repetitions): X1 latency/goodput for Keycloak, OpenLDAP, their PEP-cached variants and BC-ZTA; X2 revocation delay; X3 availability while Keycloak / slapd is stopped for 25 s and restarted; X4 PEP capacity (200-1600 requests/s).
* `system/run_flood.js` (2 repetitions x 2 modes): fixed offered flood rates 0-1200 tx/s against the ledger node while 50 devices are served, for BC-ZTA and the synchronous-ledger baseline.

```bash
cd ~/bc-zta-iiot-experiments/cloud/gcp && git pull
QUICK=1 nohup ./run_ext.sh > ~/ext_quick.log 2>&1 &     # ~45 min shakedown, short runs; then:
nohup ./run_ext.sh > ~/ext.log 2>&1 &                    # ~3 h real run (resumable; IAM_REPS / FLOOD_REPS override the repetitions)
./status.sh                                              # progress
./cleanup.sh                                             # when DONE and downloaded
```
Aggregate afterwards with `python3 system/make_ext_artifacts.py <extracted ext_output> <outdir>`.
Note: `SenderPool` now sends one transaction per account at a time and only advances the nonce after the node accepted it (no nonce gaps under overload).

## Extended evaluation 2: robustness experiments (`run_ext2.sh`)
Adds baseline B6 (central directory + push revocation), a 2-node read quorum, loss of the state source (2xTTL fail-closed bound), a consensus-halt test (2 of 4 validators stopped) and PEP scale-out (1/2/4 PEPs on a 4-vCPU VM).
`QUICK=1 nohup ./run_ext2.sh > ~/ext2_quick.log 2>&1 &` (shakedown), then `nohup ./run_ext2.sh > ~/ext2.log 2>&1 &` (about 2.5 h); watch with `SUITE=ext2 ./status.sh`; finish with `./cleanup.sh`.
Aggregate with `python3 system/make_robust_artifacts.py <dir with robust_r*/> <out>`.
Note: `system/pep.js` gained the serve-stale/fail-closed rule, push mode and read quorum after the first two cloud runs; those runs used the earlier behaviour (deny on failed read after TTL).
