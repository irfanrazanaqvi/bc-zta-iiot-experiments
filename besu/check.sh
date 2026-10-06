#!/usr/bin/env bash
# Confirms the network is up: block number, peer count and validator set (expects 4).
for p in 8545 8546 8547 8548; do
  echo "--- node on :$p"
  for m in eth_blockNumber net_peerCount; do
    curl -s -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"method\":\"$m\",\"params\":[],\"id\":1}" localhost:$p; echo
  done
done
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"ibft_getValidatorsByBlockNumber","params":["latest"],"id":1}' localhost:8545; echo
