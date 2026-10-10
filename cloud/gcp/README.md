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
