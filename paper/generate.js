const fs = require('fs');
const path = require('path');
const docx = require('docx');
const ALT = {
 "fig1_architecture.png": "Three-layer diagram. Bottom: IIoT devices (PLC, sensor, edge gateway, fog node, SDN switch). Middle: the edge zero-trust layer with PEP, PDP/ABAC, trust engine, Merkle-verified state cache and micro-segmentation. Top: the permissioned Besu blockchain with identity registry, trust reputation, access control, audit log and IBFT 2.0 validators.",
 "fig2_workflow.png": "Six-step flow of one request: the device sends a signed request, the PEP checks time window and nonce, the PDP reads the cached DID entry with a Merkle proof, applies trust score and ABAC policy, and then allows or denies. A side branch batches audit votes to the blockchain asynchronously, off the request path.",
 "fig3_latency.png": "Line chart, log scale. BC-ZTA and ABAC stay near 5 ms from 10 to 200 devices, the central directory near 49 ms, and the synchronous blockchain rises from about 1 s to over 10 s.",
 "fig4_scalability.png": "Two panels. Panel (a): BC-ZTA, ABAC and the central directory serve the full offered load up to 200 devices; the synchronous blockchain peaks near 100 requests per second and falls at 200 devices. Panel (b): on-chain writes stay near zero for BC-ZTA and reach about 100 per second for the synchronous design.",
 "fig5_revocation.png": "Bar chart, log scale, of mean revocation delay. Central PKI-IAM about 0.06 s, ABAC about 0.02 s, blockchain-only synchronous about 1.4 s, BC-ZTA with events about 1.3 s, BC-ZTA with a 10 s TTL about 6.6 s; markers show worst cases.",
 "fig6_iam_latency.png": "Grouped bars for 25, 100 and 200 devices. Uncached Keycloak and OpenLDAP take about 47 to 50 ms mean at 25 and 100 devices; their cached variants and BC-ZTA take 6 to 10 ms. At 200 devices Keycloak is near 120 ms, OpenLDAP near 77 ms and BC-ZTA near 117 ms; P95 follows the same pattern.",
 "fig7_iam_outage.png": "Timeline of requests granted. When the central IAM service stops at 20 s, Keycloak, OpenLDAP and their cached variants fall to 0 percent until the service restarts; BC-ZTA stays at 100 percent throughout.",
 "fig8_flood.png": "Two panels versus offered flood rate up to 1,200 transactions per second. Panel (a): committed rate for both designs levels off near 200. Panel (b): access P95 latency stays under about 8 ms for BC-ZTA and rises from about 2 s to about 30 s for the synchronous ledger.",
 "fig9_failclosed.png": "Timeline of requests granted when the state source is lost from 20 s to 70 s. BC-ZTA and the central directory with push revocation both keep granting until about 30 s, then deny all requests until the source returns.",
 "fig10_scaling.png": "Two panels versus offered request rate for one, two and four PEP processes. Goodput follows the offered load up to about 800 requests per second, then drops; with one PEP it peaks near 450 and with four near 750. P95 latency rises sharply after saturation, later with more PEPs."
};
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  BorderStyle, ShadingType, ExternalHyperlink, SectionType, Footer, PageNumber, VerticalAlign, TableLayoutType } = docx;
const REFS = require('./refs.js');
const AYR = require('./refs_ay.js')(REFS);
const RES = JSON.parse(fs.readFileSync('/tmp/claude-0/work/pkg/code_package/simulation/output/raw_results.json'));
const FIG = '/tmp/claude-0/work/figs/';
const MODDIR = '/home/claude/bc-zta-iiot-experiments/benchmark/results/model-2026-11-27/';
const MA = JSON.parse(fs.readFileSync(MODDIR + 'analytic_model.json')), MC = JSON.parse(fs.readFileSync(MODDIR + 'model_check.json'));
const OUT = process.argv[2] || '/tmp/claude-0/work/out/paper.docx';

const FONT = 'Times New Roman';
const CSI = process.env.JOURNAL === 'csi';      // Computer Standards & Interfaces variant (as COSE plus standards paragraph and postal address)
const COSE = process.env.JOURNAL === 'cose' || CSI;   // Computers & Security variant (security-led title, abstract, highlights)
const AY = process.env.JOURNAL === 'cose' && process.env.FORMAT === 'elsevier' && process.env.CITE !== 'num';   // Computers & Security: author-year citations
const FG2 = process.env.JOURNAL === 'fgcs';   // FGCS two-column submission (<=18 pages incl. references)
const ELS = process.env.FORMAT === 'elsevier';   // Elsevier (FGCS) manuscript layout: single column, A4, 11 pt
const BODY = ELS ? 22 : 20;        // half-points
const SMALL = ELS ? 18 : 15;
const TS = ELS ? 1.85 : 1;         // table width scale (one column -> full text width)
const FIGSC = ELS ? 1.65 : 1;         // figure width scale
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
  if (AY) {
    keys.forEach(num);
    const L = keys.slice().sort((a, b) => AYR.label(a).localeCompare(AYR.label(b)) || AYR.yr(a).localeCompare(AYR.yr(b)));
    return '(' + L.map(AYR.label).join('; ') + ')';
  }
  const ns = keys.map(num).sort((a, b) => a - b);
  if (ELS) {   // Elsevier numeric style: [1], [2,5], [3–6]
    const g = []; let a = 0;
    while (a < ns.length) { let b = a; while (b + 1 < ns.length && ns[b + 1] === ns[b] + 1) b++; if (b - a >= 2) g.push(`${ns[a]}–${ns[b]}`); else for (let k = a; k <= b; k++) g.push(String(ns[k])); a = b + 1; }
    return '[' + g.join(', ') + ']';
  }
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
const TORDER=['related','model','threat','lat','gas','sec','iam','outage','push','cut','scale','audit','tamper','claims'];
function fixTab(t){return t.replace(/(TABLE|Table) @(\w+)/g,(m,w,k)=>w+' '+(TORDER.indexOf(k)+1));}
function fixSec(t){if(ELS)return t;return t.replace(/Section (\d+)(?:\.(\d+))?/g,(m,a,b)=>'Section '+ROM[+a]+(b?'-'+LET[+b-1]:''));}
// ---------------- inline markup: **bold**, *italic*, {{ref1,ref2}} -----------------------
const HAVE_XR = !!XR_EXISTS();
function XR_EXISTS() { try { return require('fs').existsSync(process.env.ROBUST_JSON || '/tmp/claude-0/full/agg2/aggregate_robust.json'); } catch (e) { return false; } }
const DISC_N = HAVE_XR ? '6.15' : '6.14', DISC = HAVE_XR ? '6.16' : '6.15';
const S_AUD = HAVE_XR ? '6.11' : '6.10', S_REG = HAVE_XR ? '6.12' : '6.11', S_OPT = HAVE_XR ? '6.13' : '6.12', S_CMP = HAVE_XR ? '6.14' : '6.13';
const OT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'benchmark', 'results', 'local-verify-2026-11-08', 'operator_tamper.json'), 'utf8'));
const SL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'benchmark', 'results', 'local-verify-2026-11-08', 'slither.json'), 'utf8')).results.detectors;
const slN = (imp) => SL.filter(x => x.impact === imp).length;
const AV2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'benchmark', 'results', 'local-verify-2026-11-08', 'audit_v2.json'), 'utf8'));
const AV = JSON.parse(fs.readFileSync(process.env.AUDIT_JSON || path.join(__dirname, '..', 'benchmark', 'results', 'local-verify-2026-11-08', 'audit_verify.json'), 'utf8'));
const avA = n => AV.A.find(r => r.batch === n), avB = n => AV.B.find(r => r.devices === n);
function tok(t) {
  return t.replace(/\[\[(\w+)\]\]/g, (m, k) => ({
    DISC: 'Section ' + DISC,
    S12K: HAVE_XR ? 'the *k* = 2 rule is evaluated in Section 6.10' : 'the *k* = 2 rule is described here but was not evaluated in this version of the paper',
    S12Q: HAVE_XR ? 'the cost of the quorum is reported in Section 6.10' : 'the cost of the quorum was not measured in this version of the paper',
    S_OPT_REF: '(Section ' + S_OPT + ')',
    S12R: HAVE_XR ? '(Section 6.10)' : '(this case was not tested)',
    S12O: HAVE_XR ? '(Section 6.10)' : '(not tested in this version of the paper)',
  }[k] ?? m));
}
function narrative(text) {   // author-year: 'Zanasi et al. combine ... {{zanasi}}' -> 'Zanasi et al. (2024) combine ...'
  let guard = 0, m;
  const re = /\s?\{\{(\w+)\}\}/g;
  while ((m = re.exec(text)) && guard++ < 200) {
    const k = m[1]; if (!REFS[k]) continue;
    let ss = 0; { const b = /(?<!\bal)\.\s(?=[A-Z])|;\s/g; let x; const pre = text.slice(0, m.index); while ((x = b.exec(pre))) ss = x.index; }
    const seg = text.slice(ss, m.index), nm = AYR.name(k), at = seg.indexOf(nm);
    if (at < 0 || seg.slice(at).includes('{{') || /^’s/.test(seg.slice(at + nm.length)) || (at > 0 && /[A-Za-z]/.test(seg[at - 1]))) continue;
    num(k);
    const y = AYR.yr(k), pos = ss + at + nm.length;
    text = text.slice(0, pos) + ' (' + y + ')' + text.slice(pos, m.index) + text.slice(m.index + m[0].length);
    re.lastIndex = 0;
  }
  return text;
}
function runs(text, o = {}) {
  text = fixTab(fixSec(tok(text)));
  if (AY) { text = narrative(text); }
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
const P0 = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { after: o.after ?? (ELS ? 100 : 60), before: o.before ?? 0, line: o.line || (ELS ? 276 : 228) },
  indent: o.indent, keepNext: o.keepNext, keepLines: o.keepLines,
  children: runs(t, o),
});
const H1_0 = t => ELS ? new Paragraph({ heading: docx.HeadingLevel.HEADING_1, alignment: AlignmentType.LEFT, keepNext: true, spacing: { before: 280, after: 120 }, children: [new TextRun({ text: t, font: FONT, size: 26, bold: true, color: '000000' })] }) : new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 60 },
  children: [new TextRun({ text: t.replace(/^(\d+)\.\s*/, (m,a)=>ROM[+a]+'. ').toUpperCase(), font: FONT, size: 18 })] });
const H2_0 = t => ELS ? new Paragraph({ heading: docx.HeadingLevel.HEADING_2, alignment: AlignmentType.LEFT, keepNext: true, spacing: { before: 180, after: 80 }, children: [new TextRun({ text: t.replace(/^(\d+\.\d+)\s*/, '$1. '), font: FONT, size: 22, bold: true, color: '000000' })] }) : new Paragraph({ alignment: AlignmentType.LEFT, keepNext: true, spacing: { before: 60, after: 30 },
  children: [new TextRun({ text: t.replace(/^(\d+)\.(\d+)\s*/, (m,a,b)=>LET[+b-1]+'. '), font: FONT, size: BODY, italics: true })] });
const tag = (x, o) => { x._tex = o; return x; };
const P = (t, o = {}) => tag(P0(t, o), { k: 'p', t, o });
const H1 = t => tag(H1_0(t), { k: 'h1', t });
const H2 = t => tag(H2_0(t), { k: 'h2', t });
const BUL = (t) => tag(P0(t, { indent: { left: 200, hanging: 200 }, after: 30 }), { k: 'bul', t });

// ---------------- figures & tables -----------------------------------------------------
function fig(file, caption, wPx) { const r = fig0(file, caption, wPx); r[0]._tex = { k: 'fig', file, caption }; return r; }
function fig0(file, caption, wPx) {
  wPx = Math.round(wPx * FIGSC);
  const sz = require('child_process').execSync(`python3 -c "from PIL import Image;im=Image.open('${FIG + file}');print(im.size[0],im.size[1])"`).toString().trim().split(' ').map(Number);
  const h = Math.round(wPx * sz[1] / sz[0]);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 40, after: 20 },
      children: [new ImageRun({ type: 'png', data: fs.readFileSync(FIG + file), transformation: { width: wPx, height: h },
        altText: { title: caption, description: ALT[file] || caption, name: file } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: runs(caption, { size: ELS ? 19 : 16 }) }),
  ];
}
const bd = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
function table(caption, widths, header, rows, o = {}) { const r = table0(caption, widths, header, rows, o); r[0]._tex = { k: 'table', caption, widths, header, rows, o }; return r; }
function table0(caption, widths, header, rows, o = {}) {
  widths = widths.map(w => Math.round(w * TS));
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
const TDF = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306 };   // Student t by degrees of freedom
const dci = (a, b, n) => { const d = a[0] - b[0], h = TDF[2 * (n - 1)] * Math.sqrt((a[1] ** 2 + b[1] ** 2) / n); return { d, lo: d - h, hi: d + h }; };   // difference of two means of n runs each (pooled df = 2n-2)
const fu = x => (Math.ceil(x * 10) / 10).toFixed(1);   // round up, so an upper bound is never understated
const sg = x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(1);
const fc = x => Math.round(x).toLocaleString('en-US');
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
push(H2('1.1 Background and Problem'));
push(P('An industrial IoT (IIoT) plant ties together PLCs, sensors, actuators, edge gateways and cloud analytics. Operational-technology networks used to rely on a hard perimeter and on devices trusting each other inside a segment. Remote maintenance and the merging of IT and OT have eroded that perimeter. A single compromised vendor laptop or sensor can now start lateral movement through the plant {{federici,zanasi}}. Zero trust, as NIST SP 800-207 describes it {{nist}}, replaces location-based trust with a check on every request. Recent reviews show the idea spreading into many application domains {{gambo,mushtaq,azad}}.'));
push(P('Four things make this hard in IIoT. First, devices are small and cannot carry heavy cryptography or monitoring agents. Second, protocols and vendors differ, so uniform identity management is awkward {{mthethwa}}. Third, a control loop leaves only a few milliseconds for a security decision. Fourth, thousands of devices keep joining, rotating keys and being revoked. A central identity or policy server becomes a single point of failure and an attractive target, and logs kept by the same operator cannot be checked independently {{mushtaq}}. Reading NIST together with its critics {{fernandez}}, we arrive at six needs: per-device cryptographic identity (**R1**), authorisation of every request by a policy decision point (PDP) enforced at a policy enforcement point (PEP) (**R2**), least-privilege short-lived sessions (**R3**), continuous trust assessment {{ma}} (**R4**), micro-segmentation (**R5**) and tamper-evident audit (**R6**), with R1–R5 fitting inside control-loop latency budgets. Our evaluation covers them unevenly. R1, R2 and R6 are tested end to end. R3 is tested only through contract unit tests and session lifetimes. R4 (trust scores are voted values, not learned) and R5 (no segmentation was deployed) stay at design level and are not evaluated.'));
push(H2('1.2 Why a Ledger, and What Is Missing'));
push(P('A permissioned blockchain can keep identity, policy and reputation state, plus an audit trail, in a form that plant, vendor and integrator domains share without any one of them having to be trusted. Earlier work has used it for zero-trust IoT access {{aleisa,nie}}, cross-domain digital-twin access {{ali}}, IIoT data protection {{essaid}} and contract-based access control {{li_hyper}}. We see three gaps. First, many designs place the ledger on the request path, at a visible price: one Ethereum-based zero-trust framework reports latency going from 49.33 ms to 74.0 ms and throughput falling from 50 to 30.77 req/s against a perimeter-based baseline {{singh}}. Second, few studies test how authentication and authorisation scale. Sharding-based work is the exception {{salim}}; most studies report detection accuracy or encryption cost instead {{sharma}}. Third, continuous tamper-proof audit is often named as an open problem {{mushtaq}}, and the cost rises once every event is written on-chain.'));
push(H2('1.3 Contributions'));
push(P('We propose a blockchain-assisted zero-trust architecture, BC-ZTA. Its access decisions never wait for consensus, the staleness of its cached state has a bound, and audit cost grows more slowly than the request rate.' + (HAVE_XR ? ' We also report what the ledger does not buy. A central directory that pushes revocations to the enforcement points decides as fast and revokes faster, so the case for the ledger is shared control of identity and policy state and audit that outside parties can check, not speed.' : '') + ' The contributions are:', { keepNext: true }));
push(BUL('•  **Architecture.** A three-tier design where the PEP and PDP decide from edge-cached, Merkle-verified ledger state, which keeps the blockchain *off* the request path (Section 3).'));
push(BUL('•  **Smart contracts.** Four Solidity contracts: an identity registry with epoch commitments, quorum-based trust reputation, ABAC access control, and an audit log with Merkle batch anchoring, plus an optional multisig admin contract. 18 unit tests pass. Trust scoring and micro-segmentation are design-level only; end-to-end evidence covers identity, access decisions, revocation and audit.'));
push(BUL('•  **Prototype and measurements.** A working PEP/PDP service and load generator, ' + (HAVE_XR ? 'six' : 'five') + ' baselines (central directory, local ABAC, synchronous blockchain, real Keycloak and OpenLDAP with and without a PEP cache' + (HAVE_XR ? ', and a central directory with pushed revocations' : '') + '), evaluated on seven Google Cloud VMs with a four-validator Hyperledger Besu IBFT 2.0 network: latency and goodput up to 200 devices, revocation delay, security tests, validator failure, central-service outage, ledger flooding' + (HAVE_XR ? ', loss of the state source, a consensus halt and PEP scale-out' : '') + ', and gas; local tests cover independent verification of tampered audit batches and Merkle proof cost up to one million devices (Sections 5–6).'));
push(BUL('•  **Security analysis and its limits.** An argument for each security goal under stated assumptions, and the risks that remain: replay across gateways, trust in a single ledger node, and incomplete audit (Section 4.6). A bounded model check of the replay and forgery properties shows the cross-gateway replay and that gateway binding removes it (Section 4.7). The evidence is negative testing, argument and a bounded check, not an unbounded proof.'));
push(BUL('•  **When a ledger is justified.** Against a central directory that pushes revocations to the enforcement points (B6) and against hash-chained logs, the ledger gives no gain in decision latency or revocation speed. What it adds is shared control of identity state among mutually distrusting domains, and audit anchors that an outside verifier can check (Sections 6.10 and 6.13).'));
push(BUL('•  **Analytical model of the ledger premium.** Event-driven invalidation brings the mean revocation delay down from ' + f1(E.E2['bczta-ttl'].mean_ms / 1000) + ' s to ' + f1(E.E2['bczta-events'].mean_ms / 1000) + ' s (Section 6.6). A closed-form model (Section 3.9) shows that the ledger adds *B*/2 to the expected revocation delay, independent of device count, and bounds stale service by *k*·*τ*. One fitted parameter predicts the other revocation figures within ' + Math.max(...['events_max_s','ttl_mean_s','ttl_max_s'].map(k => Math.round(100 * Math.abs(MA.revocation[k].rel_err)))) + '%.'));

// ---- 2 RELATED WORK
push(H1('2. Related Work'));
push(H2('2.1 Blockchain-Based Security for IIoT and IoT'));
push(P('Ledger-based security work for IIoT and IoT splits roughly into data protection, access control and identity. On the data side, Essaid and Ju combine blockchain, edge computing and smart contracts for integrity and threat detection {{essaid}}. For access control, Hyper-IIoT offers a contract-inspired scheme for constrained devices {{li_hyper}}, and Zhai et al. authenticate cross-domain IIoT devices with Chebyshev chaotic maps {{zhai}}. Two recent IIoT designs make large identity sets verifiable: Ding et al. prove identifier-to-key bindings in a DID registry with a sliding-window accumulator and an on-chain/off-chain query strategy {{ding25}}, and Xu et al. store DID documents of manufacturing entities in a Merkle structure on Hyperledger Fabric {{xu25}}. Both target the verifiability and query cost of the identity registry. BC-ZTA uses an epoch Merkle commitment for the same job, and it also measures per-request enforcement and revocation against production IAM baselines. A study of DIDs on IOTA found that generating an identifier loaded a Raspberry Pi far more than a PC {{ramirez}}. For scale, DAG ledgers have been proposed for intelligent buildings {{naqvi}}, and a smart-city framework with a lightweight adaptive proof-of-stake reports a threefold throughput gain and 30% lower latency than conventional blockchains {{islam}}.'));
push(H2('2.2 Zero Trust for IIoT'));
push(P('Most zero-trust designs for industrial networks have no ledger. Federici et al. built a zero-trust remote-access architecture for IIoT {{federici}}, and Zanasi et al. combine micro-segmentation, SDN and a central policy layer {{zanasi}}. Ma and Chiu add a risk-based access-control engine that rates a device by the behaviour of its neighbours {{ma}}, Mthethwa et al. address non-human identities in IoT {{mthethwa}}, and Wan et al. combine PUF-based device authentication with continuous location checks during a session {{wan25}}. Network-side micro-segmentation limits lateral movement inside the network and is complementary to the decision and revocation path studied here. Broader overviews include a survey of zero-trust architecture {{syed22}}, zero-trust foundation models for IoT {{li_ztfm}} and the applications and challenges of zero trust {{ghasemshirazi}}.'));
push(H2('2.3 Blockchain-Assisted Zero Trust'));
push(P('Work that combines the two is more recent. Aleisa pairs a blockchain-based ZTA with post-quantum and zero-knowledge techniques and reports 98% privacy preservation {{aleisa}}. Nie et al. use smart contracts with inner-product encryption for 6G IoT access control and report 14% better encryption efficiency and 18% lower access latency {{nie}}. Sharma et al. add federated transfer learning for Industry 5.0 {{sharma}}. Salim et al. {{salim}}, the closest work in title and venue, reach 2,500 TPS at 700 nodes in simulation, with trusted gateways and sharding driven by reinforcement learning. They optimise ledger throughput and adaptive trust; we claim neither, and we measure revocation delay and audit against production IAM services and a push-revocation directory. We compare only what their abstract states. Three further studies examine what the ledger costs. Huang et al. {{huang24}} decide locally and validate on the ledger in parallel, which lowers the median access time by about 43% against full on-chain validation; their baseline is another blockchain variant. Bicer et al. {{bicer23}} compare a blockchain zero-trust pipeline with a SQL-backed variant and report about 5% extra execution time. Chiu {{chiu26}} ties revocable attribute keys to ledger epochs, so that revocation updates only small key ciphertexts. Mukta et al. {{mukta}} combine DIDs with capability-based delegation on Hyperledger Fabric. Verifying a presented capability reads the DID and capability registries on the ledger. They report a round-trip time of 5.4 to 7.1 s for issuing a delegated capability with 4 to 128 attributes, measured on one machine with up to 100 users and without a direct baseline system. Other variants target FinTech {{singh}}, clinical trials {{peepliwal}} and FPGA supply chains {{kulkarni}}.'));
push(H2('2.4 Alternatives That Need No Blockchain'));
push(P('A ledger does less here than it first seems, because much of its work can be done without one, so an evaluation should ask how much. On the web, revocation is handled by CRLs {{rfc5280}} and OCSP {{rfc6960}}, and a server can staple a signed status answer to the TLS handshake {{rfc6066}}; a central authority that pushes signed revocations to edge enforcement points is therefore an obvious rival to ledger-driven invalidation. Transparency logs such as Certificate Transparency {{rfc6962}} give audit that third parties can check through log operators and monitors, with no consensus protocol; a systematisation of such logs cautions that append-only consistency does not show that the logged data are true {{hicks23}}, and we word our audit claims as tamper-evidence only. Tamper-evident logging does not need a blockchain: a recent preprint on IoT edge logs commits batches to Merkle trees and reports that corrupted entries were always detected, with proofs of about 1 KB and about 22 ms per entry to verify {{yagiz26}}. Anchoring Merkle roots on a ledger uses the same idea with a different publication medium. Decentralised identifiers {{did}} separate control of an identifier from any registry operator. Blockchain-based access control for IoT puts the policy decision or the policy store on the ledger, from FairAccess {{ouaddah}} to scalable access-management architectures {{novo}}. Among permissioned ledgers, Hyperledger Fabric uses execute-order-validate {{fabric}}, whereas Istanbul BFT {{moniz}}, which we use, brings classical Byzantine agreement {{pbft}} to an EVM chain. Finally, an Internet-wide study found many OPC UA deployments with missing or weak authentication {{dahlmanns}}, which is why we insist on per-device cryptographic identity (R1). We therefore compare against central directories, real Keycloak and OpenLDAP services and a central directory with pushed revocation.'));
push(H2('2.5 Comparison and Gap'));
push(P('Table @related compares representative works on four criteria, taken from what each paper reports.', { keepNext: true }));
{
  const Y = 'Yes', H = 'Part', N = 'No';
  const rows = [
    ['{{salim}}', Y, Y, H, Y],
    ['{{aleisa}}', Y, Y, N, N],
    ['{{nie}}', Y, Y, N, H],
    ['{{sharma}}', Y, Y, H, N],
    ['{{ali}}', Y, H, Y, H],
    ['{{li_hyper}}', Y, N, Y, N],
    ['{{ma}}', N, Y, N, N],
    ['{{wan25}}', N, Y, Y, N],
    ['{{zanasi}}', N, Y, Y, N],
    ['{{ding25}}', Y, N, Y, N],
    ['{{xu25}}', Y, N, Y, N],
    ['**This work**', Y, Y, Y, H],
  ];
  push(table('TABLE @related. COMPARISON OF RELATED WORK', [1200, 915, 915, 915, 915],
    ['Work', 'Blockchain', 'Zero trust', 'IIoT focus', 'Scale eval.'], rows,
    { note: 'Yes = addressed; Part = partly; No = not addressed (authors’ reading). “Scale eval.” = scaling of nodes, devices or users reported; for this work partial (200 devices end to end, one million in a proof microbenchmark). Ratings of the newest works rest on abstracts and summaries, so “No” there may mean “not stated”.' }));
}
push(P('Most blockchain-based zero-trust designs target generic IoT rather than IIoT. Only one of the listed works reports scaling, and it does so in node count rather than device count {{salim}}. In our (non-systematic) survey, no work does all three of these together: keep the ledger off the request path, measure how stale the cached state gets and bound it, and cut audit cost with Merkle anchoring for an IIoT workload. This paper evaluates exactly that combination. Among the works we surveyed, none compares a ledger-based design with a production IAM service or with a central directory that pushes revocations, but our search of the journal databases was not exhaustive. Our synchronous baseline (B3) stands for designs that put consensus on the request path, and numbers from other papers are quoted as reported.'));

// ---- 3 ARCHITECTURE
push(H1('3. Proposed Architecture'));
push(H2('3.1 Design Objectives'));
push(P('**D1** decisions from local state in milliseconds; **D2** no single party that can change identity records, policy or logs without detection (a plant authority still enrols devices, Section 4.2); **D3** bounded staleness of cached state; **D4** write load that grows slower than the request rate; **D5** a device-side workload of one ECDSA signature per request and one stored Merkle path (device-side cost was not measured, [[DISC]]).'));
if (CSI) push(P('**Relation to standards and interfaces.** The tiers follow the logical components of NIST SP 800-207 {{nist}}: the policy decision and enforcement points sit at the edge, and the ledger acts as the store for identity, policy and trust data. Device identifiers are DID-style identifiers {{did}}, and the interfaces between tiers are narrow: devices send a signed request to the enforcement point over HTTP, and the enforcement point reads the ledger through the JSON-RPC calls and event subscriptions of an Ethereum-compatible node. We did not map the design to an industrial standard such as IEC 62443 or OPC UA, and we ran no conformance tests.'));
push(H2('3.2 Architecture Overview'));
push(P('Fig. 1 shows the three tiers. Layer I holds the IIoT and edge devices. Layer II is the zero-trust layer at the edge gateway, which hosts the PEP, PDP and trust engine. Layer III is the permissioned blockchain, where identity, trust, access control and audit run as smart contracts. Gateways keep a cache of Layer III state, so Layer II never has to wait for consensus.', {}));
push(fig('fig1_architecture.png', 'Fig. 1. Proposed BC-ZTA architecture: devices, edge/ZT layer, blockchain layer and contract services.', 262));
push(H2('3.3 Edge and Zero-Trust Layers'));
push(P('Sensors, actuators and PLCs hold an ECDSA key pair bound to a DID and sign every request with a timestamp and a nonce. Edge gateways terminate sessions, keep a local cache of identity, trust and policy state, and forward anomaly telemetry to the trust engine. On each gateway the PEP intercepts every request. The PDP verifies the signature, checks the DID against a cached, Merkle-verified registry entry, fetches the trust score and policy, and returns allow or deny. Micro-segmentation permits only flows that hold a valid, unexpired session {{zanasi}}, and the trust engine turns behavioural features (rate, protocol conformance, firmware attestation) into score proposals.'));
push(H2('3.4 Blockchain Layer'));
push(P('A permissioned Hyperledger Besu network with IBFT 2.0 consensus is operated by plant, integrator and vendor validators; with *n* validators it tolerates *f* = ⌊(*n*−1)/3⌋ Byzantine nodes. Gateways are read-only clients that subscribe to events. Only authorised registrars, validators and the policy administrator send transactions.'));
push(H2('3.5 Identity, Trust and Access Control'));
push(P('Each device is a DID with a public-key hash and a device class. A plant-authorised registrar submits registrations, which can be grouped into *epochs*: the registrar commits the Merkle root of a batch, and a device later proves membership with a logarithmic-size path. Key rotation and revocation are single transactions that emit events. Trust scores lie in [0,100] and start at 70. A score changes only when a quorum of validators proposes the same value, updates are rate-limited, and an anomaly flag subtracts 20 points at once (floored at 0) until the device is re-evaluated. Policies are attribute-based: for each resource the administrator sets the allowed device-class range, a minimum trust score and a session TTL. A request is granted if the DID is active, the class is in range and the score meets the threshold, and the grant yields a session identifier that expires after the TTL or on explicit revocation.'));
push(H2('3.6 Smart Contracts'));
push(P('*IdentityRegistry* handles registration, key update, revocation, epoch commitment and membership checks. *TrustReputation* handles quorum voting and the anomaly flag. *AccessControl* holds policies, evaluates requests and grants or revokes sessions. *AuditLog* stores per-event logs and Merkle batch anchors and verifies inclusion. Source code and tests are in the public repository.'));
push(H2('3.7 Continuous Verification'));
push(P('Fig. 2 gives the workflow. Verification does not stop at login. Each request is checked again against the current cached trust, sessions are short, and the gateway refreshes cached entries every *TTL* seconds, or at once when a *DIDRevoked* or *ScoreUpdated* event arrives. Audit records are hashed into a batch, and the Merkle root of that batch is anchored on-chain asynchronously (step 7), so logging never slows the response.', { keepNext: true }));
push(fig('fig2_workflow.png', 'Fig. 2. Per-request verification workflow with cached state reads and asynchronous audit anchoring (step 7).', 262));
push(P('A request is *r* = (DID, resource, operation, *t*, *n*, σ): a timestamp, a nonce and the device’s ECDSA signature over the other fields. The PEP accepts it only if (i) |now − *t*| ≤ Δ and *n* is new within Δ, which bounds replay; (ii) the DID is active in the cached registry, shown by a Merkle path against the latest committed epoch root or by a direct chain read on a miss; (iii) σ verifies under the key whose hash is registered; and (iv) the PDP finds the trust score and policy satisfied. Otherwise the request is denied and an anomaly event is queued. The gateway also follows a fail-closed rule. If it cannot read the ledger, it keeps using a cached entry past its TTL for at most *k*·*TTL* after the entry was last read (*k* = 2 by default, parameter STALE_FACTOR; we chose it so that one missed refresh does not lock a device out, while stale service stays below two cache lifetimes) and then denies with reason “unavailable” until the ledger is back; *k* = 1 is the strict setting. A circuit breaker spares every request the read timeout while the source is down. The first cloud experiments (Sections 6.1–6.9) used an earlier prototype that denied as soon as a failed read followed TTL expiry (*k* = 1), and [[S12K]].'));
push(H2('3.8 Ledger Access, Revocation and Read Quorum'));
push(P('A Merkle membership proof against an epoch root shows only that a DID was enrolled in that epoch. It stays valid after revocation, so it says nothing about freshness. Revocation is therefore enforced through the registry record (a revoked flag), which the gateway reads on a cache miss and which the *DIDRevoked* event invalidates. A gateway also trusts the Besu node it reads from, and a compromised node could return stale or forged state. A gateway without a validator of its own can instead read from *f* + 1 nodes pinned to the same block height and accept a state only if all answers agree: any *f* + 1 matching answers include an honest node, and IBFT 2.0 has instant finality, so there are no forks to reconcile. The prototype implements this option (QUORUM = 2 for *n* = 4); the default reads from one node, and [[S12Q]].'));

{
  const rv = MA.revocation, d2 = x => x.toFixed(2), pc = x => Math.round(100 * Math.abs(x));
  push(H2('3.9 Analytical Model of Revocation Delay and Stale Service'));
  push(P(`The design has three tunable quantities: the block period *B*, the cache lifetime *τ* and the stale factor *k*. Let *ε* be the time for a finalised state change to reach a gateway and be read. A transaction waits for the next block, so its inclusion wait is uniform on (0, *B*), and IBFT 2.0 finality is instant. With event-driven invalidation the revocation delay *D* lies in [*ε*, *B* + *ε*] and E[*D*] = *B*/2 + *ε*. With polling alone it lies in [*ε*, *B* + *τ* + *ε*] and E[*D*] = *B*/2 + *τ*/2 + *ε*, for a uniformly distributed poll phase. A central directory that pushes revocations has no block wait. The ledger therefore adds a premium of *B*/2 in expectation and at most *B*, independent of the number of devices; this is the price of a state that no single operator controls, and a shorter block period would lower it (we did not test this).`));
  push(P(`For stale service, suppose the ledger is unreachable from time *c*. A gateway serves an entry last read at *ℓ* ≤ *c* only until *ℓ* + *k*·*τ*, so no request is granted after *c* + *k*·*τ*, whatever the request rate. Refresh is lazy, so *ℓ* can be older than *τ* and denials may start earlier. Two further quantities are exact. A Merkle proof over *n* leaves takes 32·⌈log2 *n*⌉ bytes. An anchor transaction costs ${MA.gas.anchor_tx_gas.toLocaleString('en-US')} gas whatever the batch size *b*, against ${MA.gas.log_event_gas_per_record.toLocaleString('en-US')} gas for one event per record, so anchoring is cheaper from *b* = 1 (break-even *b* = ${d2(MA.gas.break_even_batch)}).`));
  push(table(`TABLE @model. MODEL PREDICTIONS AGAINST MEASUREMENTS (2 S BLOCK PERIOD, 10 S TTL, K = 2)`, [2300, 900, 900, 800],
    ['Quantity', 'Model', 'Measured', 'Error'], [
      ['Revocation, events, mean (s)', d2(rv.events_mean_s.predicted), d2(rv.events_mean_s.measured), 'fitted'],
      ['Revocation, events, max (s)', d2(rv.events_max_s.predicted), d2(rv.events_max_s.measured), `${pc(rv.events_max_s.rel_err)}%`],
      ['Revocation, TTL only, mean (s)', d2(rv.ttl_mean_s.predicted), d2(rv.ttl_mean_s.measured), `${pc(rv.ttl_mean_s.rel_err)}%`],
      ['Revocation, TTL only, max (s)', d2(rv.ttl_max_s.predicted), d2(rv.ttl_max_s.measured), `${pc(rv.ttl_max_s.rel_err)}%`],
      ['Last grant after cut (s)', `≤ ${MA.failclosed.bound_k_tau_s}`, `none after ${MA.failclosed.bound_k_tau_s}`, 'holds'],
      ['Merkle proof bytes, 9 sizes', 'formula', 'identical', '0'],
    ], { left: true, note: `ε = ${d2(MA.inputs.eps_s_calibrated)} s is fitted to the first row only, so the other revocation rows are predictions. Revocation figures are from the five-run test of Section 6.6 (40 samples per setting), fail-closed from three runs, proof sizes from local tests.` }));
  if (!(MA.proof_exact_match && MA.failclosed.measured_last_grant_within_bound)) throw new Error('REVIEW TEXT: model checks');
  push(P(`One fitted parameter predicts the three other revocation figures within ${Math.max(pc(rv.ttl_max_s.rel_err), pc(rv.ttl_mean_s.rel_err), pc(rv.events_max_s.rel_err))}%, no gateway granted a request after *c* + *k*·*τ* in three runs, and all nine measured proof sizes equal the formula. The model is deliberately simple: it assumes a uniform poll phase and one fitted delay, and the proof sizes follow from the tree construction rather than test it. It states the ledger premium in closed form, which makes it falsifiable. A deployment can read from it the *B*, *τ* and *k* that meet a revocation or stale-service target.`));
}

// ---- 4 USE CASE AND THREAT MODEL
push(H1('4. Use Case and Threat Model'));
push(H2('4.1 Use Case'));
push(P('Take a smart factory with several production cells. Each cell has PLCs and sensors behind one edge gateway. A remote vendor engineer needs time-limited maintenance access to one class of PLC, and a SCADA historian reads sensor data. The cells, the vendor and the integrator are separate administrative domains, and together they run the validators.'));
push(H2('4.2 Assets and Trust Assumptions'));
push(P('The assets are device identities, policy and trust state, session tokens and audit records. We assume that most validators are honest (at most *f* are Byzantine), that devices store their keys securely, and that gateways are trusted to enforce policy although any single one may be compromised.'));
push(H2('4.3 Adversary Model'));
push(P('The adversary is a Dolev–Yao network attacker who can eavesdrop on, replay and inject messages. It may take over some devices (keys included) and one gateway. It may also include an insider with administrative credentials in one domain, though not enough to control a validator quorum.'));
push(H2('4.4 Threats and Countermeasures'));
push(P('Table @threat maps threats to mechanisms. It shows what the design intends; entries marked in the table are not evaluated end to end, and Section 6.6 states what the cloud tests cover.', { keepNext: true }));
push(table('TABLE @threat. THREATS AND COUNTERMEASURES', [1150, 1500, 2210],
  ['Threat', 'Attack', 'Countermeasure'], [
    ['Spoofing', 'Forged device identity', 'DID + ECDSA signature; Merkle-verified registry entry'],
    ['Replay', 'Re-sent request', 'Timestamp + nonce window at PEP; session TTL'],
    ['Lateral movement', 'Compromised device probes peers', 'Per-resource ABAC, short sessions (micro-segmentation: design only, not implemented)'],
    ['Insider / tamper', 'Admin edits policy or logs', 'On-chain policy and Merkle-anchored audit; M-of-N admin possible (unit tests, Section ' + S_OPT + ')'],
    ['Trust poisoning', 'False score votes', 'Quorum votes, rate limit; non-validators rejected (contract unit tests only)'],
    ['Stale state', 'Use of revoked identity', 'Event-driven cache invalidation, bounded TTL'],
    ['Ledger DoS', 'Flooding the chain', 'Off-path reads; batched writes; non-validators cannot write trust'],
  ], { left: true }));
push(H2('4.5 Security Goals'));
push(P('Authenticity of devices, least-privilege authorisation, revocation within a bounded delay, tamper-evident audit of anchored batches (attribution of a record to a signed request needs the v2 record format, which was tested locally only), and availability of access decisions during ledger congestion.'));
push(H2('4.6 Security Analysis'));
push(P('We argue each goal under the assumptions of Sections 4.2–4.3 and four more: ECDSA over secp256k1 is unforgeable under chosen-message attack, Keccak-256 is collision- and second-preimage-resistant, gateway and device clocks differ by less than Δ/2, and the enrolment authority registers only genuine devices. These are proof sketches, not machine-checked proofs; Section 4.7 adds a bounded model check of S1 and S2; an unbounded ProVerif {{blanchet}} proof remains future work.'));
push(P('**S1 Authenticity.** A request passes only if the signature recovers an address whose hash equals the key hash registered for the claimed DID. A forger without the device key must break signature unforgeability, and registering a new key needs the authority (*updateKey*, *registerDID*). **S2 Replay.** A replayed request fails if it is older than Δ or its nonce was already seen by *the same gateway* within Δ. The signed message carries no gateway identifier, so the same request can be replayed once at a different gateway within Δ unless nonce caches are shared or the gateway identity is added to the signed fields; the released code has the optional binding, which Section 4.7 checks. **S3 Revocation.** Once the revocation transaction is final (IBFT 2.0 finality is instant), a gateway that sees the event stops accepting the device within the polling interval, and a gateway that misses it enforces the revocation when its cache entry expires, i.e. within *TTL*. If consensus halts, the transaction cannot be finalised, so the bound runs from finalisation and not from submission [[S12R]]. **S4 Audit integrity.** Every batch root is anchored on-chain, so a stored record that is altered later no longer verifies, and changing an anchored root needs *f* + 1 validators. Completeness is not guaranteed: a compromised gateway can drop records before they are anchored (and up to the 1 s anchoring interval is exposed on a crash), and the measured prototype’s *AuditLog* accepted anchors from any account (the released code restricts this to authorised gateways). **S5 Availability.** Decisions never wait for consensus and continue from cache for at most *k*·*TTL* when the ledger is unreachable (Section 3.7). A gateway whose node is compromised can deny service or serve stale state unless the read quorum of Section 3.8 is used. **Gateway compromise.** A compromised gateway can approve any request and anchor batches that look valid: the ledger records what the gateway reports, not what happened, and the read quorum limits the state a gateway can be fed, not what it decides. A gateway that anchors two conflicting roots for the same batch leaves both on the ledger, so the conflict is visible [[S_OPT_REF]]. **Staleness window.** If an attacker delays or blocks ledger events to a gateway, a revoked device keeps working until its cache entry expires, at most *TTL*. If the attacker also controls the node the gateway reads from, that node can keep serving an old state with a proof that still verifies, and the bound no longer holds unless the *f* + 1 read quorum is used; a stale answer then needs *f* + 1 colluding nodes. Blocking the event feed leaves a gateway with TTL-only invalidation, which we did measure in E2: with a 10 s TTL a revocation took ' + f1(E.E2['bczta-ttl'].mean_ms / 1000) + ' s on average to take effect (Section 6.6). The bound for a compromised ledger node comes from argument only, and we did not run an eclipse or delay attack. **Administrator key.** In the measured prototype one policy-admin key could change policy and revoke sessions. The released code lets the admin role be handed to an M-of-N multisig contract (tested in unit tests, not measured), which removes the single key but raises the question of who the owners are. **Out of scope:** compromise of the enrolment authority, of *f* + 1 validators or of a device key before revocation, and traffic analysis.'));

{
  const V = MC.variants, v0 = V.nonce_local__gateway_bind_off, v1 = V.nonce_local__gateway_bind_on, v2 = V.nonce_shared__gateway_bind_off, v3 = V.nonce_shared__gateway_bind_on;
  const M = x => (x / 1e6).toFixed(2) + ' million', CA = MC.cache_automaton;
  if (!(!v0.P1_replay_safe && v1.P1_replay_safe && v2.P1_replay_safe && v3.P1_replay_safe && [v0, v1, v2, v3].every(v => v.P2_forgery_safe))) throw new Error('REVIEW TEXT: model check results');
  push(H2('4.7 Bounded Model Check of the Request Protocol'));
  push(P(`To test the replay and forgery arguments (S1, S2) beyond a sketch, we modelled the request protocol as a state machine and searched every reachable state (*system/model_check_request.py*). Signatures are unforgeable tokens. The attacker controls the network: it sees every message, replays any message to any gateway at any later tick, and injects copies with an altered field, which fail verification. The model has two gateways, two device requests, Δ = ${MC.params.delta_ticks} ticks and ${MC.params.horizon_ticks} ticks of time. We check P1, that no signed request is accepted twice anywhere, and P2, that no altered message is accepted, for per-gateway or shared nonce caches, with or without the gateway identifier in the signed fields.`));
  push(P(`With per-gateway nonce caches and no binding, P1 fails in two steps: the request is sent to one gateway and replayed at the other, which is the weakness named in S2. With the gateway identifier signed (${M(v1.states)} states) or a shared nonce cache (${M(v2.states)} states), P1 holds in every reachable state; P2 holds in all four variants (${M(Math.min(v0.states, v1.states, v2.states, v3.states))} to ${M(Math.max(v0.states, v1.states, v2.states, v3.states))} states). The released code has the binding as an option (*GATEWAY_BIND*, Section ${DISC}). A second exhaustive check of the cache logic confirms a revocation delay of at most *ε* when the event arrives and at most *τ* + *ε* when only polling is left, and no grant after *c* + *k*·*τ* (${CA.failclosed_last_grant_after_cut_s} s for *τ* = ${CA.tau} s, *k* = ${CA.k}). These are bounded checks under perfect cryptography, not an unbounded proof; a ProVerif model would remove the bound on gateways, requests and time.`));
}

// ---- 5 IMPLEMENTATION AND METHODOLOGY
push(H1('5. Implementation and Experimental Methodology'));
push(H2('5.1 Besu Blockchain Network'));
push(P(`We deployed a four-validator Hyperledger Besu v26.9.0 IBFT 2.0 network (*f* = 1, block period 2 s, chain ID 2026, zero base fee, London EVM) in Docker on a GitHub-hosted 2-vCPU Linux runner for the contract-level micro-benchmark. All validators share that host, so network delay is negligible and CPU is contended. The end-to-end experiments ran separately on seven Google Cloud VMs (Section 5.6). A fresh network was started for each of ${MS.runs} micro-benchmark repetitions, with contracts compiled by Solidity 0.8.20 (optimizer 200 runs, EVM “london”). Five scenarios used pre-signed transactions from ${MS.workers} worker wallets: S1 sequential write confirmation, S2 read latency (500 *eth_call* evaluations of *AccessControl.evaluateRequest*), S3 per-event logging at 10–200 tx/s offered for ${MS.duration_s} s, S4 batch anchoring at 1 tx/s, and S5 revocation visibility. Blocks were polled every 25 ms. Scripts, contracts and raw results are in the public repository listed under Data Availability.`));
push(H2('5.2 Smart Contracts'));
push(P('The four core contracts total about 370 lines, and a fifth, optional contract lets a multisig take over the admin role. A Hardhat/Chai suite of 18 tests passes and covers registration, duplicate and unauthorised registration, revocation, key update, quorum scoring, score floor, rate limiting, non-validator rejection, access grant/deny, session expiry, epoch Merkle membership and audit batch inclusion proofs.'));
push(H2('5.3 End-to-End Prototype and Load Generator'));
push(P(`Besides the contract tests, we built the whole request path as running software (Node.js 20): a PEP/PDP service, a load generator and the baselines of Section 5.4. Every device owns a secp256k1 key and signs *DID | resource | timestamp | nonce*; its key hash and class are registered on-chain and its DID belongs to one Merkle epoch commitment. The PEP rejects timestamps older than 5 s and repeated nonces, recovers the signer, compares it with the registered key hash, checks the Merkle proof against the cached epoch root and evaluates the ABAC policy (device class 0–1, trust score ≥ 50). In BC-ZTA, identity, trust and policy state are read from Besu with *eth_call* on a cache miss and cached for ${PR.cache_ttl_s} s. A block-polling subscription (20 ms) invalidates an entry when a *DIDRevoked*, *KeyUpdated* or *ScoreUpdated* event is mined, every decision is hashed, and once per second the Merkle root of the pending batch is anchored with *AuditLog.anchorBatch*. The load generator emulates N = ${E.counts.join(', ')} devices that send one request per second with staggered phases, after ${E.warmup_s} s of warm-up and over a ${E.duration_s} s measurement window; requests are signed beforehand so the generator is not the bottleneck. Each request is sent at a fixed, pre-computed time whatever happened to earlier requests (open loop), so a slow decision does not delay later ones, and latency is measured from the moment of sending; scheduling lag of the generator was not recorded separately. PEP, directory server, load generator and the four validators run on separate machines (Section 5.6).`));
push(H2('5.4 Baselines'));
push(P(`(B1) *Centralised PKI-IAM*: one lookup per request at a directory server on its own VM, whose responses are delayed by ${E.netem_wan_ms} ms with Linux *tc netem* to model a remote central service (about 50 ms per lookup in total, Section 6.1). (B2) *ABAC without blockchain*: a local attribute store at the PEP. (B3) *Blockchain-only (sync)*: for every request the PEP reads state with *eth_call*, sends an *AuditLog.logEvent* transaction (eight sender accounts) and replies only when the block containing it is observed. (B4) *Keycloak*: a real Keycloak 26.4.0 issues each device an OpenID Connect access token whose claims carry its class, trust score and key hash, and the PEP calls the token-introspection endpoint {{rfc7662}} on every request; revocation disables the user. (B5) *OpenLDAP*: a real slapd directory holding the same attributes, queried once per request {{rfc4511}}. B4 and B5 also run with a PEP-side decision cache (“cached”, TTL 10 s), which is the usual way to cut their latency. (P) *BC-ZTA* as in Section 5.3. All systems use the same request format, signature check and policy, so differences come from where state is read and written.`));
push(H2('5.5 Performance Metrics'));
push(P('(E1) End-to-end latency (mean, P95) from request send to decision, goodput (accepted requests per second), failures, and on-chain writes per second versus device count. (E2) Revocation enforcement delay: time from the revocation action until the PEP first denies the device. (E3) Security tests with 50 attempts each per run. (E4) Decision latency while the ledger is flooded with transactions. (E5) Decision latency, goodput and revocation enforcement while one of the four validators is stopped. Also gas per operation and, from the micro-benchmark, confirmation latency and ledger throughput.'));

push(H2('5.6 Distributed Deployment'));
push(P(`The end-to-end experiments E1–E5 ran on Google Cloud (us-central1-a) on seven VMs in one VPC without external addresses: four Besu validators (e2-medium, 2 vCPU, 4 GB, one validator each), a PEP/PDP host (e2-standard-2), the directory server for B1 (e2-small) and a controller (e2-standard-2) that runs the load generator and the experiment scripts and submits the on-chain transactions. Linux *tc netem* delays all outgoing traffic of each validator VM by ${E.netem_validator_ms} ms, to stand for a plant-local validator network, and the responses of the directory server by ${E.netem_wan_ms} ms, to stand for a remote central service; all other delay is the real VM-to-VM delay. Each of the ${E.runs} repetitions started a freshly generated chain and restarted the PEP for every device count, and the repetitions ran one after another on the same VMs. The validator-failure test (E5) stops one validator container for 30 s while 50 devices are served. A single cloud zone is closer to independent hosts than a shared CI runner, but it is not an industrial network. Deployment scripts, configuration and raw results are in the public repository.`));
push(P('A second cloud run on the same VMs added Keycloak 26.4.0 (Docker, development mode, embedded H2 database) and OpenLDAP slapd (Debian 12 package) on the directory VM (B4, B5), their cached variants, a revocation test, a 25 s outage test, an open-loop PEP capacity test and the flood sweep of Section 6.9. Besu ran with a 2.5 GB heap for the flood sweep and all later runs; the first IAM repetition used the default 1 GB heap, which does not affect the PEP-side numbers.'));
push(P('All cloud runs used the first contract version, in which *AuditLog* and *grantSession* had no caller restriction (the hardening is described in Section ' + DISC + '), the unbound request signature and the per-event audit leaf; all used one resource with device-class and trust-score thresholds. Confidence intervals use the two-sided Student t value for n − 1 degrees of freedom (4.30 for n = 3, 2.78 for n = 5) on the run means, which assumes roughly normal run-to-run variation and is wide for n = 3. The first cloud run (E1–E5) used e2-standard-2 PEP hosts and an unrecorded Besu heap. The IAM tests used 3 repetitions, the flood sweep 2, and the later runs of Sections 6.10–6.12 a 4-vCPU PEP host or no cloud VM at all; the run counts are given in each section.'));
push(H1('6. Results and Discussion'));
push(H2('6.1 Authentication'));
push(P(`Table @lat and Fig. 3 show end-to-end latency (mean of ${E.runs} runs). At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms on average (P95 ${f1(e('bczta', 50).p95_ms)} ms), versus ${f1(e('central', 50).mean_ms)} ms for the centralised PKI-IAM, ${f1(e('abac', 50).mean_ms)} ms for the ledger-free ABAC store and ${f0(e('bcsync', 50).mean_ms)} ms for the synchronous blockchain. BC-ZTA is therefore ${pct(e('bczta', 50).mean_ms, e('central', 50).mean_ms)}% faster than the centralised baseline. This gap is almost entirely the injected 40 ms delay, i.e. the one wide-area round trip that BC-ZTA removes from the request path; it would shrink or grow with that delay, which we did not sweep, so the percentage is not a general speed-up. BC-ZTA also costs about ${f1(e('bczta', 50).mean_ms - e('abac', 50).mean_ms)} ms more than a local store (Merkle verification, hashing and audit bookkeeping), and is about ${f0(e('bcsync', 50).mean_ms / e('bczta', 50).mean_ms)}× faster than checking every request on-chain. Even at 10 devices, where the ledger is not saturated, the synchronous design needs ${f0(e('bcsync', 10).mean_ms)} ms because each request waits for a block.`, { keepNext: true }));
const pm = (sy, n) => f1(e(sy, n).mean_ms) + ' ± ' + f1(ci(e(sy, n).mean_ms_sd, E.runs));
push(table(`TABLE @lat. END-TO-END LATENCY (MS, MEAN ± 95% CI OF ${E.runs} RUNS; P95)`, [1100, 1210, 650, 1250, 650],
  ['System', 'Mean 50', 'P95 50', 'Mean 200', 'P95 200'], [
    ['PKI-IAM', pm('central', 50), f1(e('central', 50).p95_ms), pm('central', 200), f1(e('central', 200).p95_ms)],
    ['ABAC', pm('abac', 50), f1(e('abac', 50).p95_ms), pm('abac', 200), f1(e('abac', 200).p95_ms)],
    ['BC-only', f0(e('bcsync', 50).mean_ms) + ' ± ' + f0(ci(e('bcsync', 50).mean_ms_sd, E.runs)), f0(e('bcsync', 50).p95_ms), f0(e('bcsync', 200).mean_ms) + ' ± ' + f0(ci(e('bcsync', 200).mean_ms_sd, E.runs)), f0(e('bcsync', 200).p95_ms)],
    ['BC-ZTA', '**' + pm('bczta', 50) + '**', '**' + f1(e('bczta', 50).p95_ms) + '**', '**' + pm('bczta', 200) + '**', '**' + f1(e('bczta', 200).p95_ms) + '**'],
  ], { left: true, note: 'Columns give the number of devices; PKI-IAM responses are delayed by 40 ms (netem). With 5 runs the differences discussed in the text exceed the confidence intervals by an order of magnitude; no hypothesis tests were run.' }));
push(fig('fig3_latency.png', `Fig. 3. Mean end-to-end latency versus number of devices (log scale; error bars: standard deviation of ${E.runs} runs; Table @lat gives 95% confidence intervals).`, 262));
push(H2('6.2 Authorisation'));
push(P(`The proposed design makes policy decisions from the edge cache. The measured cache-hit ratio was ${f0(100 * e('bczta', 50).cache_hit_ratio)}% (one miss per device per ${PR.cache_ttl_s} s TTL), so 50 devices caused only 50 chain reads for about 1,250 requests; each miss costs one batched *eth_call* of ${PR.chain_read_ms} ms in the micro-benchmark. The PEP used ${f2(e('bczta', 50).cpu_cores)} CPU cores at 50 devices and ${f2(e('bczta', 200).cpu_cores)} at 200, against ${f2(e('abac', 200).cpu_cores)} for the local store. Every decision is covered by the audit batch: in the 200-device runs about 5,000 decisions per run were anchored in roughly 25 transactions. On-chain evaluation costs ${gas('AccessControl.evaluateRequest')} gas as an estimate, but because it is a read, no fee or block wait is incurred.`));
push(H2('6.3 Blockchain Throughput'));
push(P(`The Besu micro-benchmark gave the following. Write confirmation takes ${f0(s3(10).mean_ms)} ms on average at 10 tx/s (P95 ${f0(s3(10).p95_ms)} ms), close to the 2 s block period; a transaction submitted just after a block, as in the phase-locked sequential tests S1/S5, waits about ${f0(MS.S1_write_confirmation_phase_locked['AuditLog.logEvent'].mean_ms)} ms. Reads cost ${f1(MS.S2_read_latency.mean_ms)} ms (P95 ${f1(MS.S2_read_latency.p95_ms)} ms). Committed throughput tracks the offered load up to 50 tx/s (${f1(s3(50).committed_tps)} tx/s) but saturates near ${PR.chain_capacity_tps} tx/s on this host: at 100 and 200 tx/s offered only ${f1(s3(100).committed_tps)} and ${f1(s3(200).committed_tps)} tx/s commit and ${f0(100 * (1 - s3(200).confirmed_fraction))}% of transactions at 200 tx/s were not confirmed within 60 s. Batch anchoring at 1 tx/s confirmed all ${MS.S4_batch_anchoring.confirmed.reduce((a, b) => a + b, 0)} anchors in ${f0(MS.S4_batch_anchoring.mean_ms)} ms on average. Because all validators share one 2-vCPU host, ${PR.chain_capacity_tps} tx/s is a lower bound: on the seven-VM deployment the synchronous baseline committed up to ${f0(e('bcsync', 200).onchain_tx_per_s)} tx/s (Section 6.5), almost twice as much.`, { keepNext: true }));
push(H2('6.4 Resource Utilisation'));
push(P(`Measured gas per operation is listed in Table @gas. Registering a device costs ${gas('IdentityRegistry.registerDID')} gas, whereas committing an epoch root costs ${gas('IdentityRegistry.commitEpoch')} gas independent of batch size. Logging one event on-chain costs ${gas('AuditLog.logEvent')} gas, while anchoring a batch costs ${gas('AuditLog.anchorBatch')} gas, i.e. about ${f0(RES.gas_per_record.anchorBatch_per_record_at_1000)} gas per record for a 1,000-record batch (≈${f0(gasRatio(1000))}× cheaper); the saving is proportional to the batch size and is ≈${f0(gasRatio(50))}× for the 50 records per batch of the 50-device experiments and ≈${f0(gasRatio(200))}× for 200 devices. At 400 devices and 1 event/s the calculation gives ${(AG.events_per_day / 1e6).toFixed(1)} M events/day: ${AG.per_event_logging_MB_per_day.toFixed(0)} MB/day of ledger growth with per-event logging (192 B/entry) versus ${AG.batch_anchoring_MB_per_day.toFixed(1)} MB/day with batch anchoring. Device-side CPU and memory were not measured. An IOTA-based DID study reports about 175% CPU on a Raspberry Pi against about 22% on a conventional computer while generating a DID {{ramirez}}, which is why we limit devices to one signature and a hash proof.`, { keepNext: true }));
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
push(P(`Fig. 4 shows goodput and on-chain write load against device count. Central PKI-IAM, ABAC and BC-ZTA served every request up to 200 devices with no failures. The synchronous blockchain kept up to 50 devices (goodput ${f0(e('bcsync', 50).goodput_rps)} req/s, ${f1(e('bcsync', 50).mean_ms / 1000)} s mean latency) and at 100 devices (${f0(e('bcsync', 100).goodput_rps)} req/s, ${f1(e('bcsync', 100).mean_ms / 1000)} s), but at 200 devices only ${f0(100 * e('bcsync', 200).success_ratio)}% of the requests were answered in time, goodput fell to ${f0(e('bcsync', 200).goodput_rps)} req/s and ${f0(e('bcsync', 200).failed_or_timeout)} requests (summed over ${E.runs} runs) failed or timed out. Its on-chain write rate (${f0(e('bcsync', 100).onchain_tx_per_s)} tx/s at 100 and ${f0(e('bcsync', 200).onchain_tx_per_s)} tx/s at 200 devices) is the measured ledger ceiling of this deployment, whereas BC-ZTA writes about ${f1(e('bczta', 100).onchain_tx_per_s)} tx/s regardless of the number of devices. The latency of BC-ZTA stays flat from 10 to 200 devices (${f1(e('bczta', 10).mean_ms)} to ${f1(e('bczta', 200).mean_ms)} ms mean, P95 at most ${f1(Math.max(...E.E1.bczta.map(r => r.p95_ms)))} ms), and the PEP used ${f2(e('bczta', 200).cpu_cores)} of its two vCPUs at 200 devices, so neither the ledger nor the PEP was the limit at this load; larger populations were not tested. For comparison, a sharded design reaches 2,500 TPS at 700 nodes {{salim}}; our approach instead lowers the required write rate.`));
push(fig('fig4_scalability.png', 'Fig. 4. (a) Goodput and (b) on-chain writes per second versus number of devices. The dotted line is the offered load and lies under the BC-ZTA line. The legend in (a) applies to (b).', 240));
push(H2('6.6 Negative Security Tests'));
const sec = E.E3, secRow = (k, n) => [n, String(sec[k].attempts), String(sec[k].allowed)];
push(P(`Table @sec lists the security tests run against the BC-ZTA prototype (${E.runs} runs, 50 attempts per test and run). All legitimate requests were accepted (no false rejects), and none of the forged, replayed, stale, unregistered, tampered, class-violating or low-trust requests was accepted. These are negative tests: each checks that one malformed request is refused by one mechanism. They do not model an adversary who compromises a gateway, holds the admin key, eclipses a node, controls several score voters or runs many fake devices. Those cases are covered by the argument in Section 4.6 and, for operator tampering with the audit trail, by the local experiment of Section ${S_OPT}; they were not tested on the cloud deployment. For a revoked device, ${E.E3.revoked_device.accepted_after_tx_confirmed.reduce((a, b) => a + b, 0)} requests were accepted after the revocation transaction was confirmed, and the first denial came ${f0(Math.max(...E.E3.revoked_device.first_denial_after_confirmation_ms))} ms after confirmation or sooner. Fig. 5 shows the revocation enforcement delay of each system: with event-driven invalidation BC-ZTA enforces a revocation after ${f2(E.E2['bczta-events'].mean_ms / 1000)} s on average (worst case ${f2(E.E2['bczta-events'].max_ms / 1000)} s), about one block period and independent of the TTL, whereas TTL-only refresh with a ${E.E2['bczta-ttl'].ttl_s} s TTL needs ${f1(E.E2['bczta-ttl'].mean_ms / 1000)} s on average (worst case ${f1(E.E2['bczta-ttl'].max_ms / 1000)} s). The centralised and local baselines revoke in ${f0(E.E2.central.mean_ms)} ms and ${f0(E.E2.abac.mean_ms)} ms because they hold the state in one place (the ABAC samples are bimodal, about 7 or 57 ms, which we did not trace); the blockchain-only value (${f2(E.E2.bcsync.mean_ms / 1000)} s) includes the request that was in flight when the revocation was issued.`, { keepNext: true }));
push(table(`TABLE @sec. NEGATIVE SECURITY TESTS ON THE BC-ZTA PROTOTYPE (${E.runs} RUNS)`, [2900, 980, 980],
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
push(fig('fig5_revocation.png', 'Fig. 5. Revocation enforcement delay (mean, log scale; marks: worst case observed).', 262));
push(H2('6.7 Availability under Validator Failure'));
const fl = E.E4.bczta_under_flood, fsent = fl.flood.map(x => x.sent);
push(P(`E5 stops one of the four validators for 30 s while 50 devices are served and one device is revoked during the outage. IBFT 2.0 with four validators tolerates *f* = 1 faulty validator and the PEP decides from its cache, so decisions should be unaffected. The test confirms this: all ${E.E5.measured} requests were answered and accepted (mean ${f1(E.E5.mean_ms)} ms, P95 ${f1(E.E5.p95_ms)} ms, none late or failed), the revoked device was denied ${f2(E.E5.revocation_during_fault_ms / 1000)} s after the revocation was submitted, and the PEP kept anchoring audit batches (${E.E5.pep.anchors_confirmed} of ${E.E5.pep.anchors_sent} anchor transactions were confirmed when the statistics were read). Only one failure of one validator for 30 s was tested; network partitions, Byzantine validators and the loss of two validators were not.`, { keepNext: true }));

push(H2('6.8 Comparison with Production IAM Services'));
const xe = (k, n) => X.E1[k][String(n)], x2 = k => X.E2[k], x6 = k => X.E6[k].summary;
const mean = a => a.reduce((u, v) => u + v, 0) / a.length;
push(P(`To replace the simple directory of B1 with real products, we added Keycloak 26.4 as an OpenID Connect token-introspection service {{rfc7662}} (B4) and OpenLDAP slapd as a directory queried once per request {{rfc4511}} (B5), each on the directory VM behind the same 40 ms netem delay, plus a variant of each with a ${10} s decision cache at the PEP (“cached”). All five systems share the PEP, signatures and policy. Table @iam gives the results (3 repetitions). At 25 and 100 devices the uncached products need ${f1(xe('keycloak', 100).mean_ms[0])} ms (Keycloak) and ${f1(xe('ldap', 100).mean_ms[0])} ms (OpenLDAP) per decision because every request crosses the emulated WAN, against ${f1(xe('bczta', 100).mean_ms[0])} ms for BC-ZTA, which is ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× and ${f0(xe('ldap', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster. Most of that gap is the removed WAN round trip: with a PEP-side cache the products reach ${f1(xe('keycloak-cached', 100).mean_ms[0])}–${f1(xe('ldap-cached', 100).mean_ms[0])} ms mean latency, and only their P95 (${f0(xe('keycloak-cached', 100).p95_ms[0])} ms, one miss per device per TTL) stays WAN-bound. The cached products enforce a revocation only once the cache expires (mean ${f1(x2('keycloak-cached').mean_ms / 1000)} s, worst case ${f1(x2('keycloak-cached').max_ms / 1000)} s for the 10 s TTL), whereas BC-ZTA’s event-driven invalidation did so in ${f1(x2('bczta-events').mean_ms / 1000)} s in this run and ${f1(E.E2['bczta-events'].mean_ms / 1000)} s in the five-run test of Section 6.6 (worst case ${f1(x2('bczta-events').max_ms / 1000)} s), at the same low latency. The uncached products revoke faster, in ${f0(x2('keycloak').mean_ms)} ms (Keycloak) and ${f0(x2('ldap').mean_ms)} ms (OpenLDAP), because the central service is consulted on every request. A plant that needs sub-second revocation must use the uncached products or a shorter block period.`, { keepNext: true }));
const lat = (k, n) => f1(xe(k, n).mean_ms[0]) + ' / ' + f0(xe(k, n).p95_ms[0]);
push(table('TABLE @iam. PRODUCTION IAM BASELINES: LATENCY (MEAN / P95, MS) AND REVOCATION DELAY', [1700, 800, 800, 800, 760],
  ['System', '25 dev.', '100 dev.', '200 dev.', 'Revoc. (s)'], [
    ['Keycloak', lat('keycloak', 25), lat('keycloak', 100), lat('keycloak', 200), f2(x2('keycloak').mean_ms / 1000)],
    ['Keycloak, cached', lat('keycloak-cached', 25), lat('keycloak-cached', 100), lat('keycloak-cached', 200), f2(x2('keycloak-cached').mean_ms / 1000)],
    ['OpenLDAP', lat('ldap', 25), lat('ldap', 100), lat('ldap', 200), f2(x2('ldap').mean_ms / 1000)],
    ['OpenLDAP, cached', lat('ldap-cached', 25), lat('ldap-cached', 100), lat('ldap-cached', 200), f2(x2('ldap-cached').mean_ms / 1000)],
    ['BC-ZTA', '**' + lat('bczta', 25) + '**', '**' + lat('bczta', 100) + '**', lat('bczta', 200), '**' + f2(x2('bczta-events').mean_ms / 1000) + '**'],
  ], { left: true, note: 'Mean of 3 repetitions; 40 ms netem delay on the IAM services; revocation: 8 devices per run, mean of 24; cache TTL 10 s.' }));
push(fig('fig6_iam_latency.png', 'Fig. 6. (a) Mean and (b) P95 latency of Keycloak, OpenLDAP, their cached variants and BC-ZTA. The legend in (a) applies to (b).', 262));
push(P(`At 200 devices (one request per second each) the PEP, a single Node.js process on a 2-vCPU VM, nears its own capacity: BC-ZTA (${f0(xe('bczta', 200).mean_ms[0])} ms mean, ${f0(xe('bczta', 200).p95_ms[0])} ms P95) and uncached Keycloak (${f0(xe('keycloak', 200).mean_ms[0])} ms) degrade alike, while the cached products do not. In the Section 6.1 run the same configuration decided in ${f1(e('bczta', 200).mean_ms)} ms, so this point sits at the saturation edge and varies between runs. It is a limit of our single-process PEP, not of the architecture, since PEPs are stateless and can be replicated. An open-loop capacity test (200–1,600 req/s, 3 repetitions) shows goodput saturating at about ${f0(Math.min(...['keycloak','ldap','bczta'].map(m => X.E7[m]['400'].goodput[0])))}–${f0(Math.max(...['keycloak','ldap','bczta'].map(m => X.E7[m]['800'].goodput[0])))} req/s for all three systems, with P95 latency of several seconds beyond it, so per-PEP capacity is set by signature verification and not by the IAM backend.`));
push(P(`Table @outage reports the outage test: the central service is stopped 20 s into a 100 s run with 100 devices and restarted at 45 s. Without Keycloak or OpenLDAP no new decisions are possible: ${f0(100 * mean(x6('keycloak').ok_fraction_during_outage))}% of requests were granted during the outage with both uncached products and ${f0(100 * mean(x6('keycloak-cached').ok_fraction_during_outage))}% with the cached variants, whose entries expired within ${f0(mean(x6('keycloak-cached').seconds_until_service_loss))} s of the stop (most entries had already expired). Service resumed ${f0(mean(x6('ldap').seconds_to_recover_after_start))} s after restarting OpenLDAP and ${f0(mean(x6('keycloak').seconds_to_recover_after_start))} s after restarting Keycloak (JVM start-up). The PEP of BC-ZTA contacts no central service and granted ${f0(100 * mean(x6('bczta').ok_fraction_during_outage))}% throughout (Fig. 7). This test removes a service that BC-ZTA does not use, and a design that caches decisions and receives pushed revocations from the same directory would also survive a short outage, so the fairer comparison is the loss of each design’s own state source [[S12O]]. We did not test clustered Keycloak or OpenLDAP. The test shows the single point of failure that BC-ZTA removes, not that central IAM cannot be made highly available.`, { keepNext: true }));
push(table('TABLE @outage. CENTRAL-SERVICE OUTAGE (25 s, 100 DEVICES, 3 RUNS)', [2060, 1400, 1400],
  ['System', 'Granted during outage (%)', 'Recovery after restart (s)'], [
    ...[['keycloak', 'Keycloak'], ['keycloak-cached', 'Keycloak, cached'], ['ldap', 'OpenLDAP'], ['ldap-cached', 'OpenLDAP, cached']].map(([k, n]) => [n, f0(100 * mean(x6(k).ok_fraction_during_outage)), f0(mean(x6(k).seconds_to_recover_after_start))]),
    ['BC-ZTA', '**' + f0(100 * mean(x6('bczta').ok_fraction_during_outage)) + '**', '**0**'],
  ], { left: true, note: 'Service stopped at 20 s and restarted at 45 s of a 100 s run; BC-ZTA has no central service (Keycloak was stopped on the directory VM, but BC-ZTA does not use it).' }));
push(fig('fig7_iam_outage.png', 'Fig. 7. Fraction of requests granted over time while the central IAM service is stopped (shaded) and restarted.', 230));

push(H2('6.9 Ledger Flood Sweep'));
const FB = X.FLOOD.bczta, FS = X.FLOOD.bcsync;
const pk = Object.keys(FB).map(Number).sort((a, b) => a - b);
const fpeak = m => Math.max(...pk.map(r => X.FLOOD[m][String(r)].committed_tps[0]));
push(P(`To test ledger flooding we swept the offered rate of audit-log transactions from 0 to 1,200 tx/s (16 spam wallets, pre-signed transactions sent in nonce order, 20 s per rate after a 5 s warm-up, 50 devices at 1 request/s, 2 repetitions), once with BC-ZTA and once with the synchronous design, which writes every decision as a transaction on the same ledger (Fig. 8). The committed rate saturates at about ${f0(fpeak('bczta'))} tx/s for BC-ZTA and ${f0(fpeak('bcsync'))} tx/s for the synchronous design (peak at 200–400 tx/s offered) and then declines, to ${f0(FB['1200'].committed_tps[0])} and ${f0(FS['1200'].committed_tps[0])} tx/s at 1,200 offered, because Besu rejects most of the excess (“nonce too distant” and, at the highest rate, “transaction pool not enabled”; ${f0(FB['1200'].rejected)} of ${f0(FB['1200'].attempts)} submissions in the BC-ZTA run). The access latency of BC-ZTA does not follow: its mean stays at ${f1(Math.min(...pk.map(r => FB[String(r)].mean_ms[0])))}–${f1(Math.max(...pk.map(r => FB[String(r)].mean_ms[0])))} ms and its P95 at no more than ${f1(Math.max(...pk.map(r => FB[String(r)].p95_ms[0])))} ms with every request answered, since decisions never wait for the ledger. The mean latency of the synchronous design climbs from ${f1(FS['0'].mean_ms[0] / 1000)} s with an idle ledger to ${f0(FS['1200'].mean_ms[0] / 1000)} s at 1,200 tx/s (P95 ${f0(FS['1200'].p95_ms[0] / 1000)} s), and ${f0(100 * (1 - FS['1200'].ok_ratio[0]))}% of its requests fail at the highest rate. A flood thus denies service to ledger-bound designs but only delays BC-ZTA’s audit anchoring and revocation visibility, which we did not measure under flood.`, { keepNext: true }));
push(fig('fig8_flood.png', 'Fig. 8. (a) Committed ledger rate and (b) access P95 latency versus offered flood rate.', 262));
push(P('The flood generator targets the validator that the PEP also reads from. We raised the Besu heap to 2.5 GB after the default 1 GB ran out of memory in the synchronous run at 400 tx/s. We did not test a flood against all validators, an attacker with more accounts, or a longer flood. The committed rate of 100–215 tx/s is specific to our four validators, 2 s block period and two vCPUs per validator.'));

if (XR) {
  const chk = (c, m) => { if (!c && !process.env.MOCK) throw new Error('REVIEW TEXT: ' + m); };
  const nR = XR.n_runs, P1 = XR.P1, P2 = XR.P2, P3 = XR.P3, P4 = XR.P4, P5 = XR.P5;
  const pl = (m, n) => P1[m][String(n)] || (process.env.MOCK ? P1[m][Object.keys(P1[m]).sort((x, y) => y - x)[0]] : undefined);
  const plc = (m, n) => f1(pl(m, n).mean_ms[0]) + ' ± ' + f1(ci(pl(m, n).mean_ms[1], pl(m, n).reps));
  chk(P2.push.mean_ms < P2['bczta-q2'].mean_ms, 'push revocation should be faster than ledger revocation');
  const dd = n => { const r = dci(pl('bczta', n).mean_ms, pl('push', n).mean_ms, nR); return `${sg(r.d)} ms (95% CI ${sg(r.lo)} to ${sg(r.hi)} ms)`; };
  chk([25, 100, 200].every(n => dci(pl('bczta', n).mean_ms, pl('push', n).mean_ms, nR).hi < 1), 'BC-ZTA latency penalty vs B6 should stay below 1 ms');
  push(H2('6.10 Robustness: Push Revocation, Read Quorum, Fail-Closed Bound, Consensus Halt and Scaling'));
  push(P(`The comparison with Keycloak and OpenLDAP leaves open whether the ledger is needed for what BC-ZTA does well. We therefore added baseline B6, a central directory (40 ms WAN delay) whose answers the PEP caches for 30 s and which pushes each revocation to the PEP over a server-sent-event stream, i.e. event-driven invalidation without a blockchain, and BC-ZTA with a read quorum of *f* + 1 = 2 validators (Section 3.8). The experiments ran ${nR} times, each on a fresh network, with the PEP host enlarged to e2-standard-4 (4 vCPU); Table @push gives the results. B6 decides in ${plc('push', 100)} ms at 100 devices against ${plc('bczta', 100)} ms for BC-ZTA, so the two are close for access latency: the difference (BC-ZTA minus B6) is ${dd(100)} at 100 devices and ${dd(200)} at 200 devices, where BC-ZTA is measurably, though slightly, slower; the upper bound of the interval is ${fu(Math.max(...[25, 100, 200].map(n => dci(pl('bczta', n).mean_ms, pl('push', n).mean_ms, nR).hi)))} ms or less at 25, 100 and 200 devices (Student *t*, ${nR} runs each). We set no equivalence margin beforehand, so this is an interval estimate, not an equivalence test. B6 enforces a revocation after ${f0(P2.push.mean_ms)} ms on average (worst case ${f0(P2.push.max_ms)} ms), which is ${f0(P2['bczta-q2'].mean_ms / P2.push.mean_ms)}× faster than BC-ZTA with quorum (${f1(P2['bczta-q2'].mean_ms / 1000)} s, worst case ${f1(P2['bczta-q2'].max_ms / 1000)} s), because BC-ZTA must wait for a block. The read quorum changes the mean latency at 100 devices from ${plc('bczta', 100)} to ${plc('bczta-q2', 100)} ms, since only cache misses read from two nodes, and ${pl('bczta-q2', 100).quorum_mismatch === 0 ? 'no quorum mismatch occurred' : pl('bczta-q2', 100).quorum_mismatch + ' quorum mismatches occurred'} in the runs. A trusted central operator who pushes revocations thus matches BC-ZTA’s latency and revokes faster. What the ledger adds is that no single operator holds identity, policy and audit records, and that the other consortium members can verify anchored audit. Where one operator is acceptable, B6 is the simpler design.`, { keepNext: true }));
  push(table(`TABLE @push. CENTRAL DIRECTORY WITH PUSH REVOCATION (B6) AND READ QUORUM (${nR} RUNS)`, [1500, 800, 800, 800, 960],
    ['System', '25 dev.', '100 dev.', '200 dev.', 'Revoc. (ms)'], [
      ['B6 push', plc('push', 25), plc('push', 100), plc('push', 200), f0(P2.push.mean_ms)],
      ['BC-ZTA', plc('bczta', 25), plc('bczta', 100), plc('bczta', 200), f0(E.E2['bczta-events'].mean_ms)],
      ['BC-ZTA, quorum 2', plc('bczta-q2', 25), plc('bczta-q2', 100), plc('bczta-q2', 200), f0(P2['bczta-q2'].mean_ms)],
    ], { left: true, note: `Mean latency (ms) ± 95% CI of ${nR} runs; revocation: mean of ${P2.push.n} (B6) and ${P2['bczta-q2'].n} (quorum) samples; the BC-ZTA value is from the five-run test of Section 6.6. TTL 30 s (latency), 10 s (revocation).` }));
  const c3 = P3.bczta, c3p = P3.push, avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const pc = (c, k) => f0(100 * avg(c.summary[k]));
  chk(c3.ttl_s * 2 === c3.stale_bound_s, 'stale bound');
  push(P(`Section 6.8 stopped Keycloak or OpenLDAP, which BC-ZTA does not use. The fair test is the loss of each design’s own state source under the same cache policy (TTL ${c3.ttl_s} s, serve-stale bound 2·TTL = ${c3.stale_bound_s} s, 50 devices): the PEP of BC-ZTA is cut off from its ledger node with a firewall rule (*iptables* DROP) for ${c3.restore_at_s - c3.cut_at_s} s, and the directory of B6 is stopped for the same time (Table @cut, Fig. 9, ${c3.reps} runs). The two behave alike. Requests are granted from cache and then from stale state (${pc(c3, 'granted_cut_0_to_ttl')}% and ${pc(c3p, 'granted_cut_0_to_ttl')}% granted in the first ${c3.ttl_s} s after the loss), the granted fraction falls to ${pc(c3, 'granted_after_2ttl')}% and ${pc(c3p, 'granted_after_2ttl')}% once the last read is older than ${c3.stale_bound_s} s, and service resumes ${f0(avg(c3.summary.seconds_to_recover.map(x => x ?? 0)))} s and ${f0(avg(c3p.summary.seconds_to_recover.map(x => x ?? 0)))} s after the source returns. The first denials come ${f0(avg(c3.summary.seconds_until_denials))} s (BC-ZTA) and ${f0(avg(c3p.summary.seconds_until_denials))} s (B6) after the loss, not after ${c3.stale_bound_s} s, because the bound of each entry runs from its own last successful read, up to one TTL before the loss. The first reads that hit the unreachable ledger also wait for the ${(2.5).toFixed(1)} s read timeout, so BC-ZTA grants slightly less than B6 in the first window. The ledger therefore gives no extra availability in this test, since any cache with a stale bound behaves the same way in a short outage. BC-ZTA state sits on four validators, so the PEP could read from another node (we did not implement failover); the B6 directory is a single service unless replicated.`, { keepNext: true }));
  push(table(`TABLE @cut. LOSS OF THE STATE SOURCE (TTL ${c3.ttl_s} S, STALE BOUND ${c3.stale_bound_s} S, ${c3.reps} RUNS)`, [1800, 560, 560, 660, 600, 780],
    ['System (source lost)', 'Before', '≤ TTL', 'TTL–2TTL', '> 2TTL', 'Restored'], [
      ['BC-ZTA (ledger node)', pc(c3, 'granted_before'), pc(c3, 'granted_cut_0_to_ttl'), pc(c3, 'granted_ttl_to_2ttl'), pc(c3, 'granted_after_2ttl'), pc(c3, 'granted_after_restore')],
      ['B6 (directory)', pc(c3p, 'granted_before'), pc(c3p, 'granted_cut_0_to_ttl'), pc(c3p, 'granted_ttl_to_2ttl'), pc(c3p, 'granted_after_2ttl'), pc(c3p, 'granted_after_restore')],
    ], { left: true, note: 'Requests granted (%) in the windows after the loss of the state source; windows are relative to the time of the loss.' }));
  push(fig('fig9_failclosed.png', 'Fig. 9. Requests granted while the state source is lost (shaded); dotted lines: TTL and 2·TTL after the loss.', 230));
  const h4 = P4 && P4.length ? P4 : null;
  if (h4) {
    const hm = k => avg(h4.map(r => r[k]).filter(x => x != null));
    push(P(`To test the consensus assumption we stopped two of the four validators for ${h4[0].halt_s} s (IBFT 2.0 needs three, so block production halts) while 50 devices were served, and revoked a device ${h4[0].revoke_submitted_at_s - h4[0].halt_at_s} s after the stop. The PEP kept answering: ${f0(100 * avg(h4.map(r => r.decisions_granted.during_halt)))}% of requests were granted during the halt, because the cache and the reachable node serve the last committed state. The revoked device, however, stayed accepted until consensus resumed and the transaction was mined. Enforcement came ${f1(hm('revocation_enforced_after_restart_ms') / 1000)} s after the validators were restarted and ${f1(hm('revocation_enforced_after_submit_ms') / 1000)} s after submission (${h4.length} run${h4.length > 1 ? 's' : ''}). The staleness bound of BC-ZTA therefore runs from finalisation of the revocation and not from its submission, so a consensus halt is a window in which revocations cannot take effect; a central directory is not affected by this particular failure. The delay is far longer than the halt itself (${h4[0].halt_s} s): block production stayed frozen for ${f0(hm('revocation_enforced_after_restart_ms') / 1000)} s after the restart. We did not test the cause. It fits the IBFT 2.0 rule that the timeout of a round doubles after each failed round (base 4 s here), so the validators needed one long round to agree again. Shorter base timeouts or supervised restarts would cut the delay, and an operator who needs bounded revocation during a halt must also keep a short-lived local deny list at the PEP.`));
  }
  const kk = Object.keys(P5).sort((a, b) => a - b);
  const rates = k => Object.keys(P5[k]).map(Number).sort((a, b) => a - b);
  const clean = k => Math.max(...rates(k).filter(r => P5[k][String(r)].fail === 0 && P5[k][String(r)].p95_ms[0] < 50));   // highest offered rate without failures and with P95 < 50 ms
  const hiR = Math.max(...rates(kk[0]).filter(r => kk.every(k => P5[k][String(r)] && P5[k][String(r)].fail >= 0)).filter(r => r <= 800));
  if (kk.length) {
    chk(kk.every(k => isFinite(clean(k))), 'every PEP count needs one clean rate');
    push(P(`Finally, per-PEP capacity is not a limit of the architecture if gateways are replicated. We ran k = ${kk.join(', ')} PEP processes on one ${process.env.PEP_VM_DESC || '4-vCPU'} VM, with devices sharded across them, and raised the offered rate (Fig. 10, Table @scale). The highest offered rate served without any failed request and with a P95 below 50 ms was ${kk.map(k => f0(clean(k)) + ' req/s for k = ' + k).join(', ')}. At ${hiR} req/s offered, ${kk.slice(0, -1).map(k => 'k = ' + k + ' is overloaded (goodput ' + f0(P5[k][String(hiR)].goodput[0]) + ' req/s, P95 ' + f1(P5[k][String(hiR)].p95_ms[0] / 1000) + ' s)').join(' and ')}, whereas k = ${kk[kk.length - 1]} delivers ${f0(P5[kk[kk.length - 1]][String(hiR)].goodput[0])} req/s (${f0(100 * P5[kk[kk.length - 1]][String(hiR)].goodput[0] / hiR)}% of the offered rate) at a P95 of ${f0(P5[kk[kk.length - 1]][String(hiR)].p95_ms[0])} ms while using ${f1(P5[kk[kk.length - 1]][String(hiR)].cpu[0])} cores of the ${process.env.PEP_VM_DESC || '4-vCPU'} VM. Beyond that, goodput falls as the offered rate rises (overload collapse: requests queue behind signature verification and time out), so each gateway must stay below its knee, which an admission limit or load balancer would enforce. Scale-out was measured on one host; across hosts the shared state is the ledger, which is read once per device per TTL.`, { keepNext: true }));
    push(table(`TABLE @scale. PEP SCALE-OUT (BC-ZTA, ${nR} RUNS)`, [800, 1100, 1300, 1000, 1100],
      ['PEPs', 'Clean rate (req/s)', `Goodput at ${hiR} (req/s)`, `P95 at ${hiR} (ms)`, `CPU cores at ${hiR}`], kk.map(k => {
        const v = P5[k][String(hiR)];
        return [String(k), f0(clean(k)), f0(v.goodput[0]), f0(v.p95_ms[0]), v.cpu[0] != null ? f1(v.cpu[0]) : 'n/a'];
      }), { left: true, note: 'Clean rate = highest offered rate with no failed request and P95 < 50 ms; one VM; load generator on a separate VM; mean of the runs.' }));
    push(fig('fig10_scaling.png', 'Fig. 10. (a) Goodput and (b) P95 latency versus offered request rate for 1, 2 and 4 PEP processes.', 262));
  }
}
push(H2(S_AUD + ' Independent Verification of the Audit Trail'));
push(P(`A ledger-anchored audit log is only useful if someone outside the operator can check it. We tested this locally, without the cloud, with the same sorted-pair Merkle construction and keccak hashing as *AuditLog.anchorBatch*. For batches of 50 to 5,000 synthetic audit records, we computed the root and treated it as the value anchored on the ledger. An adversary who controls the stored log then changed one record, deleted one, inserted one, or swapped two adjacent ones (${AV.A[0].modify_record.trials} trials per case and size). The verifier recomputes the root from the log it is given and compares it with the anchored root. Table @audit shows that modification, deletion and insertion were caught in every trial at every batch size. Recomputing the whole batch took ${f1(avA(50).modify_record.full_verify_ms_mean)} ms for 50 records and ${f0(avA(5000).modify_record.full_verify_ms_mean)} ms for 5,000 on one core, and a verifier interested in one record needs a proof of ${avA(50).proof_bytes}–${avA(5000).proof_bytes} bytes and ${f2(avA(50).proof_verify.ms_mean)}–${f2(avA(5000).proof_verify.ms_mean)} ms. A forged record presented with an honest proof was never accepted (0 of ${avA(50).proof_verify.trials}).`));
push(P(`Two limits matter. First, swapping two adjacent records was caught in only ${avA(5000).reorder_records.detected}–${avA(100).reorder_records.detected}% of the trials. Sorted-pair hashing makes the root of two sibling leaves independent of their order, so the root commits to the set of records and not to their order. Order can be checked only if every record carries a sequence number that the verifier inspects; the measured prototype’s records carry a timestamp and a nonce, not a counter (the v2 format below adds one). Second, the anchor covers a record only from the moment its batch is closed and anchored. A record falsified before that, a batch whose root was never anchored, and a log the operator refuses to hand over are outside what the ledger proves: it shows that a root existed at a given block, not that the log is complete. A central database log without an external commitment gives a third party nothing to compare against, so a rewritten row is undetectable by construction (we did not measure this case). This test shows that the tamper-evidence claim holds for the mechanism; it does not compare BC-ZTA with a transparency log or with an operator-published Merkle log of the kind in {{yagiz26}}, which offer similar evidence without consensus. What the ledger adds over these is a publication medium that no single party controls.`));
push(P(`We then tested the remedy for the ordering gap. In record format v2 (*AUDIT_V2*, default off in the PEP) each record also carries a gateway identifier, a per-gateway sequence number, the decision and a hash of the device signature, and the verifier additionally requires the sequence numbers of a presented batch to run 0 to n − 1 in order. In the same local setting (${AV2.rows[0].swap_adjacent.trials} trials per case and size, batches of ${AV2.rows[0].batch} to ${AV2.rows[AV2.rows.length - 1].batch}), modification, deletion, insertion, adjacent swaps and swaps followed by renumbering were detected in ${AV2.rows.reduce((a, r) => a + ['modify', 'delete', 'insert', 'swap_adjacent', 'swap_and_renumber'].reduce((b, m) => b + r[m].detected, 0), 0)} of ${AV2.rows.reduce((a, r) => a + 5 * r.modify.trials, 0)} trials, with no false alarm on the untouched batch. The hash of the device signature makes a record attributable to a signed request, so a gateway cannot later claim it never saw one; it does not prove that the gateway recorded every request it received, and a gateway authorised to anchor can still omit records. These formats were tested locally and were not part of the cloud runs.`));
push(table(`TABLE @audit. DETECTION OF TAMPERING WITH ANCHORED AUDIT BATCHES (${AV.A[0].modify_record.trials} TRIALS PER CELL)`, [550, 600, 600, 600, 600, 700, 550, 600],
  ['Batch', 'Modify', 'Delete', 'Insert', 'Swap', 'Full (ms)', 'Proof (B)', 'Proof (ms)'], AV.A.map(r => [String(r.batch), ...['modify_record', 'delete_record', 'insert_record', 'reorder_records'].map(m => `${r[m].detected}/${r[m].trials}`), f1(r.modify_record.full_verify_ms_mean), String(r.proof_bytes), f2(r.proof_verify.ms_mean)]),
  { left: true, note: `Detected/trials. Run on a ${AV.host.cpus}-vCPU container with Node ${AV.host.node}, not on the cloud VMs; the log and its proofs are held by the adversary, the root by the ledger.` }));
push(H2(S_REG + ' Registry Size'));
push(P(`The end-to-end runs used up to 200 devices. To see whether proof handling would limit larger sites, we measured the Merkle epoch tree of the device registry from ${fc(avB(1000).devices)} to ${fc(avB(1000000).devices)} entries in the same local test. The proof grows from ${avB(1000).proof_bytes} to ${avB(1000000).proof_bytes} bytes (depth ${avB(1000).depth} to ${avB(1000000).depth}) and one proof takes ${f2(avB(1000).verify_us_per_proof / 1000)} to ${f2(avB(1000000).verify_us_per_proof / 1000)} ms to verify on one core, which is ${fc(avB(1000000).verify_per_s_one_core)}–${fc(avB(1000).verify_per_s_one_core)} verifications per second per core with a JavaScript hash. A PEP that verifies a proof on every cache miss therefore pays well under a millisecond even at one million devices, and the cost grows with the logarithm of the registry. The costs that grow faster are building the tree, which the registrar does once per epoch off the request path (${f0(avB(1000000).build_ms / 1000)} s for ${fc(avB(1000000).devices)} entries on one core), and the cache itself. These numbers cover proof handling only. They contain no network, no ledger and no contention between gateways, so they do not replace an end-to-end run, and our measured claim for the whole system stays at 200 devices.`));
push(H2(S_OPT + ' Operator Tampering, Static Analysis and Admin Control'));
push(P(`Section ${S_AUD} tested whether a verifier can check a batch it is handed. The harder question is what a malicious operator can change afterwards, and who would notice. We compared three ways of keeping the same ${fc(OT.records)} audit records in ${OT.records / OT.batch} batches: a mutable central log with nothing published outside the operator (the audit trail of baseline B6), a hash-chained log whose head the operator publishes on its own site, and BC-ZTA, with batch roots anchored in the real *AuditLog* contract on a local Hardhat network. The operator can edit the database and holds the contract admin key but is not in the validator quorum. The verifier sees only what each design publishes outside the operator’s control (Table @tamper).`, { keepNext: true }));
const dt = (v) => (v ? 'Detected' : 'Not detected');
push(table('TABLE @tamper. OPERATOR TAMPERING: WHAT AN OUTSIDE VERIFIER NOTICES (LOCAL TEST)', [1700, 1000, 1000, 1100], ['Operator action', 'Central log', 'Hash chain', 'BC-ZTA anchors'], [
  ['Edit one record', dt(OT.attacks.modify_record.central), dt(OT.attacks.modify_record.hashchain), dt(OT.attacks.modify_record.anchored)],
  ['Delete one record', dt(OT.attacks.delete_record.central), dt(OT.attacks.delete_record.hashchain), dt(OT.attacks.delete_record.anchored)],
  ['Insert a forged record', dt(OT.attacks.insert_record.central), dt(OT.attacks.insert_record.hashchain), dt(OT.attacks.insert_record.anchored)],
  ['Rewrite the log and recompute the chain', dt(OT.attacks.rewrite_whole_log.central), dt(OT.attacks.rewrite_whole_log.hashchain), dt(OT.attacks.rewrite_whole_log.anchored)],
  ['Anchor a replacement root as admin', dt(OT.attacks.reanchor_new_root.central), dt(OT.attacks.reanchor_new_root.hashchain), dt(OT.attacks.reanchor_new_root.anchored)],
  ['Gateway drops a record before anchoring', dt(OT.attacks.gateway_omits_record.central), dt(OT.attacks.gateway_omits_record.hashchain), dt(OT.attacks.gateway_omits_record.anchored)],
], { left: true, note: 'Logic-level comparison on the real AuditLog contract; the verifier rules are ours. It states what each design publishes, not how fast it runs.' }));
push(P(`The central log shows nothing, because there is nothing outside the operator to compare it with. The hash chain catches edits, deletions and insertions but not a full rewrite followed by a new head. The anchored design catches all five edits, including the case where the operator authorises itself and anchors a replacement root: the original root stays on the ledger, and the number of anchors no longer matches the number of batches. No design here notices a gateway that drops a record before it is anchored, as Section 4.6 says. The comparison is fair only up to a point: a central log with an independent monitor that keeps earlier heads could detect the same edits. The ledger’s advantage is that no such trusted party has to exist, because independent validators hold the roots.`));
push(P(`We also ran the static analyser Slither (version 0.11.6) on the contracts. It reported no high-impact findings, ${slN('Medium')} medium finding (strict equality on a hash comparison in *verifyInBatch*, which is intended), ${slN('Low')} low findings (block-timestamp comparisons, which are how session lifetimes and the update rate limit work), ${slN('Informational')} informational findings and ${slN('Optimization')} gas suggestions. We did no symbolic analysis (for example Mythril), formal verification or independent manual audit.`));
push(P(`Finally, *AccessControl* and *AuditLog* can now hand the admin role to a multisig contract. In the unit tests a 2-of-3 *MultiSigAdmin* applies a policy change and a gateway authorisation only after two owners confirm, and the old single key is refused. This was not part of the cloud measurements.`));
push(H2(S_CMP + ' Comparison with Baselines'));
push(P(`BC-ZTA is ${f1(e('bczta', 50).mean_ms - e('abac', 50).mean_ms)} ms slower than a ledger-free ABAC store at 50 devices, and in return it adds decentralised identity, shared policy and tamper-evident anchored audit, which B2 lacks. Against the centralised PKI-IAM it is ${pct(e('bczta', 50).mean_ms, e('central', 50).mean_ms)}% faster at 50 devices, a gap set by the injected 40 ms delay on the directory, and it removes the central directory. Against the synchronous blockchain it saves about ${f1(e('bcsync', 50).mean_ms / 1000)} s per decision and avoids the ledger ceiling. Against real Keycloak and OpenLDAP (Section 6.8) it is ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× and ${f0(xe('ldap', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster at 100 devices, but a PEP-side cache gives similar mean latency at the cost of stale revocations${HAVE_XR ? ', and a central directory with pushed revocations (Section 6.10) matches its latency and revokes faster' : ''}. The price of BC-ZTA is revocation latency: about ${f1(E.E2['bczta-events'].mean_ms / 1000)} s with events (one block), against about ${f0(x2('keycloak').mean_ms)} ms for a central store. The Ethereum-based framework of Section 1 pays about 25 ms extra per request against a perimeter-based baseline {{singh}}, in line with our finding that consensus on the request path is the bottleneck.`));
push(H2(DISC_N + ' Discussion'));
push(P(`The main trade-off is simple: we accept a bounded delay in revocation and get low decision latency in return.${HAVE_XR ? ' As Section 6.10 showed, this is not specific to the ledger, so the ledger has to be justified by who controls identity state and who can verify the audit, not by speed.' : ''} `));
{
  const ATKN = Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0);
  const xrUp = XR ? Math.max(...[25, 100, 200].map(n => dci(XR.P1.bczta[String(n)].mean_ms, XR.P1.push[String(n)].mean_ms, XR.n_runs).hi)) : null;
  push(P('Table @claims sets each main claim beside the kind of evidence behind it and its main limit, so that a reader can see which results were measured, which were only tested with negative cases or argued, and which are design only.', { keepNext: true }));
  push(table('TABLE @claims. CLAIMS, EVIDENCE AND LIMITS', [1350, 1700, 1800], ['Claim', 'Evidence', 'Main limit'], [
    ['Decisions do not wait for consensus', `Measured, ${E.runs} runs: ${f1(e('bczta', 50).mean_ms)} ms mean at 50 devices; ${f1(e('bcsync', 50).mean_ms / 1000)} s when every request is a transaction`, 'Emulated devices, one zone; one PEP is at capacity near 200 devices'],
    ...(XR ? [['The ledger is not faster than a push-revocation directory (B6)', `Measured, ${XR.n_runs} runs: latency difference at most ${fu(xrUp)} ms (95% CI upper bound); B6 revokes in ${f0(XR.P2.push.mean_ms)} ms, BC-ZTA in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s`, 'One unclustered directory; no run of another blockchain system']] : []),
    ['Revocation delay is bounded', `Measured, ${E.runs} runs: ${f1(E.E2['bczta-events'].mean_ms / 1000)} s mean with events`, 'A consensus halt delays revocations by minutes'],
    ['Forged, replayed, stale or unauthorised requests are rejected', `Tested: all ${ATKN} attack requests rejected`, 'Negative tests and argument, not a proof; replay at another gateway is possible by default'],
    ['Tampering with audit records is detectable', 'Tested locally: edits, deletions, insertions and root replacement caught by the anchors', 'Tamper-evidence only; a gateway can omit a record'],
    ['Batch anchoring cuts audit gas', `Measured: ${f0(gasRatio(50))}–${f0(gasRatio(1000))}× less gas per record`, 'Gas is a relative measure on a permissioned chain'],
    ['The ledger gives shared control of identity and policy', 'Argued; unit tests of a 2-of-3 multisig admin', 'Not tested with independent organisations'],
    ['Trust scoring and micro-segmentation', 'Design only', 'Not evaluated'],
  ], { left: true, note: 'Evidence type: measured = repeated runs on the testbed; tested = scripted cases; argued = reasoning under stated assumptions.' }));
}
push(H2(DISC + ' Limitations and Deployment Considerations'));
push(P(`The main limits are these. (i) All seven VMs sit in one zone of one cloud, so delays are those of a data-centre network plus the injected 40 ms, and absolute numbers depend on VM size. (ii) B1–B3 are our own simple re-implementations. Keycloak ran as a single node in development mode and OpenLDAP as a single server, so tuned or clustered setups may behave differently, especially for availability. (iii) Devices are emulated, up to 200 at 1 request/s. Larger registries were tested only as a proof microbenchmark (Section ${S_REG}). We used no physical devices, secure elements, industrial protocols (OPC UA, Modbus, MQTT) or bursty, churn-heavy workloads. (iv) One plant authority key issues registrations and revocations, so its compromise is out of scope. (v) The availability tests are narrow: Besu rejected part of the E4 flood (${f0(FB['1200'].rejected)} of ${f0(FB['1200'].attempts)} submissions at 1,200 tx/s), E5 stops one validator once for 30 s${HAVE_XR ? ' and Section 6.10 stops two for 40 s' : ''}, and we tested no network partition or Byzantine validator. (vi) Runs are few and hosts differ between experiments (e2-standard-2 PEP hosts early, 4-vCPU hosts in Sections 6.10–6.12), so we compare designs only within one experiment: five repetitions (three for the IAM tests, two for the flood sweep), so intervals are wide. A single-process PEP saturates near 250–290 req/s, so larger sites need several PEPs${HAVE_XR ? ' (scale-out was measured on one host only)' : ''}. (vii) Trust scores are voted, not learned, and micro-segmentation (R5) is not implemented, so only R1, R2 and R6 are evaluated end to end. (viii) At 200 devices the PEP is at capacity. BC-ZTA averaged ${f1(e('bczta', 200).mean_ms)} ms in one run and ${f0(xe('bczta', 200).mean_ms[0])} ms (P95 ${f0(xe('bczta', 200).p95_ms[0])} ms) in another, so the headline latencies are those at 50 and 100 devices. (ix) For audit we compared against a hash-chained log, not a Certificate-Transparency-style log with independent monitors {{rfc6962}}, which is also tamper-evident without a ledger. The ledger’s edge over such a log is shared write control among domains that distrust each other. We tested that only logically (Section ${S_OPT}), not with independent organisations running validators. (x) The related-work comparison is our reading of the papers. We ran no other blockchain zero-trust system, so no number here is a head-to-head result. Two effects remain unexplained: the 73 s that revocation needed after a consensus restart, and the bimodal ABAC revocation samples.`));
push(P(`The security analysis (Section 4.6) adds more limits. The nonce cache is per gateway, and in the measured configuration the signed request names no gateway, so a captured request can be replayed once at another gateway within Δ. The released code has an optional gateway binding (*GATEWAY_BIND*, default off). A message-level check shows that a bound request is rejected at another gateway, but the cloud runs used the unbound setup. The default read path trusts one ledger node. The quorum option exists${HAVE_XR ? ' and its cost is measured in Section 6.10, but it' : ' but it'} is not part of the default measurements. A compromised gateway can omit audit records, and the Merkle epoch proof shows enrolment, not freshness. We did not measure the device-side cost of signing and storing a proof, so fit with constrained devices (D5) is an argument, not a result. Each request is signed on its own, which suits access decisions but not high-rate telemetry, where a session credential would be better. The analysis is an argument under stated assumptions, not a machine-checked proof; a Tamarin or ProVerif model is the obvious next step. Such limits are common: a review of 33 trust-score studies for zero-trust access control found that about two thirds rely on simulation only and fewer than a fifth consider adversarial threats {{ruambo26}}.`));
push(P('Emulation limits what the numbers say about absolute latency, and much less about the comparison. All designs ran on the same testbed, and what separates them (a consensus round on the request path, a wide-area round trip to a central directory, and the time a revocation needs to reach the enforcement point) depends on the block interval and the path delay, not on device hardware. A plant WAN with longer or more variable delay would slow the centralised designs and the cache-miss path of BC-ZTA but not its cached path, and a multi-site Besu network would slow block finality and so revocation. This is an argument; only a multi-site measurement could confirm it.'));
push(P('For deployment, the validators must be run by independent parties (plant, integrator, vendor), or the Byzantine assumption means little. Device keys belong in a secure element or TPM, since identity is only as strong as key custody. Rotation goes through *updateKey* by the enrolment authority; we did not evaluate the cost of rotating a fleet or the custody of the authority key. The replay window assumes that gateway and device clocks differ by less than half of Δ, which constrained devices can meet only with a time source such as NTP from the gateway. We did not test this. On-chain records hold key hashes, scores and event hashes, not process data. Even so, a DID or a score update is a stable pseudonym, so any member with ledger access can link events to one device, and resource identifiers in a policy show which assets exist. Deployments that treat the inventory as sensitive should use per-organisation private data or per-epoch pseudonyms. We evaluated neither and did not analyse legal privacy requirements. In the measured prototype *AuditLog* and *grantSession* could be called by any account. The released code restricts both to an admin-managed set of gateway addresses (the unit tests cover unauthorised-caller reverts). The cloud measurements predate this change; re-measured gas on the hardened contracts is +1.2% (*logEvent*), +1.6% (*anchorBatch*) and +3.1% (*grantSession*), so the gas figures hold in substance. An authorised gateway can still write false records, so the allow-list limits who writes, not what is written. We did not test QBFT, which Besu also offers; consensus is off the request path, so we expect PEP-side latency to be unchanged, but revocation delay and halt behaviour would need re-measuring. Gas has no price on a permissioned network, so the gas figures are a relative measure of on-chain work. Finally, the fail-closed rule of Section 3.7 gives up some availability for safety while the ledger is partitioned, so it should be tuned to the plant’s uptime needs.'));

// ---- 7 CONCLUSION
push(H1('7. Conclusion'));
push(P(`This paper presented BC-ZTA, a blockchain-assisted zero-trust architecture that keeps consensus off the request path through edge-cached, Merkle-verified state and asynchronous, batched anchoring. Four Solidity contracts and an optional multisig admin contract pass 18 unit tests, and batch anchoring costs ${f0(gasRatio(50))}–${f0(gasRatio(1000))}× less gas per record than per-event logging for batches of 50–1,000 records.`));
push(P(`On seven Google Cloud VMs with a four-validator Besu network, BC-ZTA decided in ${f1(e('bczta', 50).mean_ms)} ms on average at 50 devices, served 200 devices without failed requests, and kept deciding while one validator was stopped. A single enforcement point is at capacity near 200 devices, so we regard 50–100 devices per enforcement point as the reliable range and rely on replication beyond that. The synchronous design needed ${f1(e('bcsync', 50).mean_ms / 1000)} s at 50 devices and answered only ${f0(100 * e('bcsync', 200).success_ratio)}% of requests at 200. The price of BC-ZTA is a revocation delay of about ${f1(E.E2['bczta-events'].mean_ms / 1000)} s with event-driven invalidation.${XR ? ` A central directory with pushed revocations has the same latency and revokes in ${f0(XR.P2.push.mean_ms)} ms, so the case for the ledger rests on removing any single operator’s control over identity state and on audit that third parties can verify, not on speed. During a consensus halt, revocations wait for consensus (here ${f0(XR.P4.reduce((x, r) => x + r.revocation_enforced_after_submit_ms, 0) / XR.P4.length / 1000)} s on average).` : ''} All forged, replayed, stale, unregistered, tampered and policy-violating requests were rejected. Tampering with anchored audit batches was caught in every local trial except swapping adjacent records, which a sequence number in each record now closes.`));
push(P(`Requirements R4 and R5 are design-level only, and the evaluation used emulated devices on cloud VMs in one zone with injected network delay. Next steps are a multi-site Besu deployment with real delay, physical devices and industrial protocols, clustered production IAM baselines, learned trust scoring and post-quantum signatures.`));

// =============================== REFERENCES ==========================================
if (order.length !== Object.keys(REFS).length) {
  const missing = Object.keys(REFS).filter(k => !order.includes(k));
  console.error('UNCITED REFS:', missing.join(', '));
}
const refParas = [];
const listOrder = AY ? order.slice().sort((a, b) => AYR.authors(a).localeCompare(AYR.authors(b)) || AYR.yr(a).localeCompare(AYR.yr(b))) : order;
listOrder.forEach((k, i) => {
  const r = REFS[k];
  const base = { font: FONT, size: 15 };
  if (AY) {
    const e = AYR.entry(k);
    refParas.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 40, line: 200 }, indent: { left: 280, hanging: 280 },
      children: [new TextRun({ ...base, text: e.pre }), new ExternalHyperlink({ link: e.link, children: [new TextRun({ ...base, text: e.link, color: '0563C1', underline: {} })] })] }));
    return;
  }
  const kids = [new TextRun({ ...base, text: `[${i + 1}]\t` })];
  if (process.env.FORMAT === 'elsevier') {
    const b = require('./elsref.js').build(k);
    b.segs.forEach(s => kids.push(new TextRun({ ...base, text: s.t, italics: !!s.i })));
    kids.push(new ExternalHyperlink({ link: b.url, children: [new TextRun({ ...base, text: b.url, color: '0563C1', underline: {} })] }));
    kids.push(new TextRun({ ...base, text: '.' }));
    refParas.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 20, line: 200 },
      indent: { left: 280, hanging: 280 }, tabStops: [{ type: docx.TabStopType.LEFT, position: 280 }], children: kids }));
    return;
  }
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
const ABSTRACT = HAVE_XR ? `Edge computing for Industrial IoT (IIoT) needs per-request access decisions, but a replicated ledger on the decision path adds seconds of latency. We propose BC-ZTA, an architecture in which edge policy enforcement points decide from cached, Merkle-verified ledger state, while identity, trust and audit updates reach a permissioned Hyperledger Besu network asynchronously. We implemented the enforcement point and six baselines, including Keycloak, OpenLDAP and a central directory with pushed revocations, and measured them on seven cloud VMs with four validators. At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms, against ${f1(e('central', 50).mean_ms)} ms for a central directory with 40 ms network delay and ${f0(e('bcsync', 50).mean_ms)} ms when every request is an on-chain transaction; the synchronous design answers only ${f0(100 * e('bcsync', 200).success_ratio)}% of requests at 200 devices, whereas BC-ZTA served 200 emulated devices without failed requests, at its enforcement point’s capacity. Event-driven invalidation revokes in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s (a closed-form model, one fitted parameter, predicts it), and in the tested attack classes all ${f0(Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0))} requests were rejected. Batch anchoring cuts audit gas per record ${f0(gasRatio(50))}- to ${f0(gasRatio(1000))}-fold. A central directory with pushed revocation matches BC-ZTA’s latency and revokes in ${f0(XR.P2.push.mean_ms)} ms, so the ledger buys shared control and tamper-evident audit, not speed, and pays off only where no single operator should control identity or audit. Local tests detected all tampering of anchored audit records; Merkle proofs stay below ${f0(Math.ceil(avB(1000000).proof_bytes / 100) * 100)} bytes and ${f1(Math.ceil(avB(1000000).verify_us_per_proof / 100) / 10)} ms at one million devices. Limits: one cloud zone, injected delay, emulated devices, untested trust scoring, and consensus halts that delay revocations by minutes.` : `Industrial IoT (IIoT) networks need continuous, per-request verification, but placing a blockchain on the authentication path adds seconds of latency and saturates ledger capacity. We propose BC-ZTA, a three-tier blockchain-assisted zero-trust architecture in which edge policy enforcement points decide from cached, Merkle-verified ledger state, while identity, trust and audit updates are written asynchronously to a permissioned Hyperledger Besu (IBFT 2.0) network through four Solidity contracts. We implemented the policy enforcement point and five baselines, including real Keycloak and OpenLDAP services, and measured them end to end on a four-validator Besu network (five repetitions, seven cloud VMs). At 50 devices BC-ZTA answers in ${f1(e('bczta', 50).mean_ms)} ms on average, compared with ${f1(e('central', 50).mean_ms)} ms for a centralised directory with an injected 40 ms network delay and ${f0(e('bcsync', 50).mean_ms)} ms when every request is an on-chain transaction; the synchronous design answers only ${f0(100 * e('bcsync', 200).success_ratio)}% of the requests at 200 devices, whereas BC-ZTA served 200 devices with no failures and about one on-chain write per second, and kept deciding while one of the four validators was stopped. Event-driven cache invalidation enforces a revocation in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s on average, and all ${f0(Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0))} forged, replayed, stale, unregistered, tampered or policy-violating requests were rejected. Merkle batch anchoring cuts audit gas per record by ${f0(gasRatio(50))}× to ${f0(gasRatio(1000))}× for batches of 50 to 1,000 records. Against real Keycloak and OpenLDAP services, BC-ZTA decides ${f0(xe('keycloak', 100).mean_ms[0] / xe('bczta', 100).mean_ms[0])}× faster at 100 devices but revokes in ${f1(E.E2['bczta-events'].mean_ms / 1000)} s rather than about ${f0(x2('keycloak').mean_ms)} ms, and its latency (P95 ≤ 8 ms) holds when the ledger is flooded up to 1,200 tx/s. ${XR ? `A central directory that pushes revocations without a blockchain matches its latency and revokes in ${f0(XR.P2.push.mean_ms)} ms, so the ledger buys trust distribution and independently tamper-evident audit, not speed; both designs fail closed after twice the cache lifetime when their state source is lost, and a consensus halt delays revocations by minutes.` : ''} Limitations are the single cloud zone with injected network delay, single-node IAM products, a single-process PEP and the emulated device population.`;
if (process.env.ABSCOUNT) console.log('ABSTRACT words', ABSTRACT.split(/\s+/).length);
const ATK_N = Object.entries(E.E3).filter(([k]) => k !== 'revoked_device' && k !== 'legitimate_requests (control)').reduce((a, [, v]) => a + v.attempts, 0);
const ABSTRACT_COSE = HAVE_XR ? `Zero-trust access control for the industrial Internet of Things means checking every request, yet putting a blockchain on the authentication path adds seconds of delay and exhausts ledger capacity. We describe BC-ZTA, in which edge enforcement points decide from cached ledger state verified against a Merkle root, while identity, trust and audit updates reach a permissioned Hyperledger Besu network asynchronously. We built it with six baselines (including Keycloak and a central directory with pushed revocation) and tested it on seven cloud virtual machines with four validators. None of ${f0(ATK_N)} forged, replayed, stale, unregistered, tampered or policy-violating requests was accepted; these are negative tests, not attacks by a compromised gateway. A revoked device was refused after ${f1(E.E2['bczta-events'].mean_ms / 1000)} s, and access stops once the state source has been lost for twice the cache lifetime. Decisions took ${f1(e('bczta', 50).mean_ms)} ms at 50 devices, against ${f1(e('central', 50).mean_ms)} ms for a central directory behind an injected 40 ms delay. That gap is one wide-area round trip, not a general speed-up: a central directory with pushed revocation matches the latency and revokes faster (${f0(XR.P2.push.mean_ms)} ms). The ledger adds trust and audit that third parties can verify: in local tests, anchoring exposed five kinds of operator edit, one of which a hash-chained log misses, and Merkle proofs stay below ${f0(Math.ceil(avB(1000000).proof_bytes / 100) * 100)} bytes and ${f1(Math.ceil(avB(1000000).verify_us_per_proof / 100) / 10)} ms at one million devices. A consensus halt delays revocation by minutes. Up to 200 devices were emulated, all machines sat in one zone, and trust scoring and micro-segmentation are design-level only.` : '';
const front = [
  new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 160 }, children: [new TextRun({ text: FG2 ? 'Manuscript submitted to Future Generation Computer Systems' : 'Date of publication xxxx 00, 0000, date of current version xxxx 00, 0000. Digital Object Identifier 10.1109/ACCESS.2026.0000000', font: FONT, size: 15, italics: true })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
    children: [new TextRun({ text: 'Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable Industrial Internet of Things (IIoT)', font: FONT, size: 36 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 },
    children: [new TextRun({ text: 'Syed Irfan Raza Naqvi, Muhammad Umar Aftab, Ahmad Mohsin, Rana Asif Rehman and Sayed Qaiser Ali Shah', font: FONT, size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 140 },
    children: [new TextRun({ text: 'FAST-NUCES, Lahore and Chiniot-Faisalabad, Pakistan (Naqvi, Aftab); Edith Cowan University, Australia (Mohsin); Muscat University, Oman (Rehman); International Islamic University, Islamabad, Pakistan (Shah)', font: FONT, size: 18, italics: true })] }),
  new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 100 }, indent: { left: 360, right: 360 }, children: [new TextRun({ text: 'Corresponding author: Syed Irfan Raza Naqvi (e-mail: l259000@lhr.nu.edu.pk; irfanrazanaqvi9@gmail.com). Co-author e-mails: umar.aftab@nu.edu.pk; a.mohsin@ecu.edu.au; rasif@muscatuniversity.edu.om; qaiser.ali@iiu.edu.pk. This research received no specific grant from any funding agency.', font: FONT, size: 16 })] }),
  new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 60, line: 228 }, indent: { left: 360, right: 360 }, children: [
    new TextRun({ text: 'ABSTRACT ', font: FONT, size: 18, bold: true }),
    ...runs(ABSTRACT, { size: 18, bold: false }).map(x => x),
  ] }),
  new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 100 }, indent: { left: 360, right: 360 }, children: [
    new TextRun({ text: FG2 ? 'Keywords: ' : 'INDEX TERMS ', font: FONT, size: 18, bold: true }),
    new TextRun({ text: 'Access control, blockchain, Hyperledger Besu, industrial Internet of Things, scalability, smart contracts, zero trust.', font: FONT, size: 18 }),
  ] }),
];

// ================================ DOCUMENT ==========================================
const pageProps = { page: { size: FG2 ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 }, margin: { top: 1000, bottom: 1000, left: 1080, right: 1080 } } };
const footer = new Footer({ children: [new Paragraph({ tabStops: [{ type: docx.TabStopType.RIGHT, position: 10080 }],
  children: [new TextRun({ text: 'NAQVI et al.: Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable IIoT', font: FONT, size: 15, italics: true }),
    new TextRun({ text: FG2 ? '\t' : '\tVOLUME XX, 2026  |  ', font: FONT, size: 15 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 15 })] })] });

// ---------------- Elsevier (FGCS) manuscript: single column, A4, line numbers, declarations -------------
const hiText = COSE ? [
  'Edge enforcement decides from cached ledger state checked against a Merkle root',
  'Negative tests: no forged, replayed, stale or tampered request was accepted',
  'Access fails closed once the state source is lost for twice the cache lifetime',
  'Anchored audit exposed operator edits that a mutable central log cannot show',
  'A central directory with pushed revocation revokes faster: the ledger adds trust',
] : [
  'Edge enforcement point decides from Merkle-verified cached ledger state',
  'Consensus stays off the request path; audit is anchored in batches',
  'Tested on seven cloud VMs; tamper detection and million-device proofs tested locally',
  'Compared with Keycloak, OpenLDAP and a ledger-free push-revocation baseline',
  'Bounded staleness: fail-closed after twice the cache lifetime',
];
if (ELS) hiText.forEach(h => { if (h.length > 85) throw new Error('highlight too long: ' + h); });
const elsFront = () => [
  new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 200 }, children: [new TextRun({ text: COSE ? 'Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT' : 'Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT: An Overhead and Governance Analysis', font: FONT, size: 36, bold: true })] }),
  new Paragraph({ spacing: { after: 40 }, children: [
    new TextRun({ text: 'Syed Irfan Raza Naqvi', font: FONT, size: 24 }), new TextRun({ text: 'a,*', font: FONT, size: 24, superScript: true }),
    new TextRun({ text: ', Muhammad Umar Aftab', font: FONT, size: 24 }), new TextRun({ text: 'b', font: FONT, size: 24, superScript: true }),
    new TextRun({ text: ', Ahmad Mohsin', font: FONT, size: 24 }), new TextRun({ text: 'c', font: FONT, size: 24, superScript: true }),
    new TextRun({ text: ', Rana Asif Rehman', font: FONT, size: 24 }), new TextRun({ text: 'd', font: FONT, size: 24, superScript: true }),
    new TextRun({ text: ', Sayed Qaiser Ali Shah', font: FONT, size: 24 }), new TextRun({ text: 'e', font: FONT, size: 24, superScript: true })] }),
  ...[['a', ' FAST School of Computing, Department of Computer Science, National University of Computer and Emerging Sciences (FAST-NUCES), 852-B Milaad Street, Block B, Faisal Town, Lahore 54770, Pakistan'],
      ['b', ' Department of Computer Science, National University of Computer and Emerging Sciences (FAST-NUCES), Chiniot-Faisalabad Campus, FAST Square, Chiniot 38000, Pakistan'],
      ['c', ' School of Science, Edith Cowan University, 270 Joondalup Drive, Joondalup WA 6027, Australia'],
      ['d', ' Faculty of Engineering and Technology, Muscat University, Building 2089, Al Ghubra North, P.O. Box 550, PC 130, Muscat, Oman'],
      ['e', ' Department of Computer Science, Faculty of Computing and Information Technology, International Islamic University, New Campus, Sector H-10, Islamabad 44000, Pakistan']].map(([k, t]) =>
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: k, font: FONT, size: 20, superScript: true }), new TextRun({ text: t, font: FONT, size: 20, italics: true })] })),
  new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: '* Corresponding author. E-mail: l259000@lhr.nu.edu.pk; irfanrazanaqvi9@gmail.com. Co-authors: umar.aftab@nu.edu.pk; a.mohsin@ecu.edu.au; rasif@muscatuniversity.edu.om; qaiser.ali@iiu.edu.pk', font: FONT, size: 20 })] }),
  new Paragraph({ spacing: { before: 120, after: 80 }, border: { top: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 6 } }, children: [new TextRun({ text: 'Abstract', font: FONT, size: 24, bold: true })] }),
  new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 160, line: 288 }, children: runs(COSE && ABSTRACT_COSE ? ABSTRACT_COSE : ABSTRACT, { size: 22 }) }),
  new Paragraph({ spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 6 } }, children: [new TextRun({ text: 'Keywords: ', font: FONT, size: 22, bold: true, color: '000000' }), new TextRun({ text: COSE ? 'Zero trust; Access control; Industrial IoT; Blockchain; Audit integrity; Revocation; Smart contracts' : 'Zero trust; Blockchain; Industrial Internet of Things; Access control; Hyperledger Besu; Smart contracts; Audit', font: FONT, size: 22 })] }),
];
const elsBack = () => [
  H1('Declaration of competing interest'),
  P('The authors declare that they have no known competing financial interests or personal relationships that could have appeared to influence the work reported in this paper.'),
  H1('CRediT authorship contribution statement'),
  P('**Syed Irfan Raza Naqvi:** Conceptualization, Methodology, Software, Validation, Formal analysis, Investigation, Data curation, Writing – original draft, Writing – review and editing, Visualization. **Muhammad Umar Aftab:** Conceptualization, Supervision, Writing – review and editing. **Ahmad Mohsin:** Supervision. **Rana Asif Rehman:** Supervision. **Sayed Qaiser Ali Shah:** Supervision.'),
  H1('Funding'),
  P('This research did not receive any specific grant from funding agencies in the public, commercial, or not-for-profit sectors.'),
  H1('Data availability'),
  P(!CSI ? 'The Solidity contracts, the PEP and load-generator code, the Google Cloud deployment scripts and all raw results used in this paper are available at https://github.com/irfanrazanaqvi/bc-zta-iiot-experiments.' : 'The Solidity contracts, the PEP and load-generator code, the Google Cloud deployment scripts and all raw results used in this paper are available at https://github.com/irfanrazanaqvi/bc-zta-iiot-experiments (archived release with DOI: [to be added by the authors before submission]).'),
  H1('Declaration of generative AI and AI-assisted technologies in the writing process'),
  P('During the preparation of this work the authors used an AI tool (Claude, Anthropic) for writing code, data analysis and language editing. The authors reviewed and edited all output and take full responsibility for the content of the publication.'),
  H1('Acknowledgements'),
  P('This work is part of the first author’s PhD research at FAST-NUCES. He thanks his supervisor, Dr Muhammad Umar Aftab, for his guidance and patience throughout the project, and for insisting that the results be reported as they came out. He is grateful to his co-supervisors, Dr Ahmad Mohsin and Dr Rana Asif Rehman, for their advice and for their critical questions on the design and the evaluation. He also thanks Dr Sayed Qaiser Ali Shah, his mentor in blockchain, for sharing his knowledge and time.'),
  H1('References'), ...refParas,
];
if (process.env.TEXOUT) {
  require('./texgen.js')({ body, back: elsBack(), ABSTRACT, hiText, order, REFS, tok, num, E, ALT });
  process.exit(0);
}
if (ELS) {
  const elsPage = { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } };
  const elsFooter = new Footer({ children: [new Paragraph({ suppressLineNumbers: true, alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })] })] });
  const elsDoc = new Document({
    creator: 'Syed Irfan Raza Naqvi', title: COSE ? 'Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT' : 'Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT: An Overhead and Governance Analysis',
    styles: { default: { document: { run: { font: FONT, size: BODY, language: { value: 'en-GB' } } } } },
    sections: [
      { properties: { ...elsPage, lineNumbers: { countBy: 1, restart: docx.LineNumberRestartFormat.CONTINUOUS } }, footers: { default: elsFooter }, children: [...elsFront(), ...body, ...elsBack()] },
    ],
  });
  const hiDoc = new Document({ styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ properties: { ...elsPage }, children: [
      new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'Highlights', font: FONT, size: 32, bold: true })] }),
      ...hiText.map(h => new Paragraph({ bullet: { level: 0 }, spacing: { after: 100 }, children: [new TextRun({ text: h, font: FONT, size: 24 })] })),
    ] }] });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  Packer.toBuffer(elsDoc).then(b => { fs.writeFileSync(OUT, b); console.log('written', OUT, 'refs', order.length); });
  Packer.toBuffer(hiDoc).then(b => { const p = OUT.replace(/\.docx$/, '_highlights.docx'); fs.writeFileSync(p, b); console.log('written', p); });
} else {
const doc = new Document({
  creator: 'Syed Irfan Raza Naqvi', title: 'Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable IIoT',
  styles: { default: { document: { run: { font: FONT, size: BODY, language: { value: 'en-GB' } } } } },
  sections: [
    { properties: { ...pageProps, type: SectionType.CONTINUOUS }, footers: { default: footer }, children: front },
    { properties: { ...pageProps, type: SectionType.CONTINUOUS, column: { count: 2, space: 360, equalWidth: true } }, footers: { default: footer },
      children: FG2 ? [...body, ...elsBack()] : [...body, H1('Acknowledgment'), P('This research did not receive any specific grant from funding agencies in the public, commercial, or not-for-profit sectors. This work is part of the first author’s PhD research at FAST-NUCES. He thanks his supervisor, Dr Muhammad Umar Aftab, for his guidance and patience throughout the project, and for insisting that the results be reported as they came out. He is grateful to his co-supervisors, Dr Ahmad Mohsin and Dr Rana Asif Rehman, for their advice and for their critical questions on the design and the evaluation. He also thanks Dr Sayed Qaiser Ali Shah, his mentor in blockchain, for sharing his knowledge and time.'), H1('Data and Code Availability'), P('The Solidity contracts, the PEP and load-generator code, the Google Cloud deployment scripts and all raw results used in this paper are available at https://github.com/irfanrazanaqvi/bc-zta-iiot-experiments (archived release with DOI: [to be added by the authors before submission]).'), H1('References'), ...refParas, H1('Author Biographies'), P('**[AUTHOR NAME]** [Short biography, degrees, current position and research interests to be added; IEEE Access also requires a photo.]', {})] },
  ],
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
Packer.toBuffer(doc).then(b => { fs.writeFileSync(OUT, b); console.log('written', OUT, 'refs', order.length); });
}
