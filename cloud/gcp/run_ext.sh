#!/usr/bin/env bash
# Extended evaluation on Google Cloud (run in Google Cloud Shell):
#   (a) real central identity services as baselines: Keycloak (OIDC token introspection) and OpenLDAP, each with and without PEP-side caching,
#       including revocation delay, central-service outage and PEP capacity (run_iam.js)
#   (b) ledger-flood sweep with fixed offered transaction rates for BC-ZTA and the synchronous-blockchain baseline (run_flood.js)
# usage:   QUICK=1 nohup ./run_ext.sh > ~/ext_quick.log 2>&1 &     (about 45 min: shakedown of every step with short runs, results kept apart)
#          nohup ./run_ext.sh > ~/ext.log 2>&1 &                    (about 3 h: the real measurements)        watch with ./status.sh
# Safe to start again after an interruption: finished runs are skipped. Only one instance can run (lock).
# When it prints DONE, download the archive it names and run ./cleanup.sh.
set -euo pipefail
exec 9>/tmp/bczta-ext.lock
flock -n 9 || { echo "run_ext.sh is already running in this shell session; wait for it or use ./status.sh" >&2; exit 1; }

ZIP="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
if [ -d "$ZIP" ]; then
  command -v zip >/dev/null || sudo apt-get install -y zip >/dev/null
  echo "packing $ZIP"; rm -f /tmp/bczta-code.zip
  (cd "$ZIP" && zip -qr /tmp/bczta-code.zip . -x ".git/*" "node_modules/*" "artifacts/*" "cache/*" "besu/networkFiles/*" "besu/nodes/*" "e2e_output/*" "benchmark/output/*")
  ZIP=/tmp/bczta-code.zip
fi
ZONE="${ZONE:-us-central1-a}"
MACHINE_VAL="${MACHINE_VAL:-e2-medium}"; MACHINE_PEP="${MACHINE_PEP:-e2-standard-2}"; MACHINE_CTL="${MACHINE_CTL:-e2-standard-2}"; MACHINE_DIR="${MACHINE_DIR:-e2-standard-2}"
REGION="${ZONE%-*}"
BESU_VERSION="${BESU_VERSION:-26.9.0}"
NETEM_VAL_MS="${NETEM_VAL_MS:-5}"; NETEM_WAN_MS="${NETEM_WAN_MS:-40}"
IAM_REPS="${IAM_REPS:-3}"; FLOOD_REPS="${FLOOD_REPS:-2}"
QUICK="${QUICK:-0}"
# remote paths are relative to the home directory of the VM user
if [ "$QUICK" = "1" ]; then IAM_REPS=1; FLOOD_REPS=1; OUTD="ext_output_quick"; QENV=" QUICK=1"; ARCHIVE_NAME="e2e-ext-quick.tar.gz"
else OUTD="ext_output"; QENV=""; ARCHIVE_NAME="e2e-ext-results.tar.gz"; fi
VMS="val1 val2 val3 val4 pep dir ctl"
SSH="gcloud compute ssh --tunnel-through-iap --zone $ZONE --quiet --ssh-flag=-oServerAliveInterval=30 --ssh-flag=-oStrictHostKeyChecking=no"
SCP="gcloud compute scp --tunnel-through-iap --zone $ZONE --quiet"
sh() { local vm="$1"; shift; $SSH "$vm" --command "$*"; }

echo "== 1/7 enabling API, firewall and NAT   (QUICK=$QUICK, IAM_REPS=$IAM_REPS, FLOOD_REPS=$FLOOD_REPS)"
gcloud services enable compute.googleapis.com >/dev/null
gcloud compute firewall-rules describe bczta-internal >/dev/null 2>&1 || \
  gcloud compute firewall-rules create bczta-internal --network default --allow tcp,udp,icmp --source-ranges 10.128.0.0/9 >/dev/null
gcloud compute firewall-rules describe bczta-iap >/dev/null 2>&1 || \
  gcloud compute firewall-rules create bczta-iap --network default --allow tcp:22 --source-ranges 35.235.240.0/20 >/dev/null
gcloud compute routers describe bczta-router --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute routers create bczta-router --network default --region "$REGION" >/dev/null
gcloud compute routers nats describe bczta-nat --router bczta-router --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute routers nats create bczta-nat --router bczta-router --region "$REGION" --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges >/dev/null

echo "== 2/7 creating VMs in $ZONE (validators $MACHINE_VAL, pep $MACHINE_PEP, ctl $MACHINE_CTL, dir $MACHINE_DIR)"
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
if [ -n "$MISSING" ]; then echo "ERROR: these VMs were not created:$MISSING (vCPU quota?). Fix and run again; existing VMs are reused." >&2; exit 1; fi
DIR_TYPE=$(gcloud compute instances describe dir --zone "$ZONE" --format='get(machineType)' | sed 's#.*/##')
echo "   dir VM is $DIR_TYPE"

echo "== 3/7 waiting for VMs to finish installing Docker and Node"
for vm in $VMS; do
  until sh "$vm" "test -f /var/run/bczta-ready" >/dev/null 2>&1; do sleep 10; done
  echo "   $vm ready"
done
ip_of() { gcloud compute instances describe "$1" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)'; }
IP1=$(ip_of val1); IP2=$(ip_of val2); IP3=$(ip_of val3); IP4=$(ip_of val4); PEP_IP=$(ip_of pep); DIR_IP=$(ip_of dir)
echo "   val: $IP1 $IP2 $IP3 $IP4  pep: $PEP_IP  dir: $DIR_IP"

echo "== 4/7 installing code (ctl, pep, dir), Keycloak + OpenLDAP (dir), Besu image (validators)"
for vm in ctl pep dir; do
  ( $SCP "$ZIP" "$vm:~/code.zip" && sh "$vm" "sudo rm -rf ~/bc && mkdir ~/bc && cd ~/bc && unzip -q ../code.zip && test -f besu/ibftConfigFile.json && npm install --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1 && npx hardhat compile >/dev/null 2>&1 && echo compiled-$vm" ) &
done
for vm in val1 val2 val3 val4; do ( sh "$vm" "sudo docker pull hyperledger/besu:$BESU_VERSION >/dev/null && echo pulled-$vm" ) & done
wait
for vm in ctl pep; do
  sh "$vm" "test -f ~/bc/artifacts/contracts/IdentityRegistry.sol/IdentityRegistry.json && test -d ~/bc/node_modules/ldapts" || { echo "ERROR: code install on $vm failed (npm install / compile)" >&2; exit 1; }
done
sh dir "test -f ~/bc/artifacts/contracts/IdentityRegistry.sol/IdentityRegistry.json" || { echo "ERROR: code install on dir failed" >&2; exit 1; }
sh dir "bash ~/bc/cloud/gcp/remote/dir_iam_setup.sh"

echo "== 5/7 validator keys and genesis, network emulation, control agents"
sh ctl "cd ~/bc/besu && sudo rm -rf networkFiles nodes && sudo docker run --rm --user \"\$(id -u):\$(id -g)\" -v \$PWD:/work -w /work hyperledger/besu:$BESU_VERSION operator generate-blockchain-config --config-file=ibftConfigFile.json --to=networkFiles --private-key-file-name=key >/dev/null && chmod -R a+rX networkFiles && i=1 && for d in networkFiles/keys/*/; do mkdir -p nodes/node\$i && cp \$d/key \$d/key.pub nodes/node\$i/ && chmod 644 nodes/node\$i/* && i=\$((i+1)); done && tar czf ~/chainfiles.tgz networkFiles/genesis.json nodes"
sh ctl "test -s ~/chainfiles.tgz && test -s ~/bc/besu/networkFiles/genesis.json" || { echo "ERROR: key/genesis generation failed on ctl" >&2; exit 1; }
$SCP "ctl:~/chainfiles.tgz" /tmp/chainfiles.tgz
PUB1=$(sh ctl "sed 's/^0x//' ~/bc/besu/nodes/node1/key.pub" | tr -d '\r\n')
for vm in val1 val2 val3 val4; do $SCP /tmp/chainfiles.tgz "$vm:~/chainfiles.tgz"; sh "$vm" "sudo rm -rf ~/bc && mkdir ~/bc && tar xzf ~/chainfiles.tgz -C ~/bc"; done
for vm in val1 val2 val3 val4; do sh "$vm" "IF=\$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p'); sudo tc qdisc replace dev \$IF root netem delay ${NETEM_VAL_MS}ms"; done
sh dir "IF=\$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p'); sudo tc qdisc replace dev \$IF root netem delay ${NETEM_WAN_MS}ms"
for vm in pep dir; do sh "$vm" "pkill -f '^node system/agent.js' || true; pkill -f '^node .*/system/pep.js' || true; sleep 1; cd ~/bc && (CONFIG=\$HOME/agent_config.json nohup node system/agent.js > ~/agent.log 2>&1 &) ; sleep 2; curl -s localhost:9500/health"; echo; done
# the PEP must reach both identity services from its own VM
sh pep "curl -s -o /dev/null -w 'keycloak from pep: %{http_code}\n' http://$DIR_IP:8080/realms/master"
sh pep "node -e \"const n=require('net').connect(389,'$DIR_IP',()=>{console.log('ldap port from pep: open');process.exit(0)});n.on('error',e=>{console.log('ldap port from pep: '+e.message);process.exit(1)})\""

start_chain() {
  local ips=("$IP1" "$IP2" "$IP3" "$IP4") i
  for i in 1 2 3 4; do
    local ip="${ips[$((i-1))]}" boot=""
    [ "$i" -gt 1 ] && boot="--bootnodes=enode://$PUB1@$IP1:30303"
    sh "val$i" "sudo docker rm -f besu >/dev/null 2>&1; sudo rm -rf ~/besu-data; mkdir -p ~/besu-data; chmod 777 ~/besu-data; sudo docker run -d --name besu --network host -v \$HOME/bc/networkFiles/genesis.json:/config/genesis.json:ro -v \$HOME/bc/nodes/node$i:/opt/besu/keys:ro -v \$HOME/besu-data:/opt/besu/data hyperledger/besu:$BESU_VERSION --data-path=/opt/besu/data --node-private-key-file=/opt/besu/keys/key --genesis-file=/config/genesis.json --p2p-host=$ip --p2p-port=30303 $boot --min-gas-price=0 --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-port=8545 --rpc-http-max-active-connections=2000 --rpc-http-api=ETH,NET,WEB3,IBFT,TXPOOL,ADMIN --host-allowlist='*' --rpc-http-cors-origins=all >/dev/null" &
  done
  wait
  echo "   waiting for blocks..."
  local BN=""
  for t in $(seq 1 60); do
    BN=$(sh ctl "curl -s -X POST -H 'Content-Type: application/json' --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}' http://$IP1:8545" 2>/dev/null | sed -n 's/.*"result":"\(0x[0-9a-f]*\)".*/\1/p') || true
    if [ -n "${BN:-}" ] && [ $((BN)) -ge 3 ]; then echo "   block $((BN)) reached"; return; fi
    sleep 5
  done
  echo "chain did not start" >&2; exit 1
}

ENVS="RPC_URL=http://$IP1:8545 AGENT_PEP=http://$PEP_IP:9500 AGENT_DIR=http://$DIR_IP:9500 PEP_HOST=$PEP_IP KC_URL=http://$DIR_IP:8080 LDAP_URL=ldap://$DIR_IP:389 DEPLOYMENT=gcp-7vm NETEM_WAN_MS=$NETEM_WAN_MS NETEM_VAL_MS=$NETEM_VAL_MS$QENV"
sh ctl "mkdir -p ~/$OUTD"

# run_job NAME RESULT_FILE "extra env" script.js
run_job() {
  local name="$1" resf="$2" extra="$3" js="$4"
  if sh ctl "test -s ~/$OUTD/$name/$resf" >/dev/null 2>&1; then echo "-- $name already finished, skipping"; return; fi
  echo "-- $name: fresh chain ($(date +%H:%M))"
  sh ctl "pkill -f '^node system/run_iam.js' || true; pkill -f '^node system/run_flood.js' || true; rm -rf ~/$OUTD/$name ~/$OUTD/$name.done ~/$OUTD/$name.log" >/dev/null 2>&1 || true
  start_chain
  sh ctl "cd ~/bc && (env $ENVS $extra OUT=\$HOME/$OUTD/$name nohup node system/$js > \$HOME/$OUTD/$name.log 2>&1; echo \$? > \$HOME/$OUTD/$name.done) > /dev/null 2>&1 &"
  until sh ctl "test -f ~/$OUTD/$name.done" >/dev/null 2>&1; do sleep 45; printf "."; done
  echo
  sh ctl "tail -4 ~/$OUTD/$name.log | cut -c1-220" || true
  if ! sh ctl "test -s ~/$OUTD/$name/$resf" >/dev/null 2>&1; then
    echo "ERROR: $name produced no result file; log tail:" >&2; sh ctl "tail -25 ~/$OUTD/$name.log | cut -c1-250" >&2 || true
    echo "Fix the cause, then start run_ext.sh again (finished runs are skipped)." >&2; exit 1
  fi
}

echo "== 6/7 experiments"
for r in $(seq 1 "$IAM_REPS"); do
  run_job "iam_r$r" iam_results.json "" run_iam.js
  if [ "$r" -le "$FLOOD_REPS" ]; then
    for m in bczta bcsync; do run_job "flood_${m}_r$r" flood_results.json "MODE=$m" run_flood.js; done
  fi
done

echo "== 7/7 collecting results"
sh ctl "cd ~/$OUTD && find . -name config.json -delete; echo \"gcp 7 VMs (val $MACHINE_VAL, pep $MACHINE_PEP, ctl $MACHINE_CTL, dir $DIR_TYPE), zone $ZONE, besu $BESU_VERSION, keycloak 26.4.0 dev-mode (Docker), OpenLDAP slapd (Debian 12), netem validators ${NETEM_VAL_MS}ms, directory/IAM ${NETEM_WAN_MS}ms, quick=$QUICK\" > environment.txt; cd ~ && tar czf $ARCHIVE_NAME $OUTD"
sh ctl "test -s ~/$ARCHIVE_NAME" || { echo "ERROR: archive was not created" >&2; exit 1; }
$SCP "ctl:~/$ARCHIVE_NAME" "$HOME/$ARCHIVE_NAME"
echo
echo "DONE. Results: ~/$ARCHIVE_NAME   (Cloud Shell menu -> Download -> that path), then attach it in the chat."
if [ "$QUICK" = "1" ]; then echo "This was the QUICK shakedown. If it ended with DONE and no errors, start the real run:  nohup ./run_ext.sh > ~/ext.log 2>&1 &   (the VMs are reused)"; fi
echo "IMPORTANT: when everything is finished run ./cleanup.sh to delete the VMs and stop all charges."
