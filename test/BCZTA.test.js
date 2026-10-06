const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BC-ZTA smart-contract suite", function () {
  let identityRegistry, trustReputation, accessControl, auditLog;
  let owner, v1, v2, v3, device1;
  const DID = ethers.keccak256(ethers.toUtf8Bytes("did:iiot:plc-001"));
  const RESOURCE = ethers.keccak256(ethers.toUtf8Bytes("resource:assembly-cell-actuator"));

  beforeEach(async function () {
    [owner, v1, v2, v3, device1] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistry.deploy(owner.address);

    const TrustReputation = await ethers.getContractFactory("TrustReputation");
    trustReputation = await TrustReputation.deploy([v1.address, v2.address, v3.address], 2);

    const AccessControl = await ethers.getContractFactory("AccessControl");
    accessControl = await AccessControl.deploy(
      await identityRegistry.getAddress(),
      await trustReputation.getAddress()
    );

    const AuditLog = await ethers.getContractFactory("AuditLog");
    auditLog = await AuditLog.deploy();
  });

  it("registers a DID and marks it active", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0); // deviceClass 0 = PLC
    expect(await identityRegistry.isActive(DID)).to.equal(true);
  });

  it("revokes a DID", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);
    await identityRegistry.revokeDID(DID);
    expect(await identityRegistry.isActive(DID)).to.equal(false);
  });

  it("denies access before a policy exists", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);
    const granted = await accessControl.evaluateRequest(DID, RESOURCE, 0);
    expect(granted).to.equal(false);
  });

  it("grants a time-bound session once policy + trust score are sufficient", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);

    // minClass=0, maxClass=1, minTrust=50, ttl=300s
    await accessControl.setPolicy(RESOURCE, 0, 1, 50, 300);

    // default trust score is 70 (>= 50), so access should be granted
    const tx = await accessControl.grantSession(DID, RESOURCE, 0);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);
  });

  it("reaches quorum before updating a trust score", async function () {
    await trustReputation.connect(v1).updateScore(DID, 90);
    expect(await trustReputation.getScore(DID)).to.equal(70); // still default, 1/2 quorum
    await trustReputation.connect(v2).updateScore(DID, 90);
    expect(await trustReputation.getScore(DID)).to.equal(90); // quorum reached
  });

  it("penalizes trust score on anomaly flag", async function () {
    await trustReputation.connect(v1).flagAnomaly(DID, "unexpected command sequence");
    expect(await trustReputation.getScore(DID)).to.equal(50); // 70 - 20
  });

  it("logs and retrieves audit events", async function () {
    await auditLog.logEvent(DID, RESOURCE, 1); // eventType 1 = authz
    const trail = await auditLog.getAuditTrail(DID);
    expect(trail.length).to.equal(1);
    const entry = await auditLog.getEntry(trail[0]);
    expect(entry.did).to.equal(DID);
  });

  it("keeps a fully penalized score at 0 instead of resetting to the default", async function () {
    // 70 -> 50 -> 30 -> 10 -> 0 (floor); repeated anomalies must not restore trust
    for (let i = 0; i < 4; i++) {
      await trustReputation.connect(v1).flagAnomaly(DID, "repeated anomaly");
    }
    expect(await trustReputation.getScore(DID)).to.equal(0);
  });

  it("denies access once trust falls below the policy threshold", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);
    await accessControl.setPolicy(RESOURCE, 0, 1, 60, 300);
    expect(await accessControl.evaluateRequest(DID, RESOURCE, 0)).to.equal(true);
    await trustReputation.connect(v1).flagAnomaly(DID, "anomalous command pattern"); // 70 -> 50
    expect(await accessControl.evaluateRequest(DID, RESOURCE, 0)).to.equal(false);
  });

  it("denies access for a revoked DID even with a sufficient trust score", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);
    await accessControl.setPolicy(RESOURCE, 0, 1, 50, 300);
    await identityRegistry.revokeDID(DID);
    expect(await accessControl.evaluateRequest(DID, RESOURCE, 0)).to.equal(false);
  });

  it("expires a granted session after its TTL", async function () {
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-plc-001"));
    await identityRegistry.registerDID(DID, pubKeyHash, 0);
    await accessControl.setPolicy(RESOURCE, 0, 1, 50, 300);
    const tx = await accessControl.grantSession(DID, RESOURCE, 0);
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => { try { return accessControl.interface.parseLog(l); } catch (e) { return null; } })
      .find((e) => e && e.name === "SessionGranted");
    const sessionId = ev.args.sessionId;
    expect(await accessControl.isSessionValid(sessionId)).to.equal(true);
    await time.increase(301);
    expect(await accessControl.isSessionValid(sessionId)).to.equal(false);
  });

  it("rate-limits trust updates and rejects non-validators", async function () {
    await trustReputation.connect(v1).updateScore(DID, 90);
    await trustReputation.connect(v2).updateScore(DID, 90); // quorum -> finalized
    await expect(trustReputation.connect(v1).updateScore(DID, 95)).to.be.revertedWith("TrustReputation: rate limited");
    await expect(trustReputation.connect(device1).updateScore(DID, 50)).to.be.revertedWith("TrustReputation: not validator");
  });

  it("verifies epoch Merkle membership proofs", async function () {
    const leafA = ethers.keccak256(ethers.toUtf8Bytes("did:iiot:a"));
    const leafB = ethers.keccak256(ethers.toUtf8Bytes("did:iiot:b"));
    const root = leafA < leafB
      ? ethers.keccak256(ethers.concat([leafA, leafB]))
      : ethers.keccak256(ethers.concat([leafB, leafA]));
    await identityRegistry.commitEpoch(root, 2);
    expect(await identityRegistry.verifyMembership(leafA, 0, [leafB])).to.equal(true);
    expect(await identityRegistry.verifyMembership(leafB, 0, [leafA])).to.equal(true);
    const outsider = ethers.keccak256(ethers.toUtf8Bytes("did:iiot:evil"));
    expect(await identityRegistry.verifyMembership(outsider, 0, [leafB])).to.equal(false);
  });

  it("rejects unauthorized registrations", async function () {
    const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("pubkey-x"));
    await expect(identityRegistry.connect(device1).registerDID(DID, pubKeyHash, 0))
      .to.be.revertedWith("IdentityRegistry: not authority");
  });

  it("anchors an audit batch root and verifies record membership", async function () {
    const a = ethers.keccak256(ethers.toUtf8Bytes("audit-record-a"));
    const b = ethers.keccak256(ethers.toUtf8Bytes("audit-record-b"));
    const root = a < b ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a]));
    await auditLog.anchorBatch(root, 2);
    expect(await auditLog.totalAnchors()).to.equal(1);
    expect(await auditLog.verifyInBatch(a, 0, [b])).to.equal(true);
    const forged = ethers.keccak256(ethers.toUtf8Bytes("forged-record"));
    expect(await auditLog.verifyInBatch(forged, 0, [b])).to.equal(false);
    await expect(auditLog.anchorBatch(root, 0)).to.be.revertedWith("AuditLog: empty batch");
  });
});
