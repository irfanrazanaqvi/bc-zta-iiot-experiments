// Measures gas used by each principal contract function on an in-process Hardhat
// (EVM, london) network and writes simulation/output/gas_measurements.json.
// Run:  npx hardhat run scripts/measure_gas.js --network hardhat
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers } = hre;
  const [owner, v1, v2, v3] = await ethers.getSigners();
  const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const DID = h("did:iiot:plc-001"), RES = h("resource:assembly-cell-actuator"), PK = h("pubkey-001");

  const IR = await (await ethers.getContractFactory("IdentityRegistry")).deploy(owner.address);
  const TR = await (await ethers.getContractFactory("TrustReputation")).deploy([v1.address, v2.address, v3.address], 2);
  const AC = await (await ethers.getContractFactory("AccessControl")).deploy(await IR.getAddress(), await TR.getAddress());
  const AL = await (await ethers.getContractFactory("AuditLog")).deploy();

  const out = {};
  const gas = async (name, txp) => { const r = await (await txp).wait(); out[name] = Number(r.gasUsed); };

  await gas("IdentityRegistry.registerDID", IR.registerDID(DID, PK, 0));
  await gas("IdentityRegistry.updateKey", IR.updateKey(DID, h("pubkey-002")));
  await gas("IdentityRegistry.commitEpoch", IR.commitEpoch(h("root"), 1));
  await gas("IdentityRegistry.revokeDID", IR.revokeDID(DID));
  await IR.registerDID(h("did:iiot:plc-002"), PK, 0);
  const DID2 = h("did:iiot:plc-002");

  await gas("AccessControl.setPolicy", AC.setPolicy(RES, 0, 1, 50, 300));
  out["AccessControl.evaluateRequest (view, estimateGas)"] = Number(await AC.evaluateRequest.estimateGas(DID2, RES, 0));
  await gas("AccessControl.grantSession", AC.grantSession(DID2, RES, 0));

  await gas("TrustReputation.updateScore (first vote)", TR.connect(v1).updateScore(DID2, 90));
  await gas("TrustReputation.updateScore (quorum reached)", TR.connect(v2).updateScore(DID2, 90));
  await gas("TrustReputation.flagAnomaly", TR.connect(v1).flagAnomaly(h("did:iiot:plc-003"), "anomalous command pattern"));

  await gas("AuditLog.logEvent", AL.logEvent(DID2, RES, 1));
  await gas("AuditLog.anchorBatch", AL.anchorBatch(h("batch-root"), 1000));

  const dir = path.join(__dirname, "..", "simulation", "output");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gas_measurements.json"), JSON.stringify({ evm: "london", optimizer_runs: 200, gas_used: out }, null, 2));
  console.table(out);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
