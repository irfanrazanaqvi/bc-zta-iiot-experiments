// Deploys the four BC-ZTA smart-contract modules (Table II of the paper)
// and wires them together: IdentityRegistry -> TrustReputation ->
// AccessControl -> AuditLog.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network hardhat   (local test net)
//   npx hardhat run scripts/deploy.js --network besu      (real Besu/IBFT 2.0)

const hre = require("hardhat");

async function main() {
  const [deployer, v1, v2, v3] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy(deployer.address);
  await identityRegistry.waitForDeployment();
  console.log("IdentityRegistry:", await identityRegistry.getAddress());

  const TrustReputation = await hre.ethers.getContractFactory("TrustReputation");
  const validators = [v1.address, v2.address, v3.address];
  const trustReputation = await TrustReputation.deploy(validators, 2); // quorum = 2 of 3
  await trustReputation.waitForDeployment();
  console.log("TrustReputation:", await trustReputation.getAddress());

  const AccessControl = await hre.ethers.getContractFactory("AccessControl");
  const accessControl = await AccessControl.deploy(
    await identityRegistry.getAddress(),
    await trustReputation.getAddress()
  );
  await accessControl.waitForDeployment();
  console.log("AccessControl:", await accessControl.getAddress());

  const AuditLog = await hre.ethers.getContractFactory("AuditLog");
  const auditLog = await AuditLog.deploy();
  await auditLog.waitForDeployment();
  console.log("AuditLog:", await auditLog.getAddress());

  console.log("\nDeployment complete. Save these addresses for the edge-gateway PEP/PDP client.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
