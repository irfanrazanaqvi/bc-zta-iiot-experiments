const fs = require('fs');
const path = require('path');
const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  BorderStyle, ShadingType, ExternalHyperlink, SectionType, Footer, PageNumber, VerticalAlign, TableLayoutType } = docx;
const REFS = require('./refs.js');
const RES = JSON.parse(fs.readFileSync('/tmp/claude-0/work/pkg/code_package/simulation/output/raw_results.json'));
const FIG = '/tmp/claude-0/work/figs/';
const OUT = process.argv[2] || '/tmp/claude-0/work/out/paper.docx';

const FONT = 'Times New Roman';
const BODY = 20;        // half-points (9.5 pt)
const SMALL = 15;       // 7.5 pt
const COLW = 4860;      // one column in dxa (3.375")

// ---------------- citation engine (numbers = order of first appearance) -------------
const order = [];
function num(k) {
  if (!REFS[k]) throw new Error('unknown ref ' + k);
  let i = order.indexOf(k);
  if (i < 0) { order.push(k); i = order.length - 1; }
  return i + 1;
}
function cite(keys) {
  const ns = keys.map(num).sort((a, b) => a - b);
  // IEEE: collapse runs of >=3 consecutive numbers
  const parts = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    if (j - i >= 2) parts.push(`[${ns[i]}]–[${ns[j]}]`);
    else for (let k = i; k <= j; k++) parts.push(`[${ns[k]}]`);
    i = j + 1;
  }
  return parts.join(', ');
}


const ROM=['','I','II','III','IV','V','VI','VII','VIII','IX','X'];
const LET='ABCDEFGHIJKL';
const TORDER=['related','iface','threat','params','lat','besu','gas','sec','fault','iam','outage','flood','push','cut','scale'];
function fixTab(t){return t.replace(/(TABLE|Table) @(\w+)/g,(m,w,k)=>w+' '+(TORDER.indexOf(k)+1));}
function fixSec(t){return t.replace(/Section (\d+)(?:\.(\d+))?/g,(m,a,b)=>'Section '+ROM[+a]+(b?'-'+LET[+b-1]:''));}
// ---------------- inline markup: **bold**, *italic*, {{ref1,ref2}} -----------------------
const HAVE_XR = !!XR_EXISTS();
function XR_EXISTS() { try { return require('fs').existsSync(process.env.ROBUST_JSON || '/tmp/claude-0/full/agg2/aggregate_robust.json'); } catch (e) { return false; } }
const DISC = HAVE_XR ? '6.12' : '6.11';
function tok(t) {
  return t.replace(/\[\[(\w+)\]\]/g, (m, k) => ({
    DISC: 'Section ' + DISC,
    S12K: HAVE_XR ? 'the *k* = 2 rule is evaluated in Section 6.10' : 'the *k* = 2 rule is described here but was not evaluated in this version of the paper',
    S12Q: HAVE_XR ? 'the cost of the quorum is reported in Section 6.10' : 'the cost of the quorum was not measured in this version of the paper',
    S12R: HAVE_XR ? '(Section 6.10)' : '(this case was not tested)',
    S12O: HAVE_XR ? '(Section 6.10)' : '(not tested in this version of the paper)',
  }[k] ?? m));
}
function runs(text, o = {}) {
  text = fixTab(fixSec(tok(text)));
  const out = [];
  const re = /(\{\{[^}]+\}\}|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const base = { font: FONT, size: o.size || BODY, bold: o.bold, italics: o.italics };
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const t = m[0];
    if (t.startsWith('{{')) out.push(new TextRun({ ...base, text: cite(t.slice(2, -2).split(',').map(s => s.trim())) }));
    else if (t.startsWith('**')) out.push(new TextRun({ ...base, text: t.slice(2, -2), bold: true }));
    else out.push(new TextRun({ ...base, text: t.slice(1, -1), italics: true }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ ...base, text: text.slice(last) }));
  return out;
}
const P = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { after: o.after ?? 60, before: o.before ?? 0, line: o.line || 228 },
  indent: o.indent, keepNext: o.keepNext, keepLines: o.keepLines,
  children: runs(t, o),
});
const H1 = t => new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 60 },
  children: [new TextRun({ text: t.replace(/^(\d+)\.\s*/, (m,a)=>ROM[+a]+'. ').toUpperCase(), font: FONT, size: 18 })] });
const H2 = t => new Paragraph({ alignment: AlignmentType.LEFT, keepNext: true, spacing: { before: 60, after: 30 },
  children: [new TextRun({ text: t.replace(/^(\d+)\.(\d+)\s*/, (m,a,b)=>LET[+b-1]+'. '), font: FONT, size: BODY, italics: true })] });
const BUL = (t) => P(t, { indent: { left: 200, hanging: 200 }, after: 30 });

// ---------------- figures & tables -----------------------------------------------------
function fig(file, caption, wPx) {
  const sz = require('child_process').execSync(`python3 -c "from PIL import Image;im=Image.open('${FIG + file}');print(im.size[0],im.size[1])"`).toString().trim().split(' ').map(Number);
  const h = Math.round(wPx * sz[1] / sz[0]);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 40, after: 20 },
      children: [new ImageRun({ type: 'png', data: fs.readFileSync(FIG + file), transformation: { width: wPx, height: h },
        altText: { title: caption, description: caption, name: file } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: runs(caption, { size: 16 }) }),
  ];
}
const bd = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
function table(caption, widths, header, rows, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (t, w, hdr, i, last) => new TableCell({
    width: { size: w, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    margins: { top: 20, bottom: 20, left: 40, right: 40 },
        borders: { top: hdr ? bd : nb, bottom: (hdr || last) ? bd : nb, left: nb, right: nb },
    children: [new Paragraph({ keepNext: !last || !!o.note, alignment: (i === 0 || o.left) ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { after: 0, line: 200 },
      children: runs(String(t), { size: o.size || SMALL, bold: hdr }) })],
  });
  const trs = [new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, widths[i], true, i)) })]
    .concat(rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i], false, i, ri === rows.length - 1)) })));
  const out = [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 60, after: 30 }, children: runs(caption, { size: 16 }) }),
    new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: trs }),
  ];
  if (o.note) out.push(new Paragraph({ spacing: { before: 20, after: 80 }, alignment: AlignmentType.JUSTIFIED, children: runs(o.note, { size: 14 }) }));
  else out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
  return out;
}

// ---------------- numbers from the experiment outputs ---------------------------------
const e = (sy, n) => E.E1[sy].find(r => r.devices === n);
const L = RES.latency_ref_devices; const MS = RES.measured; const S3 = MS.S3_per_event_logging; const s3 = t => S3.find(r => r.offered_tps === t); const REFN = RES.ref_devices;
const A = L['Centralized PKI-IAM'], B = L['ABAC (no BC)'], C = L['Blockchain-only (sync)'], Z = L['Proposed BC-ZTA'];
const X = JSON.parse(fs.readFileSync('/tmp/claude-0/full/agg/aggregate_ext.json', 'utf8'));
const XRPATH = process.env.ROBUST_JSON || '/tmp/claude-0/full/agg2/aggregate_robust.json';
const XR = fs.existsSync(XRPATH) ? JSON.parse(fs.readFileSync(XRPATH, 'utf8')) : null;
const E = JSON.parse(fs.readFileSync('/tmp/claude-0/work/pkg/code_package/simulation/output/aggregate_e2e.json', 'utf8'));
const ANCH = RES.gas_per_record.anchorBatch_per_record_at_1000 * 1000;           // gas of one anchorBatch transaction (independent of batch size)
const gasRatio = b => RES.gas_per_record.logEvent_per_record / (ANCH / b);
const T95 = { 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776 };                     // two-sided 95% Student t, n runs
const ci = (sd, n) => T95[n] * sd / Math.sqrt(n);
const f1 = x => x.toFixed(1), f0 = x => Math.round(x).toString(), f2 = x => x.toFixed(2);
const pct = (a, b) => f0(100 * (1 - a / b));
const G = RES.gas_used;
const gk = k => Object.keys(G).find(x => x.startsWith(k));
const gas = k => G[gk(k)].toLocaleString('en-US');
const RD = RES.revocation_delay;
const AG = RES.audit_growth_400_devices;
const PR = RES.params;

// =================================== CONTENT ==========================================
const body = [];     // two-column part, built strictly in reading order
const push = (...x) => x.forEach(y => Array.isArray(y) ? body.push(...y) : body.push(y));

// ---- 1 INTRODUCTION
push(H1('1. Introduction'));
push(H2('1.1 IIoT Security Background'));
push(P('The Industrial Internet of Things (IIoT) interconnects programmable logic controllers, sensors, actuators, edge gateways and cloud analytics in smart manufacturing, energy and process-control plants. Historically these operational-technology (OT) networks relied on a hardened perimeter and implicit trust between devices on the same segment. As OT converges with IT and remote maintenance becomes routine, that perimeter dissolves, and a single compromised vendor laptop or sensor can become a foothold for lateral movement {{federici,zanasi}}. Zero Trust Architecture (ZTA), formalised in NIST SP 800-207 {{nist}}, replaces location-based trust with per-request verification, and recent systematic reviews confirm its rapid uptake across domains {{gambo,mushtaq,azad}}.'));
push(H2('1.2 Security Challenges'));
push(P('Four properties make IIoT hard to secure. (i) *Constrained devices* cannot run heavy cryptography or continuous agents; (ii) *heterogeneity* of protocols and vendors complicates uniform identity management {{mthethwa,asim}}; (iii) *hard real-time budgets* leave only milliseconds for a security decision; and (iv) *scale*, with thousands of devices that join, rotate keys and are revoked continuously. A centralised identity or policy server is both a single point of failure and a high-value target, and conventional logs held by that same operator are not independently trustworthy {{mushtaq}}.'));
push(H2('1.3 Zero-Trust Requirements'));
push(P('Following NIST SP 800-207 {{nist}} and critical analyses of ZTA {{fernandez}}, an IIoT deployment needs: **R1** strong, per-device cryptographic identity; **R2** per-request authorisation by a policy decision point (PDP) enforced by a policy enforcement point (PEP); **R3** least-privilege, short-lived sessions; **R4** continuous trust assessment from behavioural and posture signals {{ma}}; **R5** micro-segmentation and containment; and **R6** tamper-evident audit. R1–R5 must be satisfied within control-loop latency budgets.'));
push(H2('1.4 Role of Blockchain'));
push(P('A permissioned blockchain offers a shared, tamper-evident source of truth among mutually distrusting plant, vendor and integrator domains: a decentralised identity registry, policy and reputation state governed by smart contracts, and an immutable audit trail. Prior work has applied it to zero-trust IoT access {{aleisa,nie}}, cross-domain digital-twin access {{ali}}, IIoT data protection {{essaid}} and contract-based access control {{li_hyper,guo}}.'));
push(H2('1.5 Research Gap'));
push(P('Despite this progress, three gaps remain. First, many designs place the ledger *on the request path*; a published Ethereum-based zero-trust framework, for instance, reports latency growing from 49.33 ms to 74.0 ms and throughput falling from 50 to 30.77 req/s {{singh}}. Second, scalability is seldom evaluated for authentication and authorisation workloads, with notable exceptions that rely on sharding {{salim}}; most studies evaluate accuracy or encryption cost {{sharma,mishra}}. Third, continuous tamper-proof audit logging, repeatedly named as an open gap {{mushtaq}}, is expensive when every event is written on-chain.'));
push(H2('1.6 Research Objectives'));
push(P('We aim to (O1) design a blockchain-assisted ZTA whose per-request decisions do not wait for consensus; (O2) bound the resulting staleness of revocation and trust state; (O3) make audit anchoring cost sub-linear in the event rate; and (O4) evaluate latency, on-chain load, gas cost and revocation delay against five baselines, two of them real identity products.'));
push(H2('1.7 Contributions'));
push(BUL('•  **Architecture.** A three-tier BC-ZTA in which the PEP/PDP decide from edge-cached, Merkle-verified ledger state, so the blockchain is *off* the request path (Section 3).'));
push(BUL('•  **Smart contracts.** Four Solidity contracts (identity registry with epoch commitments, quorum-based trust reputation, ABAC access control, audit log with Merkle batch anchoring), compiled and unit-tested with 15 passing tests.'));
push(BUL('•  **End-to-end prototype and measurements.** A running PEP/PDP service, five baselines (a centralised directory, local ABAC, a synchronous blockchain, and real Keycloak and OpenLDAP services, the latter two with and without PEP-side caching) and a load generator, evaluated on a seven-VM Google Cloud deployment with a four-validator Hyperledger Besu IBFT 2.0 network in five repetitions: latency and goodput up to 200 devices, revocation delay, security tests, a validator-failure test, a central-service outage test, a ledger-flood sweep and gas (Sections 5–6).'));
push(BUL('•  **Security analysis and limits.** A property-by-property argument under explicit assumptions, with the residual risks we found (replay across gateways, trust in a single ledger node, audit completeness; Section 4.6), and a measured comparison that shows where the ledger does and does not help (Section 6.8).'));
push(BUL('•  **Bounded-staleness analysis.** Event-driven invalidation reduces mean revocation delay from ' + f1(E.E2['bczta-ttl'].mean_ms / 1000) + ' s to ' + f1(E.E2['bczta-events'].mean_ms / 1000) + ' s (Section 6.6).'));
push(P('The remainder of the paper reviews related work (Section 2), presents the architecture (Section 3), the use case and threat model (Section 4), the methodology (Section 5), results (Section 6) and conclusions (Section 7).', { before: 30 }));

// ---- 2 RELATED WORK
push(H1('2. Related Work'));
push(H2('2.1 Blockchain-Based IIoT Security'));
push(P('Essaid and Ju combine blockchain, edge computing and smart contracts for IIoT data integrity and threat detection {{essaid}}. Hyper-IIoT proposes a smart-contract-inspired access-control scheme for resource-constrained devices {{li_hyper}}, and formal model checking of IoT access-control contracts has been explored {{guo}}. Lightweight authentication using blockchain and Chebyshev chaotic maps targets cross-domain IIoT {{zhai}}. For identity, Asim *et al.* use epoch-based batch registration with sparse Merkle trees to support up to 7,000 devices over 20 fog nodes with under 5 MB on-chain overhead {{asim}}, and IOTA-based decentralised identifiers have been prototyped on Raspberry Pi 4 devices, with CPU load peaking during DID generation {{ramirez}}. DAG ledgers have been proposed for scalability and privacy in intelligent buildings {{naqvi}}, and a smart-city trust framework reports 450–500 tps with a lightweight adaptive PoS {{islam}}.'));
push(H2('2.2 Zero-Trust IIoT Security'));
push(P('Federici *et al.* design a zero-trust remote-access architecture for IIoT {{federici}}, and Zanasi *et al.* a flexible architecture combining micro-segmentation, SDN and a central policy layer {{zanasi}}. Ma and Chiu propose a risk-based access-control engine with continuous neighbour-trust assessment for IoT {{ma}}; Mthethwa *et al.* address non-human identities {{mthethwa}}. Broader treatments include a ZTA framework for next-generation IoT {{rani}}, trust-driven adaptive edge resource management that lowers latency by 28.7% against cloud processing {{chella}}, and zero-trust foundation models for IoT AI {{li_ztfm}}. Surveys summarise applications and challenges {{ghasemshirazi}}.'));
push(H2('2.3 Blockchain-Assisted Zero Trust'));
push(P('Aleisa couples blockchain-enabled ZTA with post-quantum and zero-knowledge techniques, reporting 98% privacy preservation {{aleisa}}. Nie *et al.* use smart contracts and inner-product encryption for 6G IoT access control, with 14% higher encryption efficiency and 18% lower access latency {{nie}}. Sharma *et al.* add federated transfer learning for Industry 5.0 {{sharma}}, and Mishra *et al.* a zero-trust digital twin with hash-chained lightweight blockchain auditing and deep-learning intrusion detection {{mishra}}. Salim *et al.* reach 2,500 TPS at 700 nodes through DRL-driven sharding {{salim}}. Domain variants exist for FinTech {{singh}}, clinical trials with T-PBFT {{peepliwal}} and FPGA supply chains {{kulkarni}}.'));
push(H2('2.4 Non-Blockchain Foundations and Alternatives'));
push(P('Several mechanisms used here, and several competing designs, do not need a blockchain. Revocation on the web is handled by CRLs {{rfc5280}} and OCSP {{rfc6960}}, where a server can staple a signed status response to the handshake {{rfc6066}}; a central authority that pushes signed revocations to edge enforcement points is therefore a natural alternative to event-driven invalidation from a ledger. Audit logs that can be checked by third parties are provided by Merkle-tree transparency logs such as Certificate Transparency {{rfc6962}}, which rely on log operators and monitors rather than a consensus protocol. Decentralised identifiers (DIDs) {{did}} define identifiers whose control is separated from any registry operator, and blockchain-based access control for IoT, from FairAccess {{ouaddah}} to scalable management architectures {{novo}}, places the policy decision or the policy store on the ledger. For the ledger itself, permissioned platforms offer either execute-order-validate (Hyperledger Fabric {{fabric}}) or EVM-based Istanbul BFT {{moniz}} on which we build; both derive from classical Byzantine agreement {{pbft}}. On the IIoT side, large-scale measurements of OPC UA deployments found many with missing or weak authentication {{dahlmanns}}, which motivates per-device cryptographic identity (R1). We compare against central directories, real Keycloak and OpenLDAP services and, where noted, a central directory with push revocation, to test whether the ledger improves anything that such designs cannot.'));
push(H2('2.5 Comparative Analysis'));
push(P('Table @related compares representative works on four criteria taken from their reported content.', { keepNext: true }));
{
  const Y = 'Yes', H = 'Part', N = 'No';
  const rows = [
    ['{{salim}}', Y, Y, N, Y],
    ['{{aleisa}}', Y, Y, N, N],
    ['{{nie}}', Y, Y, N, H],
    ['{{sharma}}', Y, Y, H, N],
    ['{{mishra}}', Y, Y, Y, H],
    ['{{ali}}', Y, H, Y, H],
    ['{{li_hyper}}', Y, N, Y, N],
    ['{{asim}}', Y, N, Y, Y],
    ['{{ma}}', N, Y, N, N],
    ['{{zanasi}}', N, Y, Y, N],
    ['**This work**', Y, Y, Y, Y],
  ];
  push(table('TABLE @related. COMPARISON OF RELATED WORK', [1200, 915, 915, 915, 915],
    ['Work', 'Blockchain', 'Zero trust', 'IIoT focus', 'Scale eval.'], rows,
    { note: 'Yes = addressed; Part = partly; No = not addressed. Authors’ reading of each paper’s reported content; “Scale eval.” means device/node scaling reported.' }));
}
push(P('Three observations follow. Most blockchain-based zero-trust designs target generic IoT rather than IIoT; only two of the listed works report device or node scaling {{salim,asim}}; and none of the listed works both reports scaling and quantifies the staleness introduced by off-path state. The last point is where this paper concentrates its evaluation.'));
push(H2('2.6 Research Gap'));
push(P('No work in our (non-systematic) survey simultaneously (a) keeps the ledger off the per-request path, (b) quantifies the revocation-staleness this causes and how to bound it, and (c) amortises audit cost via Merkle anchoring for an IIoT workload. This paper targets that combination.'));

// ---- 3 ARCHITECTURE
push(H1('3. Proposed Architecture'));
push(H2('3.1 Design Objectives'));
push(P('**D1** decisions from local state in milliseconds; **D2** no single party that can change identity records, policy or logs without detection (a plant authority still enrols devices, Section 4.2); **D3** bounded staleness of cached state; **D4** write load that grows slower than the request rate; **D5** a device-side workload of one ECDSA signature per request and one stored Merkle path (device-side cost was not measured, [[DISC]]).'));
push(H2('3.2 Architecture Overview'));
push(P('Fig. 1 shows three tiers. Devices form Layer I (IIoT and edge). Layer II is the zero-trust security layer at the edge gateway, hosting the PEP, PDP and trust engine. Layer III is the permissioned blockchain, whose identity, trust, access-control and audit services are implemented as smart contracts. Gateways cache Layer III state, so Layer II never waits for consensus.', {}));
push(fig('fig1_architecture.png', 'Fig. 1. Proposed BC-ZTA architecture: devices, edge/ZT layer, blockchain layer and contract services.', 322));
push(H2('3.3 IIoT/Edge Layer'));
push(P('Sensors, actuators and PLCs hold an ECDSA key pair bound to a DID and sign each request with a timestamp and nonce. Edge gateways terminate sessions, host the PEP, keep a local cache of the identity, trust and policy state, and forward anomaly telemetry to the trust engine.'));
push(H2('3.4 Zero-Trust Security Layer'));
push(P('The PEP intercepts every request. The PDP verifies the signature, checks the DID against a cached Merkle-verified registry entry, retrieves the trust score and policy, and returns allow/deny. Micro-segmentation is enforced by permitting only flows that hold a valid, unexpired session {{zanasi}}. A trust engine converts behavioural features (rate, protocol conformance, firmware attestation) into score proposals.'));
push(H2('3.5 Blockchain Layer'));
push(P('A permissioned Hyperledger Besu network with IBFT 2.0 consensus is operated by plant, integrator and vendor validators; with *n* validators it tolerates *f* = ⌊(*n*−1)/3⌋ Byzantine nodes. Gateways are read-only clients that subscribe to events; only authorised registrars, validators and the policy administrator send transactions.'));
push(H2('3.6 Identity Management'));
push(P('Each device is a DID with a public-key hash and device class. Registrations are submitted by a plant-authorised registrar and may be grouped into *epochs*: the registrar commits a Merkle root of an epoch batch and devices later prove membership with a logarithmic-size proof, an approach inspired by epoch-based IIoT identity schemes {{asim}}. Key rotation and revocation are single transactions that emit events.'));
push(H2('3.7 Trust Management'));
push(P('Scores lie in [0,100] with an initial value of 70. A score changes only when a quorum of validators proposes the same value, and updates are rate-limited. An anomaly flag immediately subtracts 20 points (floored at 0) pending re-evaluation, giving fast conservative reaction.'));
push(H2('3.8 Access Control'));
push(P('Policies are attribute-based: for each resource the administrator defines allowed device-class range, minimum trust score and session TTL. A request is granted iff the DID is active, the class is in range and the trust score meets the threshold; the grant yields a session identifier that expires after the TTL or on explicit revocation.'));
push(H2('3.9 Smart Contracts'));
push(P('*IdentityRegistry* (register, update key, revoke, epoch commit, membership check); *TrustReputation* (quorum voting, anomaly flag); *AccessControl* (policy, evaluate, session grant/revoke); *AuditLog* (per-event log, Merkle batch anchor, inclusion verification). Table @iface lists the interfaces, and source and tests are in the accompanying package.', { keepNext: true }));
push(table('TABLE @iface. SMART-CONTRACT INTERFACES', [1250, 2510, 1100],
  ['Contract', 'Main functions', 'Writer'], [
    ['IdentityRegistry', 'registerDID, updateKey, revokeDID, commitEpoch; verifyMembership, isActive (views)', 'Plant authority'],
    ['TrustReputation', 'updateScore (quorum), flagAnomaly; getScore (view)', 'Validators'],
    ['AccessControl', 'setPolicy, revokeSession; evaluateRequest (view), grantSession, isSessionValid', 'Admin; any caller'],
    ['AuditLog', 'logEvent, anchorBatch; verifyInBatch, getAnchor (views)', 'Open in prototype'],
  ], { left: true, note: '“Open in prototype” means the function has no caller restriction; a deployment would restrict it to gateway accounts.' }));
push(H2('3.10 Continuous Verification'));
push(P('Fig. 2 summarises the workflow. Verification does not end at login: every request is re-evaluated against current cached trust, sessions are short-lived, and the gateway refreshes cached entries every *TTL* seconds or immediately on a *DIDRevoked* or *ScoreUpdated* event. Audit records are hashed into a batch whose Merkle root is anchored on-chain asynchronously (step 7), so logging never delays the response.', { keepNext: true }));
push(fig('fig2_workflow.png', 'Fig. 2. Per-request verification workflow with cached state reads and asynchronous audit anchoring (step 7).', 322));
push(P('A request is *r* = (DID, resource, operation, *t*, *n*, σ), where *t* is a timestamp, *n* a nonce and σ the device’s ECDSA signature over the other fields. The PEP accepts *r* only if (i) |now − *t*| ≤ Δ and *n* has not been seen within Δ, which bounds replay; (ii) the DID is active in the cached registry, proved by a Merkle path against the latest committed epoch root or by a direct chain read on a cache miss; (iii) σ verifies under the public key whose hash is registered; and (iv) the PDP finds the trust score and policy satisfied. Otherwise the request is denied and an anomaly event is queued. As a fail-closed rule, a gateway that cannot read the ledger keeps using a cached entry after its TTL for at most *k*·*TTL* after the entry was last read (*k* = 2 by default, configuration parameter STALE_FACTOR) and denies every request that needs older state (reason “unavailable”) until the ledger is reachable again; *k* = 1 gives strict fail-closed behaviour. A circuit breaker avoids waiting for the read timeout on every request while the source is down. The first cloud experiments (Sections 6.1–6.9) ran a prototype that denied as soon as a failed read followed TTL expiry (*k* = 1); the *k* = 2 rule is the one described here, and [[S12K]].'));
push(H2('3.11 Ledger Access, Revocation and Read Quorum'));
push(P('A Merkle membership proof against an epoch root shows that a DID was enrolled in that epoch; it stays valid after the device is revoked and therefore says nothing about freshness. Revocation is enforced through the registry record (revoked flag), which the gateway reads on a cache miss and which the *DIDRevoked* event invalidates. A gateway also trusts the Besu node it reads from: a compromised node could return stale or forged state. Deployments that do not run a validator at the gateway can read from *f* + 1 nodes pinned to the same block height and accept a state only if all answers agree; any *f* + 1 matching answers include an honest node, and IBFT 2.0 has instant finality, so there are no forks to reconcile. The prototype implements this option (parameter QUORUM = 2 for *n* = 4); the default configuration reads from one node, and [[S12Q]].'));

// ---- 4 USE CASE AND THREAT MODEL
push(H1('4. Use Case and Threat Model'));
push(H2('4.1 Use Case'));
push(P('A smart factory has several production cells, each with PLCs and sensors behind one edge gateway; a remote vendor engineer needs time-limited maintenance access to one PLC class; a SCADA historian consumes sensor data. Cells, vendor and integrator are separate administrative domains that jointly operate validators.'));
push(H2('4.2 Assets and Trust Assumptions'));
push(P('Assets are device identities, policy and trust state, session tokens and audit records. We assume a majority-honest validator set (at most *f* Byzantine), secure device key storage, and gateways that are trusted for enforcement but may be compromised individually.'));
push(H2('4.3 Adversary Model'));
push(P('A Dolev–Yao network adversary can eavesdrop, replay and inject messages; may compromise a subset of devices (including their keys) and one gateway; and may include an insider with administrative credentials in one domain but not in a validator quorum.'));
push(H2('4.4 Threats and Countermeasures'));
push(P('Table @threat maps threats to mechanisms.', { keepNext: true }));
push(table('TABLE @threat. THREATS AND COUNTERMEASURES', [1150, 1500, 2210],
  ['Threat', 'Attack', 'Countermeasure'], [
    ['Spoofing', 'Forged device identity', 'DID + ECDSA signature; Merkle-verified registry entry'],
    ['Replay', 'Re-sent request', 'Timestamp + nonce window at PEP; session TTL'],
    ['Lateral movement', 'Compromised device probes peers', 'Per-resource ABAC, micro-segmentation, short sessions'],
    ['Insider / tamper', 'Admin edits policy or logs', 'On-chain policy and Merkle-anchored audit; validator quorum'],
    ['Trust poisoning', 'False score votes', 'Quorum votes, rate limit; non-validators rejected'],
    ['Stale state', 'Use of revoked identity', 'Event-driven cache invalidation, bounded TTL'],
    ['Ledger DoS', 'Flooding the chain', 'Off-path reads; batched writes; non-validators cannot write trust'],
  ], { left: true }));
push(H2('4.5 Security Goals'));
push(P('Authenticity of devices, least-privilege authorisation, revocation within a bounded delay, non-repudiable tamper-evident audit, and availability of access decisions during ledger congestion.'));
push(H2('4.6 Security Analysis'));
push(P('We argue each goal under the assumptions of Sections 4.2–4.3 plus: ECDSA over secp256k1 is existentially unforgeable under chosen-message attack, Keccak-256 is collision- and second-preimage-resistant, device clocks and gateway clocks differ by less than Δ/2, and the enrolment authority registers only genuine devices. These are proof sketches, not machine-checked proofs; a ProVerif {{blanchet}} model of the request protocol is left for future work.'));
push(P('**S1 Authenticity.** A request is accepted only if the signature recovers an address whose hash equals the key hash registered for the claimed DID. A forger without the device key must break unforgeability; registering a new key needs the authority (*updateKey*/*registerDID*). **S2 Replay.** A replayed request is rejected if it is older than Δ or its nonce was seen by *the same gateway* within Δ. The signed message does not contain a gateway identifier, so the same request can be replayed once at a different gateway within Δ unless nonce caches are shared or the gateway identity is added to the signed fields; we did not test or implement this mitigation. **S3 Revocation.** After a revocation transaction is finalised (IBFT 2.0 has instant finality), a gateway that observes the event stops accepting the device within the event-polling interval; a gateway that misses the event enforces it when its cache entry expires, i.e. within *TTL*. If consensus is halted the transaction cannot be finalised, so the bound is measured from finalisation, not from submission [[S12R]]. **S4 Audit integrity.** Each batch root is anchored on-chain; a stored record that is altered later no longer verifies against its batch root, and an anchored root cannot be changed without *f* + 1 validators. Audit completeness is not guaranteed: a compromised gateway can omit records before they are anchored (up to the anchoring interval of 1 s is also exposed on a crash), and the prototype’s *AuditLog* accepts anchors from any account. **S5 Availability.** Decisions never wait for consensus and, when the ledger is unreachable, continue from cache for at most *k*·*TTL* (Section 3.10); a gateway whose node is compromised can deny service or serve stale state unless the read quorum of Section 3.11 is used. **Non-goals.** Compromise of the enrolment authority, of *f* + 1 validators, of a device key before revocation, and traffic analysis.'));

// ---- 5 IMPLEMENTATION AND METHODOLOGY
push(H1('5. Implementation and Experimental Methodology'));
push(H2('5.1 Besu Blockchain Network'));
push(P(`We deployed a four-validator Hyperledger Besu v26.9.0 IBFT 2.0 network (*f* = 1, block period 2 s, chain ID 2026, zero base fee, London EVM) with Docker on a GitHub-hosted 2-vCPU Linux runner for the contract-level micro-benchmark described below; all validators share that single host, so network delay is negligible and CPU is contended. The end-to-end experiments of Section 5.3 were run separately on a seven-VM Google Cloud deployment (Section 5.7). A fresh network was started for each of ${MS.runs} micro-benchmark repetitions. Contracts were compiled with Solidity 0.8.20 (optimizer 200 runs, EVM “london”). Five scenarios were run with pre-signed transactions from ${MS.workers} worker wallets: S1 sequential write confirmation, S2 read latency (500 *eth_call* evaluations of *AccessControl.evaluateRequest*), S3 per-event logging at 10–200 tx/s offered for ${MS.duration_s} s, S4 batch anchoring at 1 tx/s, and S5 revocation visibility. Block observation was polled every 25 ms. The scripts, contracts and raw results are in the public code repository listed under Data and Code Availability.`));
push(H2('5.2 Smart Contracts'));
push(P('The four contracts total about 370 lines. A Hardhat/Chai suite of 15 tests passes and covers registration, duplicate and unauthorised registration, revocation, key update, quorum scoring, score floor, rate limiting, non-validator rejection, access grant/deny, session expiry, epoch Merkle membership and audit batch inclusion proofs.'));
push(H2('5.3 End-to-End Prototype and Load Generator'));
push(P(`Besides the contract-level tests, we implemented the complete request path as running software (Node.js 20): a PEP/PDP service, a load generator and the baselines of Section 5.4. Each device owns a secp256k1 key and signs *DID | resource | timestamp | nonce*; its key hash and device class are registered on-chain and its DID is part of one Merkle epoch commitment. The PEP rejects stale timestamps (>5 s) and repeated nonces, recovers the signer, checks it against the registered key hash, verifies the Merkle membership proof against the cached epoch root, and evaluates the ABAC policy (device class 0–1, trust score ≥ 50). In BC-ZTA, identity, trust and policy state are read from Besu with *eth_call* on a cache miss and cached for ${PR.cache_ttl_s} s; a block-polling subscription (20 ms) invalidates an entry when a *DIDRevoked*, *KeyUpdated* or *ScoreUpdated* event is mined; every decision is hashed, and once per second the Merkle root of the pending batch is anchored with *AuditLog.anchorBatch*. The load generator emulates N = ${E.counts.join(', ')} devices, each sending one request per second with staggered phases, for ${E.warmup_s} s of warm-up and a ${E.duration_s} s measurement window; requests are signed before the window so that the generator itself is not the bottleneck. In the end-to-end experiments the PEP, the directory server, the load generator and the four Besu validators run on separate machines (Section 5.7).`));
push(H2('5.4 Baselines'));
push(P(`(B1) *Centralised PKI-IAM*: each request makes one lookup at a separate directory server, on a separate directory VM whose responses are delayed by ${E.netem_wan_ms} ms with Linux *tc netem* to model a remote central service (about 50 ms per lookup in total, Section 6.1). (B2) *ABAC without blockchain*: a local attribute store at the PEP. (B3) *Blockchain-only (sync)*: for every request the PEP reads the state with *eth_call* and sends an *AuditLog.logEvent* transaction (eight sender accounts) and replies only after the block containing it is observed. (B4) *Keycloak*: a real Keycloak 26.4.0 identity provider issues each device an OpenID Connect access token carrying its class, trust score and key hash as claims, and the PEP calls the token-introspection endpoint {{rfc7662}} on every request; revocation disables the user. (B5) *OpenLDAP*: a real slapd directory holding the same attributes, queried once per request {{rfc4511}}. B4 and B5 are also run with a PEP-side decision cache (“cached”, TTL 10 s), which is the usual way to cut their latency. (P) *Proposed BC-ZTA* as in Section 5.3. All systems use the same request format, signature check and policy, so differences come from where state is read and written.`));
push(H2('5.5 Experimental Parameters'));
push(P('Table @params lists the experimental parameters; the injected network delays are assumptions, the other values are configuration of the prototype.', { keepNext: true }));
push(table('TABLE @params. EXPERIMENTAL PARAMETERS', [2700, 2160],
  ['Parameter', 'Value'], [
    ['Ledger', 'Besu v26.9.0, IBFT 2.0, 4 validators'],
    ['Block period', `${PR.block_period_ms / 1000} s`],
    ['Platform', 'Google Cloud, 7 VMs (Section 5.7)'],
    ['Devices; request rate', `${E.counts[0]}–${E.counts[E.counts.length - 1]}; 1 req/s each`],
    ['Warm-up; window; runs', `${E.warmup_s} s; ${E.duration_s} s; ${E.runs}`],
    ['Cache TTL; anchor interval', `${PR.cache_ttl_s} s; ${PR.audit_batch_interval_s} s`],
    ['Directory delay (B1, netem)', `${E.netem_wan_ms} ms`],
    ['Validator link delay (netem)', `${E.netem_validator_ms} ms`],
    ['Freshness window; policy', '5 s; class 0–1, trust ≥ 50'],
    ['Revocation tests', `${E.E2['bczta-ttl'].n / E.runs} devices × ${E.runs} runs per system; TTL ${E.E2['bczta-ttl'].ttl_s} s`],
  ], { left: true, note: 'Network delay is injected with tc netem on the directory and validator VMs only; everything else is measured on running software.' }));
push(H2('5.6 Performance Metrics'));
push(P('(E1) End-to-end latency (mean, P95) from request send to decision, goodput (accepted requests per second), failures, and on-chain writes per second versus device count. (E2) Revocation enforcement delay: time from the revocation action until the PEP first denies the device. (E3) Security tests with 50 attempts each per run. (E4) Decision latency while the ledger is flooded with transactions. (E5) Decision latency, goodput and revocation enforcement while one of the four validators is stopped. Also gas per operation and, from the micro-benchmark, confirmation latency and ledger throughput.'));

push(H2('5.7 Distributed Deployment'));
push(P(`The end-to-end experiments E1–E5 ran on Google Cloud (zone us-central1-a) on seven separate virtual machines in one VPC without external addresses: four Besu validators (e2-medium, 2 vCPU, 4 GB; one validator each), one PEP/PDP host (e2-standard-2), one directory server for B1 (e2-small) and one controller (e2-standard-2) that runs the load generator and the experiment scripts and submits the on-chain transactions. Linux *tc netem* delays all outgoing traffic of each validator VM by ${E.netem_validator_ms} ms to represent a plant-local validator network, and the responses of the directory server by ${E.netem_wan_ms} ms to represent a remote central service; all other delay is the real VM-to-VM network delay. Each of the ${E.runs} repetitions started a freshly generated chain and restarted the PEP for every device count; the repetitions ran sequentially on the same VMs. The validator-failure test (E5) stops one validator container for 30 s while 50 devices are served. Cloud VMs in one zone approximate independent hosts better than a shared CI runner, but they are not an industrial network: devices are emulated by the load generator and co-tenancy in the cloud can add variance. The deployment scripts, configuration and raw results are in the public code repository listed under Data and Code Availability.`));
push(P('A second cloud run on the same seven VMs added Keycloak 26.4.0 (Docker, development mode, embedded H2 database, OIDC token introspection) and OpenLDAP slapd (Debian 12 package, one search per request) on the directory VM (B4 and B5), the PEP-cache variants of both, a revocation test, a 25 s outage test, an open-loop PEP capacity test and the ledger flood sweep of Section 6.9. Besu was started with a 2.5 GB heap for the flood sweep and for all later runs; the first IAM repetition used the default 1 GB heap, which does not affect the PEP-side measurements reported here. The scripts, orchestration and raw results are in the code package.'));

// ---- 6 RESULTS
push(H1('6. Results and Discussion'));
push(H2('6.1 Authentication'));
push(P(`Table @lat and Fig. 3 show end-to-end latency (mean of ${E.runs} runs). At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms on average (P95 ${f1(e('bczta', 50).p95_ms)} ms), versus ${f1(e('central', 50).mean_ms)} ms for the centralised PKI-IAM, ${f1(e('abac', 50).mean_ms)} ms for the ledger-free ABAC store and ${f0(e('bcsync', 50).mean_ms)} ms for the synchronous blockchain. BC-ZTA is therefore ${pct(e('bczta', 50).mean_ms, e('central', 50).mean_ms)}% faster than the centralised baseline, costs about ${f1(e('bczta', 50).mean_ms - e('abac', 50).mean_ms)} ms more than a local store (Merkle verification, hashing and audit bookkeeping), and is about ${f0(e('bcsync', 50).mean_ms / e('bczta', 50).mean_ms)}× faster than checking every request on-chain. Even at 10 devices, where the ledger is not saturated, the synchronous design needs ${f0(e('bcsync', 10).mean_ms)} ms because each request waits for a block.`, { keepNext: true }));
const pm = (sy, n) => f1(e(sy, n).mean_ms) + ' ± ' + f1(ci(e(sy, n).mean_ms_sd, E.runs));
push(table(`TABLE @lat. END-TO-END LATENCY (MS, MEAN ± 95% CI OF ${E.runs} RUNS; P95)`, [1100, 1210, 650, 1250, 650],
  ['System', 'Mean 50', 'P95 50', 'Mean 200', 'P95 200'], [
    ['PKI-IAM', pm('central', 50), f1(e('central', 50).p95_ms), pm('central', 200), f1(e('central', 200).p95_ms)],
    ['ABAC', pm('abac', 50), f1(e('abac', 50).p95_ms), pm('abac', 200), f1(e('abac', 200).p95_ms)],
    ['BC-only', f0(e('bcsync', 50).mean_ms) + ' ± ' + f0(ci(e('bcsync', 50).mean_ms_sd, E.runs)), f0(e('bcsync', 50).p95_ms), f0(e('bcsync', 200).mean_ms) + ' ± ' + f0(ci(e('bcsync', 200).mean_ms_sd, E.runs)), f0(e('bcsync', 200).p95_ms)],
    ['BC-ZTA', '**' + pm('bczta', 50) + '**', '**' + f1(e('bczta', 50).p95_ms) + '**', '**' + pm('bczta', 200) + '**', '**' + f1(e('bczta', 200).p95_ms) + '**'],
  ], { left: true, note: 'Columns give the number of devices; PKI-IAM responses are delayed by 40 ms (netem). With 5 runs the differences discussed in the text exceed the confidence intervals by an order of magnitude; no hypothesis tests were run.' }));
push(fig('fig3_latency.png', `Fig. 3. Mean end-to-end latency versus number of devices (log scale; error bars: standard deviation of ${E.runs} runs).`, 322));
push(H2('6.2 Authorization'));
push(P(`The proposed design makes policy decisions from the edge cache. The measured cache-hit ratio was ${f0(100 * e('bczta', 50).cache_hit_ratio)}% (one miss per device per ${PR.cache_ttl_s} s TTL), so 50 devices caused only 50 chain reads for about 1,250 requests; each miss costs one batched *eth_call* of ${PR.chain_read_ms} ms in the micro-benchmark. The PEP used ${f2(e('bczta', 50).cpu_cores)} CPU cores at 50 devices and ${f2(e('bczta', 200).cpu_cores)} at 200, against ${f2(e('abac', 200).cpu_cores)} for the local store. Every decision is covered by the audit batch: in the 200-device runs about 5,000 decisions per run were anchored in roughly 25 transactions. On-chain evaluation costs ${gas('AccessControl.evaluateRequest')} gas as an estimate, but because it is a read, no fee or block wait is incurred.`));
push(H2('6.3 Blockchain Throughput'));
push(P(`Table @besu summarises the Besu micro-benchmark. Write confirmation takes ${f0(s3(10).mean_ms)} ms on average at 10 tx/s (P95 ${f0(s3(10).p95_ms)} ms), close to the 2 s block period; a transaction submitted just after a block, as in the phase-locked sequential tests S1/S5, waits about ${f0(MS.S1_write_confirmation_phase_locked['AuditLog.logEvent'].mean_ms)} ms. Reads cost ${f1(MS.S2_read_latency.mean_ms)} ms (P95 ${f1(MS.S2_read_latency.p95_ms)} ms). Committed throughput tracks the offered load up to 50 tx/s (${f1(s3(50).committed_tps)} tx/s) but saturates near ${PR.chain_capacity_tps} tx/s on this host: at 100 and 200 tx/s offered only ${f1(s3(100).committed_tps)} and ${f1(s3(200).committed_tps)} tx/s commit and ${f0(100 * (1 - s3(200).confirmed_fraction))}% of transactions at 200 tx/s were not confirmed within 60 s. Batch anchoring at 1 tx/s confirmed all ${MS.S4_batch_anchoring.confirmed.reduce((a, b) => a + b, 0)} anchors in ${f0(MS.S4_batch_anchoring.mean_ms)} ms on average. Because all validators share one 2-vCPU host, ${PR.chain_capacity_tps} tx/s is a lower bound: on the seven-VM deployment the synchronous baseline committed up to ${f0(e('bcsync', 200).onchain_tx_per_s)} tx/s (Section 6.5), almost twice as much.`, { keepNext: true }));
push(table('TABLE @besu. MEASURED BESU RESULTS (SHARED CI HOST, 3 RUNS, MEAN)', [1500, 900, 900, 900, 660],
  ['Offered (tx/s)', 'Commit (tx/s)', 'Mean (ms)', 'P95 (ms)', 'Conf.'], [
    ...S3.map(r => [String(r.offered_tps), f1(r.committed_tps), f0(r.mean_ms), f0(r.p95_ms), f0(100 * r.confirmed_fraction) + '%']),
  ], { left: true, note: 'Per-event logging (S3), four IBFT 2.0 validators on one shared 2-vCPU host; Conf. = confirmed fraction.' }));
push(H2('6.4 Resource Utilization'));
push(P(`Measured gas per operation is listed in Table @gas. Registering a device costs ${gas('IdentityRegistry.registerDID')} gas, whereas committing an epoch root costs ${gas('IdentityRegistry.commitEpoch')} gas independent of batch size. Logging one event on-chain costs ${gas('AuditLog.logEvent')} gas, while anchoring a batch costs ${gas('AuditLog.anchorBatch')} gas, i.e. about ${f0(RES.gas_per_record.anchorBatch_per_record_at_1000)} gas per record for a 1,000-record batch (≈${f0(gasRatio(1000))}× cheaper); the saving is proportional to the batch size and is ≈${f0(gasRatio(50))}× for the 50 records per batch of the 50-device experiments and ≈${f0(gasRatio(200))}× for 200 devices. At 400 devices and 1 event/s the calculation gives ${(AG.events_per_day / 1e6).toFixed(1)} M events/day: ${AG.per_event_logging_MB_per_day.toFixed(0)} MB/day of ledger growth with per-event logging (192 B/entry) versus ${AG.batch_anchoring_MB_per_day.toFixed(1)} MB/day with batch anchoring. Device-side CPU and memory were not measured; prior IOTA-based DID work reports that DID generation can saturate a Raspberry Pi 4 CPU {{ramirez}}, which motivates our use of hash proofs only.`, { keepNext: true }));
push(table('TABLE @gas. MEASURED GAS PER CONTRACT OPERATION', [3160, 1700],
  ['Operation', 'Gas'], [
    ['IdentityRegistry.registerDID', gas('IdentityRegistry.registerDID')],
    ['IdentityRegistry.commitEpoch', gas('IdentityRegistry.commitEpoch')],
    ['IdentityRegistry.revokeDID', gas('IdentityRegistry.revokeDID')],
    ['AccessControl.setPolicy', gas('AccessControl.setPolicy')],
    ['AccessControl.grantSession', gas('AccessControl.grantSession')],
    ['TrustReputation.updateScore (quorum)', gas('TrustReputation.updateScore (quorum')],
    ['TrustReputation.flagAnomaly', gas('TrustReputation.flagAnomaly')],
    ['AuditLog.logEvent (per event)', gas('AuditLog.logEvent')],
    ['AuditLog.anchorBatch (per batch)', gas('AuditLog.anchorBatch')],
  ], { left: true, note: 'Hardhat EVM (london), optimizer 200 runs; first-use storage costs included.' }));
push(H2('6.5 Scalability'));
push(P(`Fig. 4 shows goodput and on-chain write load against device count. Central PKI-IAM, ABAC and BC-ZTA served every request up to 200 devices with no failures. The synchronous blockchain kept up to 50 devices (goodput ${f0(e('bcsync', 50).goodput_rps)} req/s, ${f1(e('bcsync', 50).mean_ms / 1000)} s mean latency) and at 100 devices (${f0(e('bcsync', 100).goodput_rps)} req/s, ${f1(e('bcsync', 100).mean_ms / 1000)} s), but at 200 devices only ${f0(100 * e('bcsync', 200).success_ratio)}% of the requests were answered in time, goodput fell to ${f0(e('bcsync', 200).goodput_rps)} req/s and ${f0(e('bcsync', 200).failed_or_timeout)} requests (summed over ${E.runs} runs) failed or timed out. Its on-chain write rate (${f0(e('bcsync', 100).onchain_tx_per_s)} tx/s at 100 and ${f0(e('bcsync', 200).onchain_tx_per_s)} tx/s at 200 devices) is the measured ledger ceiling of this deployment, whereas BC-ZTA writes about ${f1(e('bczta', 100).onchain_tx_per_s)} tx/s regardless of the number of devices. The latency of BC-ZTA stays flat from 10 to 200 devices (${f1(e('bczta', 10).mean_ms)} to ${f1(e('bczta', 200).mean_ms)} ms mean, P95 at most ${f1(Math.max(...E.E1.bczta.map(r => r.p95_ms)))} ms), and the PEP used ${f2(e('bczta', 200).cpu_cores)} of its two vCPUs at 200 devices, so neither the ledger nor the PEP was the limit at this load; larger populations were not tested. For comparison, a sharded design reaches 2,500 TPS at 700 nodes {{salim}}; our approach instead lowers the required write rate.`, { keepNext: true }));
push(fig('fig4_scalability.png', 'Fig. 4. Goodput (top) and on-chain writes per second (bottom) versus number of devices; dotted line: offered load.', 290));
push(H2('6.6 Attack Resistance'));
const sec = E.E3, secRow = (k, n) => [n, String(sec[k].attempts), String(sec[k].allowed)];
push(P(`Table @sec lists the security tests run against the BC-ZTA prototype (${E.runs} runs, 50 attempts per test and run). All legitimate requests were accepted (no false rejects), and none of the forged, replayed, stale, unregistered, tampered, class-violating or low-trust requests was accepted. For a revoked device, ${E.E3.revoked_device.accepted_after_tx_confirmed.reduce((a, b) => a + b, 0)} requests were accepted after the revocation transaction was confirmed, and the first denial came ${f0(Math.max(...E.E3.revoked_device.first_denial_after_confirmation_ms))} ms after confirmation or sooner. Fig. 5 shows the revocation enforcement delay of each system: with event-driven invalidation BC-ZTA enforces a revocation after ${f2(E.E2['bczta-events'].mean_ms / 1000)} s on average (worst case ${f2(E.E2['bczta-events'].max_ms / 1000)} s), about one block period and independent of the TTL, whereas TTL-only refresh with a ${E.E2['bczta-ttl'].ttl_s} s TTL needs ${f1(E.E2['bczta-ttl'].mean_ms / 1000)} s on average (worst case ${f1(E.E2['bczta-ttl'].max_ms / 1000)} s). The centralised and local baselines revoke in ${f0(E.E2.central.mean_ms)} ms and ${f0(E.E2.abac.mean_ms)} ms because they hold the state in one place (the ABAC samples are bimodal, about 7 ms or 57 ms; we did not isolate the cause, which lies in the probe path rather than in the store); the blockchain-only value (${f2(E.E2.bcsync.mean_ms / 1000)} s) includes the request that was in flight when the revocation was issued.`, { keepNext: true }));
push(table(`TABLE @sec. SECURITY TESTS ON THE BC-ZTA PROTOTYPE (${E.runs} RUNS)`, [2900, 980, 980],
  ['Test', 'Attempts', 'Accepted'], [
    secRow('legitimate_requests (control)', 'Legitimate requests (control)'),
    secRow('forged_signature', 'Forged signature'),
    secRow('replayed_request', 'Replayed request'),
    secRow('stale_timestamp', 'Stale timestamp'),
    secRow('unregistered_DID', 'Unregistered DID'),
    secRow('tampered_merkle_proof', 'Tampered Merkle proof'),
    secRow('device_class_outside_policy', 'Class outside policy'),
    secRow('low_trust_score', 'Trust score below threshold'),
  ], { left: true, note: 'For the control row, Accepted is the desired outcome; for all other rows it must be 0.' }));
push(fig('fig5_revocation.png', 'Fig. 5. Revocation enforcement delay (mean, log scale; marks: worst case observed).', 322));
push(H2('6.7 Availability under Validator Failure and Ledger Flooding'));
const fl = E.E4.bczta_under_flood, fsent = fl.flood.map(x => x.sent);
push(P(`E5 stops one of the four validators for 30 s while 50 devices are served and one device is revoked during the outage. IBFT 2.0 with four validators tolerates *f* = 1 faulty validator and the PEP decides from its cache, so decisions should be unaffected. Table @fault confirms this: all ${E.E5.measured} requests were answered and accepted (mean ${f1(E.E5.mean_ms)} ms, P95 ${f1(E.E5.p95_ms)} ms, none late or failed), the revoked device was denied ${f2(E.E5.revocation_during_fault_ms / 1000)} s after the revocation was submitted, and the PEP kept anchoring audit batches (${E.E5.pep.anchors_confirmed} of ${E.E5.pep.anchors_sent} anchor transactions were confirmed when the statistics were read). Only one failure of one validator for 30 s was tested; network partitions, Byzantine validators and the loss of two validators were not.`, { keepNext: true }));
push(table('TABLE @fault. VALIDATOR-FAILURE TEST (E5, ONE RUN)', [3160, 1700],
  ['Measure', 'Value'], [
    ['Requests answered / accepted', `${E.E5.measured} / ${E.E5.ok}`],
    ['Mean / P95 latency (ms)', `${f1(E.E5.mean_ms)} / ${f1(E.E5.p95_ms)}`],
    ['Late or failed requests', `${E.E5.late} / ${E.E5.failed_or_timeout}`],
    ['Revocation enforced (s)', f2(E.E5.revocation_during_fault_ms / 1000)],
    ['Anchors sent / confirmed', `${E.E5.pep.anchors_sent} / ${E.E5.pep.anchors_confirmed}`],
  ], { left: true, note: 'One of four validators stopped for 30 s of a 70 s window; 50 devices at 1 req/s.' }));
push(P(`In E4 the ledger is flooded with 200 tx/s of audit-log transactions for 35 s while 50 devices are served. Besu accepted ${f0(Math.min(...fsent))} to ${f0(Math.max(...fsent))} of the ${f0(fl.flood[0].txs)} flood transactions per run and rejected the rest (presumably a full transaction pool), so the accepted flood rate was ${f0(Math.min(...fsent) / fl.flood[0].seconds)} to ${f0(Math.max(...fsent) / fl.flood[0].seconds)} tx/s. In all ${E.runs} runs the PEP answered every request (success ${f0(100 * Math.min(...fl.success_ratio_per_run))}%), with mean latency ${f1(Math.min(...fl.mean_ms_per_run))}–${f1(Math.max(...fl.mean_ms_per_run))} ms against ${f1(Math.min(...E.E4.bczta_idle_ledger.mean_ms_per_run))}–${f1(Math.max(...E.E4.bczta_idle_ledger.mean_ms_per_run))} ms with an idle ledger. This is the intended effect of keeping the ledger off the request path. On the shared CI host the same flood had caused request failures, which we attribute to CPU contention between the PEP and the flooded validators and which the separate hosts removed.`));

push(H2('6.8 Comparison with Production IAM Services'));
const xe = (k, n) => X.E1[k][String(n)], x2 = k => X.E2[k], x6 = k => X.E6[k].summary;
const mean = a => a.reduce((u, v) => u + v, 0) / a.length;
push(P(`To replace the simple directory of B1 by real products, we added Keycloak 26.4 as an OpenID Connect token-introspection service {{rfc7662}} (B4) and OpenLDAP slapd as a directory queried once per request {{rfc4511}} (B5), each on the directory VM behind the same 40 ms netem delay, plus a variant of each with a ${10} s decision cache at the PEP (“cached”). All five systems use the same PEP, signatures and policy. Table @iam gives the results (3 repetitions). At 25 and 100 devices the uncached products need ${f1(xe('keycloak', 100).mean_ms[0])} ms (Keycloak) and ${f1(xe('ldap', 100).mean_ms[0])} ms (OpenLDAP) per decision because every request crosses the emulated WAN, against ${f1(xe('bczta', 100).mean_ms[0])} ms for BC-ZTA, i.e. ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× and ${f0(xe('ldap', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster. This advantage is mainly the removal of the WAN round trip: a PEP-side cache of the product's answer reaches ${f1(xe('keycloak-cached', 100).mean_ms[0])}–${f1(xe('ldap-cached', 100).mean_ms[0])} ms mean latency, and only its P95 (${f0(xe('keycloak-cached', 100).p95_ms[0])} ms, one miss per device per TTL) remains WAN-bound. The decisive difference is therefore not the mean latency but what the cache costs: the cached products enforce a revocation only after the cache expires (mean ${f1(x2('keycloak-cached').mean_ms / 1000)} s, worst case ${f1(x2('keycloak-cached').max_ms / 1000)} s for the 10 s TTL), whereas BC-ZTA’s event-driven invalidation enforces it in ${f1(x2('bczta-events').mean_ms / 1000)} s in this run and ${f1(E.E2['bczta-events'].mean_ms / 1000)} s in the five-run test of Section 6.6 (worst case ${f1(x2('bczta-events').max_ms / 1000)} s) at the same low latency. The uncached products are faster at revocation, ${f0(x2('keycloak').mean_ms)} ms (Keycloak) and ${f0(x2('ldap').mean_ms)} ms (OpenLDAP), because the central service is consulted on every request; this is the price BC-ZTA pays for edge autonomy, and a plant that needs sub-second revocation must use the uncached products or a faster block period.`, { keepNext: true }));
const lat = (k, n) => f1(xe(k, n).mean_ms[0]) + ' / ' + f0(xe(k, n).p95_ms[0]);
push(table('TABLE @iam. PRODUCTION IAM BASELINES: LATENCY (MEAN / P95, MS) AND REVOCATION DELAY', [1700, 800, 800, 800, 760],
  ['System', '25 dev.', '100 dev.', '200 dev.', 'Revoc. (s)'], [
    ['Keycloak', lat('keycloak', 25), lat('keycloak', 100), lat('keycloak', 200), f2(x2('keycloak').mean_ms / 1000)],
    ['Keycloak, cached', lat('keycloak-cached', 25), lat('keycloak-cached', 100), lat('keycloak-cached', 200), f2(x2('keycloak-cached').mean_ms / 1000)],
    ['OpenLDAP', lat('ldap', 25), lat('ldap', 100), lat('ldap', 200), f2(x2('ldap').mean_ms / 1000)],
    ['OpenLDAP, cached', lat('ldap-cached', 25), lat('ldap-cached', 100), lat('ldap-cached', 200), f2(x2('ldap-cached').mean_ms / 1000)],
    ['BC-ZTA', '**' + lat('bczta', 25) + '**', '**' + lat('bczta', 100) + '**', lat('bczta', 200), '**' + f2(x2('bczta-events').mean_ms / 1000) + '**'],
  ], { left: true, note: 'Mean of 3 repetitions; 40 ms netem delay on the IAM services; revocation: 8 devices per run, mean of 24; cache TTL 10 s.' }));
push(fig('fig6_iam_latency.png', 'Fig. 6. Mean (left) and P95 (right) latency of Keycloak, OpenLDAP, their cached variants and BC-ZTA.', 322));
push(P(`At 200 devices (one request per second each) the PEP, a single Node.js process on a 2-vCPU VM, approaches its own capacity: BC-ZTA (${f0(xe('bczta', 200).mean_ms[0])} ms mean, ${f0(xe('bczta', 200).p95_ms[0])} ms P95) and uncached Keycloak (${f0(xe('keycloak', 200).mean_ms[0])} ms) degrade similarly, while the cached products do not. In the earlier run of Section 6.1 the same BC-ZTA configuration still decided in ${f1(e('bczta', 200).mean_ms)} ms at 200 devices, so this point lies at the saturation edge and is sensitive to run-to-run variation; we report it as a limit of our single-process PEP, not of the architecture, since PEPs are stateless and can be replicated per gateway. An open-loop capacity test (200–1,600 req/s, 3 repetitions) shows goodput saturating at about ${f0(Math.min(...['keycloak','ldap','bczta'].map(m => X.E7[m]['400'].goodput[0])))}–${f0(Math.max(...['keycloak','ldap','bczta'].map(m => X.E7[m]['800'].goodput[0])))} req/s for all three systems, with P95 latency of several seconds beyond saturation; per-PEP capacity is therefore bounded by request signature verification and not by the choice of IAM backend.`));
push(P(`Table @outage reports the outage test: the central service is stopped 20 s into a 100 s run with 100 devices and restarted at 45 s. Without Keycloak or OpenLDAP no new access decisions can be made: ${f0(100 * mean(x6('keycloak').ok_fraction_during_outage))}% of requests were granted during the outage for both uncached products, and ${f0(100 * mean(x6('keycloak-cached').ok_fraction_during_outage))}% for the cached variants, whose entries expired within ${f0(mean(x6('keycloak-cached').seconds_until_service_loss))} s of the stop (they kept serving only until the 10 s TTL ran out and, because requests are spread over the TTL, most entries had already expired). Service resumed ${f0(mean(x6('ldap').seconds_to_recover_after_start))} s after restarting OpenLDAP and ${f0(mean(x6('keycloak').seconds_to_recover_after_start))} s after restarting Keycloak (JVM start-up). BC-ZTA, whose PEP does not contact any central service, granted ${f0(100 * mean(x6('bczta').ok_fraction_during_outage))}% throughout (Fig. 7). This test removes a service that BC-ZTA does not use; a design that caches decisions and receives pushed revocations from the same directory would also survive a short outage, so the fair comparison is the loss of each design’s own state source [[S12O]]. We did not test replicated or clustered Keycloak/OpenLDAP deployments, which would reduce this effect at the cost of operating them; the test shows the single-point-of-failure property that the architecture removes, not that central IAM cannot be made highly available.`, { keepNext: true }));
push(table('TABLE @outage. CENTRAL-SERVICE OUTAGE (25 s, 100 DEVICES, 3 RUNS)', [2060, 1400, 1400],
  ['System', 'Granted during outage (%)', 'Recovery after restart (s)'], [
    ...[['keycloak', 'Keycloak'], ['keycloak-cached', 'Keycloak, cached'], ['ldap', 'OpenLDAP'], ['ldap-cached', 'OpenLDAP, cached']].map(([k, n]) => [n, f0(100 * mean(x6(k).ok_fraction_during_outage)), f0(mean(x6(k).seconds_to_recover_after_start))]),
    ['BC-ZTA', '**' + f0(100 * mean(x6('bczta').ok_fraction_during_outage)) + '**', '**0**'],
  ], { left: true, note: 'Service stopped at 20 s and restarted at 45 s of a 100 s run; BC-ZTA has no central service (Keycloak was stopped on the directory VM, but BC-ZTA does not use it).' }));
push(fig('fig7_iam_outage.png', 'Fig. 7. Fraction of requests granted over time while the central IAM service is stopped (shaded) and restarted.', 322));

push(H2('6.9 Ledger Flood Sweep'));
const FB = X.FLOOD.bczta, FS = X.FLOOD.bcsync;
const pk = Object.keys(FB).map(Number).sort((a, b) => a - b);
const fpeak = m => Math.max(...pk.map(r => X.FLOOD[m][String(r)].committed_tps[0]));
push(P(`Section 6.7 tested one flood rate. We therefore swept the offered rate of audit-log transactions from 0 to 1,200 tx/s (16 spam wallets, pre-signed transactions sent in nonce order, 20 s per rate after a 5 s warm-up, 50 devices at 1 request/s, 2 repetitions) once with BC-ZTA and once with the synchronous design, which writes each decision as a transaction on the same ledger (Table @flood, Fig. 8). The committed rate saturates at about ${f0(fpeak('bczta'))} tx/s for BC-ZTA and ${f0(fpeak('bcsync'))} tx/s for the synchronous design (peak at 200–400 tx/s offered) and then declines, to ${f0(FB['1200'].committed_tps[0])} and ${f0(FS['1200'].committed_tps[0])} tx/s at 1,200 offered, as Besu rejects most of the excess (“nonce too distant” and, at the highest rate, “transaction pool not enabled”; ${f0(FB['1200'].rejected)} of ${f0(FB['1200'].attempts)} submissions in the BC-ZTA run). BC-ZTA’s access latency does not follow: its mean stays at ${f1(Math.min(...pk.map(r => FB[String(r)].mean_ms[0])))}–${f1(Math.max(...pk.map(r => FB[String(r)].mean_ms[0])))} ms and its P95 at no more than ${f1(Math.max(...pk.map(r => FB[String(r)].p95_ms[0])))} ms with every request answered, because decisions never wait for the ledger. The synchronous design’s mean latency rises from ${f1(FS['0'].mean_ms[0] / 1000)} s with an idle ledger to ${f0(FS['1200'].mean_ms[0] / 1000)} s at 1,200 tx/s (P95 ${f0(FS['1200'].p95_ms[0] / 1000)} s), and ${f0(100 * (1 - FS['1200'].ok_ratio[0]))}% of its requests fail at the highest rate. The flood therefore denies service to ledger-bound designs but only delays BC-ZTA’s own audit anchoring and revocation visibility, which we did not measure under flood.`, { keepNext: true }));
push(table('TABLE @flood. LEDGER FLOOD SWEEP (2 RUNS PER RATE)', [1000, 880, 880, 1040, 1060],
  ['Offered (tx/s)', 'Commit (tx/s)', 'BC-ZTA P95 (ms)', 'Sync. mean (s)', 'Sync. P95 (s)'], [
    ...pk.map(r => [String(r), f0(FB[String(r)].committed_tps[0]), f1(FB[String(r)].p95_ms[0]), f1(FS[String(r)].mean_ms[0] / 1000), f1(FS[String(r)].p95_ms[0] / 1000)]),
  ], { left: true, note: 'Commit = committed tx/s of the BC-ZTA run, from block data. Sync. = synchronous on-chain design.' }));
push(fig('fig8_flood.png', 'Fig. 8. Committed ledger rate (left) and access P95 latency (right) versus offered flood rate.', 322));
push(P('The flood generator targets the validator that the PEP also reads from, and the Besu heap was raised to 2.5 GB after a first attempt with the default 1 GB heap ran out of memory in the synchronous run at 400 tx/s; a flood against all validators, an attacker with more accounts, or a longer flood were not tested. The committed rate of 100–215 tx/s is specific to our four-validator, 2 s block, two-vCPU validator setup.'));

if (XR) {
  const chk = (c, m) => { if (!c && !process.env.MOCK) throw new Error('REVIEW TEXT: ' + m); };
  const nR = XR.n_runs, P1 = XR.P1, P2 = XR.P2, P3 = XR.P3, P4 = XR.P4, P5 = XR.P5;
  const pl = (m, n) => P1[m][String(n)] || (process.env.MOCK ? P1[m][Object.keys(P1[m]).sort((x, y) => y - x)[0]] : undefined);
  const plc = (m, n) => f1(pl(m, n).mean_ms[0]) + ' ± ' + f1(ci(pl(m, n).mean_ms[1], pl(m, n).reps));
  chk(P2.push.mean_ms < P2['bczta-q2'].mean_ms, 'push revocation should be faster than ledger revocation');
  push(H2('6.10 Robustness: Push Revocation, Read Quorum, Fail-Closed Bound, Consensus Halt and Scaling'));
  push(P(`The comparison with Keycloak and OpenLDAP leaves open whether the ledger is needed for what BC-ZTA does well. We therefore added baseline B6, a central directory (40 ms WAN delay) whose answers the PEP caches for 30 s and which pushes each revocation to the PEP over a server-sent-event stream, i.e. event-driven invalidation without a blockchain, and BC-ZTA with a read quorum of *f* + 1 = 2 validators (Section 3.11). The experiments were repeated ${nR} times on a fresh network each; Table @push gives the results. B6 decides in ${plc('push', 100)} ms at 100 devices against ${plc('bczta', 100)} ms for BC-ZTA, so the two are equivalent for access latency. B6 enforces a revocation after ${f0(P2.push.mean_ms)} ms on average (worst case ${f0(P2.push.max_ms)} ms), which is ${f0(P2['bczta-q2'].mean_ms / P2.push.mean_ms)}× faster than BC-ZTA with quorum (${f1(P2['bczta-q2'].mean_ms / 1000)} s, worst case ${f1(P2['bczta-q2'].max_ms / 1000)} s), because BC-ZTA must wait for a block. The read quorum changes the mean latency at 100 devices from ${plc('bczta', 100)} to ${plc('bczta-q2', 100)} ms, since only cache misses read from two nodes, and ${pl('bczta-q2', 100).quorum_mismatch === 0 ? 'no quorum mismatch occurred' : pl('bczta-q2', 100).quorum_mismatch + ' quorum mismatches occurred'} in the runs. The result is that a trusted central operator who pushes revocations matches BC-ZTA’s latency and revokes faster; what the ledger provides that B6 cannot is that no single operator holds identity, policy and audit records, and that anchored audit can be verified by the other consortium members. Where one operator is acceptable, B6 is the simpler design.`, { keepNext: true }));
  push(table(`TABLE @push. CENTRAL DIRECTORY WITH PUSH REVOCATION (B6) AND READ QUORUM (${nR} RUNS)`, [1500, 800, 800, 800, 960],
    ['System', '25 dev.', '100 dev.', '200 dev.', 'Revoc. (ms)'], [
      ['B6 push', plc('push', 25), plc('push', 100), plc('push', 200), f0(P2.push.mean_ms)],
      ['BC-ZTA', plc('bczta', 25), plc('bczta', 100), plc('bczta', 200), 'see Table @iam'],
      ['BC-ZTA, quorum 2', plc('bczta-q2', 25), plc('bczta-q2', 100), plc('bczta-q2', 200), f0(P2['bczta-q2'].mean_ms)],
    ], { left: true, note: `Mean latency (ms) ± 95% CI of ${nR} runs; revocation: mean of ${P2.push.n} (B6) and ${P2['bczta-q2'].n} (quorum) samples. TTL 30 s (latency), 10 s (revocation).` }));
  const c3 = P3.bczta, c3p = P3.push, avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const pc = (c, k) => f0(100 * avg(c.summary[k]));
  chk(c3.ttl_s * 2 === c3.stale_bound_s, 'stale bound');
  push(P(`Section 6.8 stopped Keycloak or OpenLDAP, a service BC-ZTA does not use. The fair test is the loss of each design’s own state source with the same cache policy (TTL ${c3.ttl_s} s, serve-stale bound 2·TTL = ${c3.stale_bound_s} s, 50 devices): the PEP of BC-ZTA is cut off from its ledger node with a firewall rule (*iptables* DROP) for ${c3.restore_at_s - c3.cut_at_s} s, and the directory of B6 is stopped for the same time (Table @cut, Fig. 9, ${c3.reps} runs). Both designs behave alike: requests are granted from cache and then from stale state (${pc(c3, 'granted_cut_0_to_ttl')}% and ${pc(c3p, 'granted_cut_0_to_ttl')}% granted in the first ${c3.ttl_s} s after the loss), granted fractions fall to ${pc(c3, 'granted_after_2ttl')}% and ${pc(c3p, 'granted_after_2ttl')}% once the last read is older than ${c3.stale_bound_s} s, and service resumes ${f0(avg(c3.summary.seconds_to_recover.map(x => x ?? 0)))} s and ${f0(avg(c3p.summary.seconds_to_recover.map(x => x ?? 0)))} s after the source returns. The first denials appear ${f0(avg(c3.summary.seconds_until_denials))} s (BC-ZTA) and ${f0(avg(c3p.summary.seconds_until_denials))} s (B6) after the loss rather than after ${c3.stale_bound_s} s, because the bound of each cache entry runs from its own last successful read, which lies up to one TTL before the loss; the first reads that hit the unreachable ledger also wait for the ${(2.5).toFixed(1)} s read timeout, which is why BC-ZTA grants slightly less than B6 in the first window. The ledger therefore gives no extra availability by itself in this test; any cache with a stale bound provides the same short-outage behaviour. What differs is that the BC-ZTA state is replicated on four validators and the PEP could read from another node, which we did not implement as automatic failover in this test, while the directory of B6 is a single service unless it is replicated too.`, { keepNext: true }));
  push(table(`TABLE @cut. LOSS OF THE STATE SOURCE (TTL ${c3.ttl_s} S, STALE BOUND ${c3.stale_bound_s} S, ${c3.reps} RUNS)`, [1800, 560, 560, 660, 600, 780],
    ['System (source lost)', 'Before', '≤ TTL', 'TTL–2TTL', '> 2TTL', 'Restored'], [
      ['BC-ZTA (ledger node)', pc(c3, 'granted_before'), pc(c3, 'granted_cut_0_to_ttl'), pc(c3, 'granted_ttl_to_2ttl'), pc(c3, 'granted_after_2ttl'), pc(c3, 'granted_after_restore')],
      ['B6 (directory)', pc(c3p, 'granted_before'), pc(c3p, 'granted_cut_0_to_ttl'), pc(c3p, 'granted_ttl_to_2ttl'), pc(c3p, 'granted_after_2ttl'), pc(c3p, 'granted_after_restore')],
    ], { left: true, note: 'Requests granted (%) in the windows after the loss of the state source; windows are relative to the time of the loss.' }));
  push(fig('fig9_failclosed.png', 'Fig. 9. Requests granted while the state source is lost (shaded); dotted lines: TTL and 2·TTL after the loss.', 322));
  const h4 = P4 && P4.length ? P4 : null;
  if (h4) {
    const hm = k => avg(h4.map(r => r[k]).filter(x => x != null));
    push(P(`To test the consensus assumption we stopped two of the four validators for ${h4[0].halt_s} s (IBFT 2.0 needs three, so block production halts) while 50 devices were served and a device was revoked ${h4[0].revoke_submitted_at_s - h4[0].halt_at_s} s after the stop. The PEP kept answering: ${f0(100 * avg(h4.map(r => r.decisions_granted.during_halt)))}% of the requests were granted during the halt, as the cache and the still-reachable node serve the last committed state. The revoked device, however, stayed accepted until consensus resumed and the transaction was mined: enforcement came ${f1(hm('revocation_enforced_after_restart_ms') / 1000)} s after the validators were restarted and ${f1(hm('revocation_enforced_after_submit_ms') / 1000)} s after submission (${h4.length} run${h4.length > 1 ? 's' : ''}). The staleness bound of BC-ZTA therefore runs from finalisation of the revocation, not from its submission, and a consensus halt is a window in which revocations cannot take effect; a central directory is not affected by this particular failure. The delay is much longer than the halt itself (${h4[0].halt_s} s): block production stayed frozen for ${f0(hm('revocation_enforced_after_restart_ms') / 1000)} s after the validators were restarted. This is consistent with the round-change rule of IBFT 2.0, in which the timeout of a round doubles after each failed round (base 4 s in our configuration), so the surviving and the restarted validators needed one long round to agree again; shorter base timeouts or supervised automatic restarts of validators would reduce it, and an operator that needs bounded revocation latency during a halt must additionally enforce revocations at the PEP by a short-lived local deny list.`));
  }
  const kk = Object.keys(P5).sort((a, b) => a - b);
  const rates = k => Object.keys(P5[k]).map(Number).sort((a, b) => a - b);
  const clean = k => Math.max(...rates(k).filter(r => P5[k][String(r)].fail === 0 && P5[k][String(r)].p95_ms[0] < 50));   // highest offered rate without failures and with P95 < 50 ms
  const hiR = Math.max(...rates(kk[0]).filter(r => kk.every(k => P5[k][String(r)] && P5[k][String(r)].fail >= 0)).filter(r => r <= 800));
  if (kk.length) {
    chk(kk.every(k => isFinite(clean(k))), 'every PEP count needs one clean rate');
    push(P(`Finally, per-PEP capacity is not a limit of the architecture if gateways are replicated. We ran k = ${kk.join(', ')} PEP processes on one ${process.env.PEP_VM_DESC || '4-vCPU'} VM, with devices sharded across them, and raised the offered rate (Fig. 10, Table @scale). The highest offered rate served without any failed request and with a P95 below 50 ms was ${kk.map(k => f0(clean(k)) + ' req/s for k = ' + k).join(', ')}. At ${hiR} req/s offered, ${kk.slice(0, -1).map(k => 'k = ' + k + ' is overloaded (goodput ' + f0(P5[k][String(hiR)].goodput[0]) + ' req/s, P95 ' + f1(P5[k][String(hiR)].p95_ms[0] / 1000) + ' s)').join(' and ')}, whereas k = ${kk[kk.length - 1]} delivers ${f0(P5[kk[kk.length - 1]][String(hiR)].goodput[0])} req/s (${f0(100 * P5[kk[kk.length - 1]][String(hiR)].goodput[0] / hiR)}% of the offered rate) at a P95 of ${f0(P5[kk[kk.length - 1]][String(hiR)].p95_ms[0])} ms while using ${f1(P5[kk[kk.length - 1]][String(hiR)].cpu[0])} cores of the ${process.env.PEP_VM_DESC || '4-vCPU'} VM. Beyond that the goodput of every configuration falls as the offered rate rises (overload collapse: requests queue behind signature verification and time out), so a deployment must keep the rate per gateway below its knee, which an admission limit or load balancer would enforce. Scale-out was measured on one host; across hosts the shared state is the ledger, which is read once per device per TTL.`, { keepNext: true }));
    push(table(`TABLE @scale. PEP SCALE-OUT (BC-ZTA, ${nR} RUNS)`, [1100, 1500, 1200, 1200, 1000],
      ['PEPs', 'Clean rate (req/s)', `Goodput at ${hiR} (req/s)`, `P95 at ${hiR} (ms)`, `CPU cores at ${hiR}`], kk.map(k => {
        const v = P5[k][String(hiR)];
        return [String(k), f0(clean(k)), f0(v.goodput[0]), f0(v.p95_ms[0]), v.cpu[0] != null ? f1(v.cpu[0]) : 'n/a'];
      }), { left: true, note: 'Clean rate = highest offered rate with no failed request and P95 < 50 ms; one VM; load generator on a separate VM; mean of the runs.' }));
    push(fig('fig10_scaling.png', 'Fig. 10. Goodput (left) and P95 latency (right) versus offered request rate for 1, 2 and 4 PEP processes.', 322));
  }
}
push(H2((HAVE_XR ? '6.11' : '6.10') + ' Comparison with Baselines'));
push(P(`BC-ZTA is ${f1(e('bczta', 50).mean_ms - e('abac', 50).mean_ms)} ms slower than a ledger-free ABAC store at 50 devices but adds decentralised identity, shared policy and tamper-evident anchored audit that B2 lacks; against the centralised PKI-IAM it is ${pct(e('bczta', 50).mean_ms, e('central', 50).mean_ms)}% faster at 50 devices (with a 40 ms netem delay on the directory server) and removes the central directory; and against the synchronous blockchain it avoids ~${f1(e('bcsync', 50).mean_ms / 1000)} s per decision at 50 devices and the ledger ceiling. Against real Keycloak and OpenLDAP services (Section 6.8) it is ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× and ${f0(xe('ldap', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster at 100 devices, but a PEP-side cache gives similar mean latency at the cost of stale revocations${HAVE_XR ? ', and a central directory with pushed revocations (Section 6.10) matches its latency and revokes faster' : ' (when those services are stopped, BC-ZTA keeps granting access, but that test removes a service BC-ZTA does not use)'}. Its price is revocation latency: about ${f1(E.E2['bczta-events'].mean_ms / 1000)} s with events (one block) instead of about ${f0(x2('keycloak').mean_ms)} ms for a central store. A reported Ethereum-based framework pays about 25 ms extra per request even at small scale {{singh}}, consistent with our finding that on-path consensus is the bottleneck.`));
push(H2(DISC + ' Discussion and Limitations'));
push(P(`The key trade-off is bounded revocation staleness for latency.${HAVE_XR ? ' The push baseline of Section 6.10 shows that this trade-off is not specific to the ledger: a trusted central operator obtains the same latency and a faster revocation, so the ledger has to be justified by who controls the identity state and who can verify the audit, not by speed.' : ''} Limitations: (i) the seven VMs sit in one zone of one cloud provider, so inter-VM delay is that of a data-centre network plus the injected netem delays, not a plant network or a WAN, and absolute latencies and throughput are specific to these VM sizes; (ii) B1–B3 are simple re-implementations; Keycloak ran in development mode (single node, embedded H2 database) and OpenLDAP as a single server, both behind an emulated 40 ms WAN, so production-tuned or clustered deployments may behave differently, particularly for availability; (iii) the device population is emulated by a load generator with up to 200 devices at 1 request/s: no physical devices, industrial protocols, secure elements, larger populations or bursty and churn-heavy workloads were used; (iv) one plant authority key issues registrations and revocations, so authority compromise is out of scope; (v) the availability tests are limited: the E4 flood was partly rejected by Besu (an accepted rate of ${f0(Math.min(...E.E4.bczta_under_flood.flood.map(x => x.sent)) / 35)}–200 tx/s) and E5 stops one validator once for 30 s${HAVE_XR ? ' and Section 6.10 stops two for 40 s' : ''}, with no network partition or Byzantine validator; (vi) each experiment has five repetitions (three for the IAM tests and two for the flood sweep) on the same VMs, the revocation tests use 8 devices per run, and a single-process PEP saturates at roughly 250–290 req/s, so larger sites need several PEPs${HAVE_XR ? ' (scale-out was measured on one host only)' : ''}; and (vii) trust scores are voted values, not yet learned from data. Comparisons with published numbers are indicative only, since workloads and testbeds differ.`));
push(P(`Further limitations follow from the security analysis (Section 4.6). The nonce cache is per gateway and the signed request carries no gateway identifier, so a captured request can be replayed once at another gateway within Δ; the default read path trusts one ledger node (the quorum option is implemented${HAVE_XR ? ', and its cost is measured in Section 6.10, but it' : ' but'} is not part of the default measurements); audit completeness is not protected against a compromised gateway; the Merkle epoch proof shows enrolment, not freshness; and the device-side cost of signing and proof storage was not measured, so the claim of compatibility with constrained devices (D5) is an argument, not a result. Each request is signed individually, which is appropriate for access decisions but not for high-rate telemetry, where a session credential issued after one verified request would be used. All statistical statements rest on 2–5 repetitions with standard deviations or 95% confidence intervals and no hypothesis tests.`));
push(P('Deployment considerations. First, validators must be run by independent parties (plant, integrator, vendor) for the Byzantine assumption to mean anything. Second, device keys should live in a secure element or TPM, because the architecture’s identity guarantees are only as strong as key custody. Third, on-chain records contain key hashes, scores and event hashes, not process data, which keeps operational data off the shared ledger. Fourth, in the prototype AuditLog and grantSession are callable by any account, and production deployments would restrict them to gateway identities. Fifth, the fail-closed rule of Section 3.10 trades availability for safety during ledger partitions and should be tuned against plant uptime requirements.'));

// ---- 7 CONCLUSION
push(H1('7. Conclusion'));
push(P(`We presented BC-ZTA, a blockchain-assisted zero-trust architecture that keeps consensus off the per-request path through edge-cached, Merkle-verified state and asynchronous batched anchoring. Four Solidity contracts pass 15 unit tests, and measured gas shows batch anchoring is ${f0(gasRatio(50))}–${f0(gasRatio(1000))}× cheaper per record than per-event logging for batches of 50–1,000 records. In end-to-end tests on a seven-VM Google Cloud deployment with a four-validator Besu network, BC-ZTA decided in ${f1(e('bczta', 50).mean_ms)} ms on average at 50 devices and served 200 devices without failures with about one on-chain write per second, and kept deciding while one validator was stopped, while the synchronous design needed ${f1(e('bcsync', 50).mean_ms / 1000)} s at 50 devices and answered only ${f0(100 * e('bcsync', 200).success_ratio)}% of the requests at 200 devices; the price is a revocation delay of about ${f1(E.E2['bczta-events'].mean_ms / 1000)} s with event-driven invalidation.${XR ? ` A baseline with a central directory and pushed revocations, which we added to test whether the ledger is needed for speed, has the same latency and revokes in ${f0(XR.P2.push.mean_ms)} ms; the case for the ledger therefore rests on removing any single operator’s control over identity state and on audit that third parties can verify, not on performance. A fail-closed bound of twice the cache lifetime, a read quorum of two validators, replicated gateways and the behaviour during a consensus halt (revocations wait for consensus, here ${f0(XR.P4.reduce((x, r) => x + r.revocation_enforced_after_submit_ms, 0) / XR.P4.length / 1000)} s on average) are evaluated in Section 6.10.` : ''} All forged, replayed, stale, unregistered, tampered and policy-violating requests were rejected. The evaluation used cloud VMs in a single zone with injected network delay and an emulated device population. Future work includes a multi-site Besu deployment with real network delay, physical devices and industrial protocols, clustered production IAM baselines, learning-based trust scoring and post-quantum signatures.`));

// =============================== REFERENCES ==========================================
if (order.length !== Object.keys(REFS).length) {
  const missing = Object.keys(REFS).filter(k => !order.includes(k));
  console.error('UNCITED REFS:', missing.join(', '));
}
const refParas = [];
order.forEach((k, i) => {
  const r = REFS[k];
  const base = { font: FONT, size: 15 };
  const kids = [new TextRun({ ...base, text: `[${i + 1}]\t` })];
  const t = r.text;
  const mDoi = t.match(/doi: (\S+?)\.?$/);
  const mAx = t.match(/arXiv:\d+\.\d+/);
  if (mDoi) {
    const idx = t.lastIndexOf('doi: ');
    kids.push(new TextRun({ ...base, text: t.slice(0, idx) }));
    kids.push(new ExternalHyperlink({ link: r.url, children: [new TextRun({ ...base, text: t.slice(idx), color: '0563C1', underline: {} })] }));
  } else if (mAx) {
    const idx = t.indexOf(mAx[0]);
    kids.push(new TextRun({ ...base, text: t.slice(0, idx) }));
    kids.push(new ExternalHyperlink({ link: r.url, children: [new TextRun({ ...base, text: t.slice(idx), color: '0563C1', underline: {} })] }));
  } else {
    kids.push(new TextRun({ ...base, text: t + ' [Online]. Available: ' }));
    kids.push(new ExternalHyperlink({ link: r.url, children: [new TextRun({ ...base, text: r.url, color: '0563C1', underline: {} })] }));
  }
  refParas.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 20, line: 200 },
    indent: { left: 280, hanging: 280 }, tabStops: [{ type: docx.TabStopType.LEFT, position: 280 }], children: kids }));
});

// ================================ FRONT MATTER =======================================
const front = [
  new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 160 }, children: [new TextRun({ text: 'Date of publication xxxx 00, 0000, date of current version xxxx 00, 0000. Digital Object Identifier 10.1109/ACCESS.2026.0000000', font: FONT, size: 15, italics: true })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
    children: [new TextRun({ text: 'Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable Industrial Internet of Things (IIoT)', font: FONT, size: 36 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 },
    children: [new TextRun({ text: '[Author Name(s)]', font: FONT, size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 140 },
    children: [new TextRun({ text: '[Department, Institution, City, Country]', font: FONT, size: 18, italics: true })] }),
  new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 100 }, indent: { left: 360, right: 360 }, children: [new TextRun({ text: 'Corresponding author: [Name] (e-mail: [address]). This work was supported in part by [funding source and grant number].', font: FONT, size: 16 })] }),
  new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 60, line: 228 }, indent: { left: 360, right: 360 }, children: [
    new TextRun({ text: 'ABSTRACT ', font: FONT, size: 18, bold: true }),
    ...runs(HAVE_XR ? `Industrial IoT (IIoT) networks need per-request verification, but a blockchain on the authentication path adds seconds of latency and saturates ledger capacity. We propose BC-ZTA, a three-tier blockchain-assisted zero-trust architecture in which edge policy enforcement points decide from cached, Merkle-verified ledger state, while identity, trust and audit updates are written asynchronously to a permissioned Hyperledger Besu (IBFT 2.0) network. We implemented the enforcement point and six baselines, including real Keycloak and OpenLDAP services and a central directory with pushed revocations, and measured them on a four-validator network of seven cloud VMs. At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms, against ${f1(e('central', 50).mean_ms)} ms for a centralised directory with a 40 ms network delay and ${f0(e('bcsync', 50).mean_ms)} ms when every request is an on-chain transaction; that synchronous design answers only ${f0(100 * e('bcsync', 200).success_ratio)}% of requests at 200 devices, whereas BC-ZTA served 200 devices without failures. Event-driven invalidation enforces a revocation in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s, and all ${f0(Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0))} attack requests were rejected. Batch anchoring cuts audit gas per record ${f0(gasRatio(50))}- to ${f0(gasRatio(1000))}-fold. Keycloak and OpenLDAP revoke in about ${f0(x2('keycloak').mean_ms)} ms but decide ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× slower at 100 devices. A central directory with pushed revocations and no blockchain matches the latency of BC-ZTA and revokes in ${f0(XR.P2.push.mean_ms)} ms, so the ledger buys trust distribution and verifiable audit, not speed. Both designs fail closed after twice the cache lifetime when their state source is lost, and a consensus halt delays revocations by minutes. Limitations are a single cloud zone, emulated devices and single-node IAM products.` : `Industrial IoT (IIoT) networks need continuous, per-request verification, but placing a blockchain on the authentication path adds seconds of latency and saturates ledger capacity. We propose BC-ZTA, a three-tier blockchain-assisted zero-trust architecture in which edge policy enforcement points decide from cached, Merkle-verified ledger state, while identity, trust and audit updates are written asynchronously to a permissioned Hyperledger Besu (IBFT 2.0) network through four Solidity contracts. We implemented the policy enforcement point and five baselines, including real Keycloak and OpenLDAP services, and measured them end to end on a four-validator Besu network (five repetitions, seven cloud VMs). At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms on average, compared with ${f1(e('central', 50).mean_ms)} ms for a centralised directory with an injected 40 ms network delay and ${f0(e('bcsync', 50).mean_ms)} ms when every request is an on-chain transaction; the synchronous design answers only ${f0(100 * e('bcsync', 200).success_ratio)}% of the requests at 200 devices, whereas BC-ZTA served 200 devices with no failures and about one on-chain write per second, and kept deciding while one of the four validators was stopped. Event-driven cache invalidation enforces a revocation in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s on average, and all ${f0(Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0))} forged, replayed, stale, unregistered, tampered or policy-violating requests were rejected. Merkle batch anchoring cuts audit gas per record by ${f0(gasRatio(50))}× to ${f0(gasRatio(1000))}× for batches of 50 to 1,000 records. Against real Keycloak and OpenLDAP services, BC-ZTA decides ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster at 100 devices but revokes in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s rather than about ${f0(x2('keycloak').mean_ms)} ms, and its latency (P95 ≤ 8 ms) holds when the ledger is flooded up to 1,200 tx/s. ${XR ? `A central directory that pushes revocations without a blockchain matches its latency and revokes in ${f0(XR.P2.push.mean_ms)} ms, so the ledger buys trust distribution and independently verifiable audit, not speed; both designs fail closed after twice the cache lifetime when their state source is lost, and a consensus halt delays revocations by minutes.` : ''} Limitations are the single cloud zone with injected network delay, single-node IAM products, a single-process PEP and the emulated device population.`, { size: 18, bold: false }).map(x => x),
  ] }),
  new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 100 }, indent: { left: 360, right: 360 }, children: [
    new TextRun({ text: 'INDEX TERMS ', font: FONT, size: 18, bold: true }),
    new TextRun({ text: 'Access control, blockchain, Hyperledger Besu, industrial Internet of Things, scalability, smart contracts, zero trust.', font: FONT, size: 18 }),
  ] }),
];

// ================================ DOCUMENT ==========================================
const pageProps = { page: { size: { width: 12240, height: 15840 }, margin: { top: 1000, bottom: 1000, left: 1080, right: 1080 } } };
const footer = new Footer({ children: [new Paragraph({ tabStops: [{ type: docx.TabStopType.RIGHT, position: 10080 }],
  children: [new TextRun({ text: 'AUTHOR et al.: Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable IIoT', font: FONT, size: 15, italics: true }),
    new TextRun({ text: '\tVOLUME XX, 2026  |  ', font: FONT, size: 15 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 15 })] })] });

const doc = new Document({
  creator: 'Author', title: 'Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable IIoT',
  styles: { default: { document: { run: { font: FONT, size: BODY } } } },
  sections: [
    { properties: { ...pageProps, type: SectionType.CONTINUOUS }, footers: { default: footer }, children: front },
    { properties: { ...pageProps, type: SectionType.CONTINUOUS, column: { count: 2, space: 360, equalWidth: true } }, footers: { default: footer },
      children: [...body, H1('Acknowledgment'), P('[Funding sources and acknowledgments to be added by the authors.]'), H1('Data and Code Availability'), P('The Solidity contracts, the PEP and load-generator code, the Google Cloud deployment scripts and all raw results used in this paper are available at https://github.com/irfanrazanaqvi/bc-zta-iiot-experiments (archived release with DOI: [to be added by the authors before submission]).'), H1('References'), ...refParas, H1('Author Biographies'), P('**[AUTHOR NAME]** [Short biography, degrees, current position and research interests to be added; IEEE Access also requires a photo.]', {})] },
  ],
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
Packer.toBuffer(doc).then(b => { fs.writeFileSync(OUT, b); console.log('written', OUT, 'refs', order.length); });
