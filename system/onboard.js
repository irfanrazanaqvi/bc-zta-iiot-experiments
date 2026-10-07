// Deploys the four contracts on the target chain and onboards the device population (identity registry,
// one Merkle epoch commitment, ABAC policy, trust scores). Returns the public config consumed by the PEP.
const { h, artifact, IFACES, merkle, ethers, sleep } = require("./lib");

const DEPLOYER_KEY = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const devKey = (name) => h("bc-zta-device-" + name);
const senderKey = (i) => h("bc-zta-pep-sender-" + i);

async function onboard({ rpcUrl, nLoad, variants, nRev, log = console.log }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
  const dAddr = await deployer.getAddress();
  const fd = await provider.getFeeData();
  const fee = fd.maxFeePerGas != null ? { type: 2, maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 0n } : { type: 0, gasPrice: fd.gasPrice };
  const feeSend = fee.type === 2 ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : { gasPrice: fee.gasPrice };

  const dep = async (name, ...args) => {
    const a = artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args, feeSend);
    await c.waitForDeployment();
    return c;
  };
  const IR = await dep("IdentityRegistry", dAddr);
  const TR = await dep("TrustReputation", [dAddr], 1);
  const AC = await dep("AccessControl", await IR.getAddress(), await TR.getAddress());
  const AL = await dep("AuditLog");
  const addrs = { IR: await IR.getAddress(), TR: await TR.getAddress(), AC: await AC.getAddress(), AL: await AL.getAddress() };
  log("deployed", JSON.stringify(addrs));

  // population: load devices, per-variant revocation devices, attack devices
  const names = [];
  for (let i = 0; i < nLoad; i++) names.push({ name: "load-" + i, cls: i % 10 === 9 ? 1 : 0 });
  for (const v of variants) for (let j = 0; j < nRev; j++) names.push({ name: `rev-${v}-${j}`, cls: 0 });
  names.push({ name: "atk-revoked", cls: 0 }, { name: "atk-lowtrust", cls: 0 }, { name: "atk-class3", cls: 3 }, { name: "atk-tamper", cls: 0 }, { name: "atk-replay", cls: 0 }, { name: "atk-legit", cls: 0 });
  const devices = names.map((d) => { const w = new ethers.Wallet(devKey(d.name)); return { ...d, wallet: w, did: h("did:iiot:" + d.name), pkh: ethers.keccak256(w.address) }; });

  const RES = h("resource:plc-setpoint");
  const policy = { minClass: 0, maxClass: 1, minTrust: 50, ttl: 300 };
  await (await AC.setPolicy(RES, policy.minClass, policy.maxClass, policy.minTrust, policy.ttl, feeSend)).wait();

  const CH = Number(process.env.ONBOARD_CHUNK || 40);
  for (let i = 0; i < devices.length; i += CH) {
    await Promise.all(devices.slice(i, i + CH).map((d) => IR.registerDID(d.did, d.pkh, d.cls, feeSend).then((t) => t.wait())));
  }
  const epoch = Number(await IR.currentEpoch());
  const tree = merkle(devices.map((d) => d.did));
  await (await IR.commitEpoch(tree.root, devices.length, feeSend)).wait();
  devices.forEach((d, i) => (d.proof = tree.proofs[i]));
  const lowTrust = devices.find((d) => d.name === "atk-lowtrust");
  await (await TR.updateScore(lowTrust.did, 20, feeSend)).wait();
  log(`onboarded ${devices.length} devices, epoch ${epoch}, root ${tree.root.slice(0, 12)}…`);

  // fund PEP sender wallets
  const senders = Array.from({ length: 8 }, (_, i) => new ethers.Wallet(senderKey(i)));
  for (const s of senders) await (await deployer.sendTransaction({ to: s.address, value: ethers.parseEther("10"), ...feeSend })).wait();
  const spam = Array.from({ length: 8 }, (_, i) => new ethers.Wallet(h("bc-zta-spam-" + i)));
  for (const s of spam) await (await deployer.sendTransaction({ to: s.address, value: ethers.parseEther("10"), ...feeSend })).wait();
  const authorityKey = DEPLOYER_KEY;

  const config = {
    rpc: rpcUrl, chainId: Number(net.chainId), fee: { type: fee.type, ...(fee.type === 2 ? { maxFeePerGas: fee.maxFeePerGas.toString(), maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString() } : { gasPrice: fee.gasPrice.toString() }) },
    addrs, epoch, root: tree.root, resource: RES, policy, senderKeys: senders.map((s) => s.privateKey),
    devices: devices.map((d) => ({ name: d.name, did: d.did, pkh: d.pkh, cls: d.cls, proof: d.proof })),
  };
  return { config, devices, spamKeys: spam.map((s) => s.privateKey), authorityKey, contracts: { IR, TR, AC, AL }, deployer, feeSend };
}
module.exports = { onboard, devKey, DEPLOYER_KEY };
