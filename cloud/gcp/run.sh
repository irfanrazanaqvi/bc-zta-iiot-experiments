#!/usr/bin/env bash
# Multi-VM end-to-end benchmark on Google Cloud (run in Google Cloud Shell).
#   usage: nohup ./run.sh > ~/run.log 2>&1 &   then   tail -f ~/run.log     (safe to re-run: finished steps are skipped)
# Creates 7 VMs: val1..val4 (Besu IBFT2 validators), pep (PEP/PDP), dir (central directory, +40 ms netem), ctl (load generator / orchestrator).
# Runs 5 repetitions, each on a freshly started chain, then packs results into ~/e2e-gcp-results.tar.gz.
set -euo pipefail
ZIP="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"   # a code zip, or the cloned repository folder (default: this repository)
if [ -d "$ZIP" ]; then
  command -v zip >/dev/null || sudo apt-get install -y zip >/dev/null
  echo "packing $ZIP"; rm -f /tmp/bczta-code.zip
  (cd "$ZIP" && zip -qr /tmp/bczta-code.zip . -x ".git/*" "node_modules/*" "artifacts/*" "cache/*" "besu/networkFiles/*" "besu/nodes/*" "e2e_output/*" "benchmark/output/*")
  ZIP=/tmp/bczta-code.zip
fi
ZONE="${ZONE:-us-central1-a}"
# Free-trial projects are usually limited to 8 vCPUs in total, so the defaults are sized to fit; override if your quota is larger.
MACHINE_VAL="${MACHINE_VAL:-e2-medium}"; MACHINE_PEP="${MACHINE_PEP:-e2-standard-2}"; MACHINE_CTL="${MACHINE_CTL:-e2-standard-2}"; MACHINE_DIR="${MACHINE_DIR:-e2-small}"
REGION="${ZONE%-*}"
REPS="${REPS:-5}"
BESU_VERSION="${BESU_VERSION:-26.9.0}"
NETEM_VAL_MS="${NETEM_VAL_MS:-5}"      # one-way delay added on each validator's egress (separate-site links)
NETEM_WAN_MS="${NETEM_WAN_MS:-40}"     # delay added on the central directory's egress (WAN round trip)
VMS="val1 val2 val3 val4 pep dir ctl"
if command -v docker >/dev/null 2>&1 && ! docker manifest inspect "hyperledger/besu:$BESU_VERSION" >/dev/null 2>&1; then echo "Besu tag $BESU_VERSION not found, using latest"; BESU_VERSION=latest; fi
SSH="gcloud compute ssh --tunnel-through-iap --zone $ZONE --quiet --ssh-flag=-oServerAliveInterval=30 --ssh-flag=-oStrictHostKeyChecking=no"
SCP="gcloud compute scp --tunnel-through-iap --zone $ZONE --quiet"
sh() { local vm="$1"; shift; $SSH "$vm" --command "$*"; }

echo "== 1/8 enabling API and firewall"
gcloud services enable compute.googleapis.com >/dev/null
gcloud compute firewall-rules describe bczta-internal >/dev/null 2>&1 || \
  gcloud compute firewall-rules create bczta-internal --network default --allow tcp,udp,icmp --source-ranges 10.128.0.0/9 >/dev/null

# Free-trial accounts allow only 4 external IPs per region, so the VMs get internal addresses only.
# Internet access (apt, npm, docker) goes through one Cloud NAT; SSH goes through IAP.
gcloud compute firewall-rules describe bczta-iap >/dev/null 2>&1 || \
  gcloud compute firewall-rules create bczta-iap --network default --allow tcp:22 --source-ranges 35.235.240.0/20 >/dev/null
gcloud compute routers describe bczta-router --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute routers create bczta-router --network default --region "$REGION" >/dev/null
gcloud compute routers nats describe bczta-nat --router bczta-router --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute routers nats create bczta-nat --router bczta-router --region "$REGION" --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges >/dev/null

echo "== 2/8 creating VMs in $ZONE (validators $MACHINE_VAL, pep $MACHINE_PEP, ctl $MACHINE_CTL, dir $MACHINE_DIR)"
gcloud compute regions describe "$REGION" --format="value(quotas)" 2>/dev/null | tr ';' '\n' | grep "metric.*CPUS'" | head -2 || true
cat > /tmp/startup.sh <<'EOS'
#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io unzip curl ca-certificates gnupg iproute2 git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
systemctl enable --now docker
touch /var/run/bczta-ready
EOS
mt_of() { case "$1" in val*) echo "$MACHINE_VAL";; pep) echo "$MACHINE_PEP";; ctl) echo "$MACHINE_CTL";; dir) echo "$MACHINE_DIR";; esac; }
for vm in $VMS; do
  gcloud compute instances describe "$vm" --zone "$ZONE" >/dev/null 2>&1 || \
  gcloud compute instances create "$vm" --zone "$ZONE" --machine-type "$(mt_of "$vm")" --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 30GB --no-address --metadata-from-file startup-script=/tmp/startup.sh \
    --max-run-duration=8h --instance-termination-action=DELETE --quiet >/dev/null &
done
wait
MISSING=""
for vm in $VMS; do gcloud compute instances describe "$vm" --zone "$ZONE" >/dev/null 2>&1 || MISSING="$MISSING $vm"; done
if [ -n "$MISSING" ]; then
  echo "ERROR: these VMs were not created:$MISSING" >&2
  echo "Most likely a free-trial quota (vCPUs). Upgrade the account (Billing -> Activate full account) or try ZONE=us-east1-b ./run.sh, then run ./run.sh again (existing VMs are reused)." >&2
  exit 1
fi

echo "== 3/8 waiting for VMs to finish installing Docker and Node"
for vm in $VMS; do
  until sh "$vm" "test -f /var/run/bczta-ready" >/dev/null 2>&1; do sleep 10; done
  echo "   $vm ready"
done
ip_of() { gcloud compute instances describe "$1" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)'; }
IP1=$(ip_of val1); IP2=$(ip_of val2); IP3=$(ip_of val3); IP4=$(ip_of val4); PEP_IP=$(ip_of pep); DIR_IP=$(ip_of dir)
echo "   val: $IP1 $IP2 $IP3 $IP4  pep: $PEP_IP  dir: $DIR_IP"

echo "== 4/8 installing code on ctl, pep and dir; pulling Besu image on validators"
for vm in ctl pep dir; do
  ( $SCP "$ZIP" "$vm:~/code.zip" && sh "$vm" "if [ -d ~/bc/e2e_output ]; then sudo rm -rf ~/e2e_keep; sudo mv ~/bc/e2e_output ~/e2e_keep; fi; sudo rm -rf ~/bc && mkdir ~/bc && cd ~/bc && unzip -q ../code.zip && test -f besu/ibftConfigFile.json && { if [ -d ~/e2e_keep ]; then mv ~/e2e_keep ~/bc/e2e_output; fi; true; } && npm install --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1 && npx hardhat compile >/dev/null 2>&1 && echo compiled-$vm" ) &
done
for vm in val1 val2 val3 val4; do ( sh "$vm" "sudo docker pull hyperledger/besu:$BESU_VERSION >/dev/null && echo pulled-$vm" ) & done
wait

echo "== 5/8 generating validator keys and genesis on ctl"
sh ctl "cd ~/bc/besu && sudo rm -rf networkFiles nodes && sudo docker run --rm --user \"\$(id -u):\$(id -g)\" -v \$PWD:/work -w /work hyperledger/besu:$BESU_VERSION operator generate-blockchain-config --config-file=ibftConfigFile.json --to=networkFiles --private-key-file-name=key >/dev/null && chmod -R a+rX networkFiles && i=1 && for d in networkFiles/keys/*/; do mkdir -p nodes/node\$i && cp \$d/key \$d/key.pub nodes/node\$i/ && chmod 644 nodes/node\$i/* && i=\$((i+1)); done && tar czf ~/chainfiles.tgz networkFiles/genesis.json nodes"
sh ctl "test -s ~/chainfiles.tgz && test -s ~/bc/besu/networkFiles/genesis.json" || { echo "ERROR: key/genesis generation failed on ctl (see messages above)" >&2; exit 1; }
$SCP "ctl:~/chainfiles.tgz" /tmp/chainfiles.tgz
PUB1=$(sh ctl "sed 's/^0x//' ~/bc/besu/nodes/node1/key.pub" | tr -d '\r\n')
for vm in val1 val2 val3 val4; do $SCP /tmp/chainfiles.tgz "$vm:~/chainfiles.tgz"; sh "$vm" "sudo rm -rf ~/bc && mkdir ~/bc && tar xzf ~/chainfiles.tgz -C ~/bc"; done

echo "== 6/8 network emulation (netem) and control agents"
for vm in val1 val2 val3 val4; do sh "$vm" "IF=\$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p'); sudo tc qdisc replace dev \$IF root netem delay ${NETEM_VAL_MS}ms"; done
sh dir "IF=\$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p'); sudo tc qdisc replace dev \$IF root netem delay ${NETEM_WAN_MS}ms"
for vm in pep dir; do sh "$vm" "cd ~/bc && (CONFIG=\$HOME/agent_config.json nohup node system/agent.js > ~/agent.log 2>&1 &) ; sleep 2; curl -s localhost:9500/health"; echo; done

start_chain() {
  local ips=("$IP1" "$IP2" "$IP3" "$IP4") i
  for i in 1 2 3 4; do
    local ip="${ips[$((i-1))]}" boot=""
    [ "$i" -gt 1 ] && boot="--bootnodes=enode://$PUB1@$IP1:30303"
    sh "val$i" "sudo docker rm -f besu >/dev/null 2>&1; sudo rm -rf ~/besu-data; mkdir -p ~/besu-data; chmod 777 ~/besu-data; sudo docker run -d --name besu --network host -v \$HOME/bc/networkFiles/genesis.json:/config/genesis.json:ro -v \$HOME/bc/nodes/node$i:/opt/besu/keys:ro -v \$HOME/besu-data:/opt/besu/data hyperledger/besu:$BESU_VERSION --data-path=/opt/besu/data --node-private-key-file=/opt/besu/keys/key --genesis-file=/config/genesis.json --p2p-host=$ip --p2p-port=30303 $boot --min-gas-price=0 --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-port=8545 --rpc-http-max-active-connections=2000 --rpc-http-api=ETH,NET,WEB3,IBFT,TXPOOL,ADMIN --host-allowlist='*' --rpc-http-cors-origins=all >/dev/null" &
  done
  wait
  echo "   waiting for blocks..."
  for t in $(seq 1 60); do
    BN=$(sh ctl "curl -s -X POST -H 'Content-Type: application/json' --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}' http://$IP1:8545" 2>/dev/null | sed -n 's/.*"result":"\(0x[0-9a-f]*\)".*/\1/p') || true
    if [ -n "${BN:-}" ] && [ $((BN)) -ge 3 ]; then echo "   block $((BN)) reached"; return; fi
    sleep 5
  done
  echo "chain did not start" >&2; exit 1
}

echo "== 7/8 benchmark ($REPS repetitions)"
sh ctl "mkdir -p ~/bc/e2e_output"
for r in $(seq 1 "$REPS"); do
  if sh ctl "test -f ~/run$r.done && test -s ~/bc/e2e_output/run$r/e2e_results.json" >/dev/null 2>&1; then echo "-- run $r already finished, skipping"; continue; fi
  echo "-- run $r: fresh chain"
  sh ctl "pkill -f '[r]un_e2e.js' || true; rm -rf ~/bc/e2e_output/run$r" >/dev/null 2>&1 || true
  start_chain
  sh ctl "cd ~/bc && rm -f ~/run$r.done && (RPC_URL=http://$IP1:8545 AGENT_PEP=http://$PEP_IP:9500 AGENT_DIR=http://$DIR_IP:9500 PEP_HOST=$PEP_IP CENTRAL_HOST=$DIR_IP CENTRAL_URL=http://$DIR_IP:9100 WAN_RTT_MS=0 NETEM_WAN_MS=$NETEM_WAN_MS NETEM_VAL_MS=$NETEM_VAL_MS DEPLOYMENT=gcp-7vm OUT=e2e_output/run$r nohup node system/run_e2e.js > e2e_output/run$r.log 2>&1; touch ~/run$r.done) > /dev/null 2>&1 &"
  until sh ctl "test -f ~/run$r.done" >/dev/null 2>&1; do sleep 60; printf "."; done
  echo; sh ctl "tail -3 ~/bc/e2e_output/run$r.log | cut -c1-160"
done

echo "-- fault test: stop one validator for 30 s while 50 devices are served and a device is revoked"
if sh ctl "test -f ~/fault.done && test -s ~/bc/e2e_output/fault/fault_results.json" >/dev/null 2>&1; then echo "   fault test already finished, skipping"; else
sh ctl "pkill -f '[r]un_fault.js' || true; rm -rf ~/bc/e2e_output/fault ~/bc/e2e_output/fault.log" >/dev/null 2>&1 || true
start_chain
sh ctl "cd ~/bc && rm -f ~/fault.done && (RPC_URL=http://$IP1:8545 AGENT_PEP=http://$PEP_IP:9500 PEP_HOST=$PEP_IP DEPLOYMENT=gcp-7vm OUT=e2e_output/fault nohup node system/run_fault.js > e2e_output/fault.log 2>&1; touch ~/fault.done) > /dev/null 2>&1 &"
until sh ctl "grep -q FAULT_WINDOW_START ~/bc/e2e_output/fault.log" >/dev/null 2>&1; do sleep 3; done
sleep 15
echo "   stopping val4"; sh val4 "sudo docker stop besu >/dev/null"
sleep 30
echo "   restarting val4"; sh val4 "sudo docker start besu >/dev/null"
until sh ctl "test -f ~/fault.done" >/dev/null 2>&1; do sleep 10; printf "."; done
echo; sh ctl "tail -2 ~/bc/e2e_output/fault.log | cut -c1-200"
fi

echo "== 8/8 collecting results"
sh ctl "cd ~/bc/e2e_output && n=\$(ls run*/e2e_results.json 2>/dev/null | wc -l) && [ \$n -ge $REPS ] && test -s fault/fault_results.json" || { echo "ERROR: result files are missing on ctl, not packing an empty archive" >&2; exit 1; }
sh ctl "cd ~/bc && rm -f e2e_output/run*/config.json && for v in val1; do :; done; echo \"gcp 7 VMs (val $MACHINE_VAL, pep $MACHINE_PEP, ctl $MACHINE_CTL, dir $MACHINE_DIR), zone $ZONE, besu $BESU_VERSION, netem validators ${NETEM_VAL_MS}ms, directory ${NETEM_WAN_MS}ms\" > e2e_output/environment.txt; tar czf ~/e2e-gcp-results.tar.gz e2e_output"
$SCP "ctl:~/e2e-gcp-results.tar.gz" ~/e2e-gcp-results.tar.gz
echo
echo "DONE. Results: ~/e2e-gcp-results.tar.gz  (Cloud Shell menu -> Download -> that path), then attach it in the chat."
echo "IMPORTANT: run ./cleanup.sh now to delete the VMs and stop all charges."
