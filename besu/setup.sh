#!/usr/bin/env bash
# Generates the IBFT 2.0 genesis + 4 validator keys with Besu's own tool, then writes .env for docker-compose.
# Requires Docker. Run once:  ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
BESU_VERSION="${BESU_VERSION:-latest}"
rm -rf networkFiles nodes
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work "hyperledger/besu:${BESU_VERSION}" \
  operator generate-blockchain-config --config-file=ibftConfigFile.json --to=networkFiles --private-key-file-name=key
i=1
for d in networkFiles/keys/*/; do
  mkdir -p "nodes/node$i"
  cp "$d/key" "$d/key.pub" "nodes/node$i/"
  chmod 644 "nodes/node$i/key" "nodes/node$i/key.pub"
  i=$((i + 1))
done
PUB="$(sed 's/^0x//' nodes/node1/key.pub)"
cat > .env <<EOF
BESU_VERSION=${BESU_VERSION}
BOOTNODE=enode://${PUB}@172.30.0.11:30303
EOF
echo "Generated $((i - 1)) validator keys and networkFiles/genesis.json."
echo "Next: docker compose up -d   (then ./check.sh)"
