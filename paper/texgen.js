// LaTeX (Elsevier elsarticle, two-column) emitter. Used with TEXOUT=<dir>; reads the same content the Word build uses.
const fs = require('fs'), path = require('path');
module.exports = function ({ body, back, ABSTRACT, hiText, order, REFS, tok, num, E, ALT }) {
  const OUT = process.env.TEXOUT; fs.mkdirSync(OUT, { recursive: true });
  const U = {   // unicode -> LaTeX
    '–': '--', '—': '---', '‘': '`', '’': "'", '“': '``', '”': "''", '…': '\\ldots{}', '\u00a0': '~', '\u2009': '\\,', '\u202f': '\\,',
    '×': '$\\times$', '·': '$\\cdot$', '±': '$\\pm$', '≤': '$\\leq$', '≥': '$\\geq$', '≈': '$\\approx$', '→': '$\\rightarrow$', '←': '$\\leftarrow$',
    '∈': '$\\in$', '∑': '$\\sum$', '√': '$\\surd$', '∞': '$\\infty$', '≠': '$\\neq$', '∥': '$\\|$', '⌈': '$\\lceil$', '⌊': '$\\lfloor$', '⌋': '$\\rfloor$', '⌉': '$\\rceil$', '−': '$-$',
    'Δ': '$\\Delta$', 'σ': '$\\sigma$', 'τ': '$\\tau$', 'θ': '$\\theta$', 'λ': '$\\lambda$', 'μ': '$\\mu$', 'α': '$\\alpha$', 'β': '$\\beta$', 'γ': '$\\gamma$', 'ε': '$\\epsilon$', 'δ': '$\\delta$', 'π': '$\\pi$', 'φ': '$\\varphi$', 'ω': '$\\omega$', 'ρ': '$\\rho$', 'η': '$\\eta$', 'κ': '$\\kappa$', 'ϕ': '$\\phi$',
    '•': '\\textbullet{}', '‑': '-', '°': '$^\\circ$', '≪': '$\\ll$', '≫': '$\\gg$', '⊕': '$\\oplus$', '‖': '$\\|$', '✓': '', 'ℓ': '$\\ell$', '′': "'", '⁻': '$^{-}$', '¹': '$^{1}$', '²': '$^{2}$', '³': '$^{3}$', '₁': '$_{1}$', '₂': '$_{2}$',
    'ğ': '\\u{g}', 'ı': '\\i{}', 'ü': '\\"u', 'ö': '\\"o', 'ä': '\\"a', 'é': "\\'e", 'è': '\\`e', 'á': "\\'a", 'í': "\\'i", 'ó': "\\'o", 'ú': "\\'u", 'ñ': '\\~n', 'ç': '\\c{c}', 'ş': '\\c{s}', 'ł': '\\l{}', 'ø': '\\o{}', 'š': '\\v{s}', 'č': '\\v{c}', 'ž': '\\v{z}', 'ř': '\\v{r}', 'ć': "\\'c", 'ń': "\\'n", 'ś': "\\'s", 'ź': "\\'z", 'Ç': '\\c{C}', 'Ş': '\\c{S}', 'İ': '\\.I', 'Ö': '\\"O', 'Ü': '\\"U', 'É': "\\'E", 'ö': '\\"o', 'ã': '\\~a', 'ê': '\\^e', 'ô': '\\^o', 'à': '\\`a', 'å': '\\aa{}', 'ý': "\\'y", 'ě': '\\v{e}', 'ů': '\\r{u}', 'Ł': '\\L{}', 'ß': '\\ss{}', 'æ': '\\ae{}', 'ï': '\\"i', 'î': '\\^i', 'ë': '\\"e', 'ā': '\\={a}', 'ī': '\\={i}', 'ū': '\\={u}',
  };
  const missing = new Set();
  const esc = s => { let o = ''; for (const ch of s) {
    if (U[ch] !== undefined) o += U[ch];
    else if ('&%$#_{}'.includes(ch)) o += '\\' + ch;
    else if (ch === '~') o += '\\textasciitilde{}';
    else if (ch === '^') o += '\\textasciicircum{}';
    else if (ch === '\\') o += '\\textbackslash{}';
    else if (ch === '<') o += '\\textless{}';
    else if (ch === '>') o += '\\textgreater{}';
    else if (ch === '|') o += '\\textbar{}';
    else if (ch.charCodeAt(0) > 126) { missing.add(ch); o += '?'; }
    else o += ch;
  } return o; };
  const url = s => s.replace(/(https?:\/\/[^\s)\]]+[^\s)\].,;])/g, '\u0003$1\u0004');
  function tx(text) {
    text = tok(text);
    text = text.replace(/(Table|TABLE) @(\w+)/g, (m, w, k) => '\u0001' + k + '\u0002');
    const re = /(\{\{[^}]+\}\}|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let out = '', last = 0, m;
    const plain = s => { s = url(s); let o = ''; const parts = s.split(/(\u0003[^\u0004]*\u0004|\u0001\w+\u0002)/);
      for (const p of parts) { if (p.startsWith('\u0003')) o += '\\url{' + p.slice(1, -1) + '}'; else if (p.startsWith('\u0001')) o += 'Table~\\ref{tab:' + p.slice(1, -1) + '}'; else o += esc(p); } return o; };
    while ((m = re.exec(text))) {
      if (m.index > last) out += plain(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('{{')) { const ks = t.slice(2, -2).split(',').map(x => x.trim()); ks.forEach(num); out = out.replace(/ $/, '') + '~\\cite{' + ks.join(',') + '}'; }
      else if (t.startsWith('**')) out += '\\textbf{' + plain(t.slice(2, -2)) + '}';
      else out += '\\emph{' + plain(t.slice(1, -1)) + '}';
      last = m.index + t.length;
    }
    if (last < text.length) out += plain(text.slice(last));
    return out.replace(/\s+~\\cite/g, '~\\cite');
  }
  const ACR = new Set(['IIOT', 'IAM', 'PEP', 'TTL', 'B6', 'CI', 'P95', 'PKI', 'ABAC', 'BC-ZTA', 'VM', 'DID', 'PDP']);
  const sc = c => { const ws = c.split(/(\s+)/); let first = true; return ws.map((w, i) => {
    if (/^\s+$/.test(w)) return w;
    const core = w.replace(/[(),.;:]/g, '');
    let r;
    if (core === 'IIOT') r = w.replace('IIOT', 'IIoT');
    else if (core === 'OPENLDAP') r = w.replace('OPENLDAP', 'OpenLDAP');
    else if (core === 'KEYCLOAK') r = w.replace('KEYCLOAK', 'Keycloak');
    else if (core === 'MS' || core === 'S') r = w.toLowerCase();
    else if (ACR.has(core)) r = w;
    else if (/^\d/.test(core)) r = w.toLowerCase();
    else r = w.toLowerCase();
    if (first && /[A-Za-z]/.test(r)) { r = r.replace(/[a-z]/, x => x.toUpperCase()); first = false; }
    return r; }).join(''); };
  const body_ = [...body, ...back];
  let tex = '', ul = false, secN = 0, subN = 0, figN = 0, tabN = 0, inBack = false;
  const flush = () => { if (ul) { tex += '\\end{itemize}\n\n'; ul = false; } };
  const figs = {};   // sources for the figure files
  const splitFig = { 'fig4_scalability.png': ['Figure_4a', 'Figure_4b', 'col'], 'fig6_iam_latency.png': ['Figure_6a', 'Figure_6b', 'wide'], 'fig8_flood.png': ['Figure_8a', 'Figure_8b', 'wide'], 'fig10_scaling.png': ['Figure_10a', 'Figure_10b', 'wide'] };
  const figName = { 'fig1_architecture.png': 'Figure_1', 'fig2_workflow.png': 'Figure_2', 'fig3_latency.png': 'Figure_3', 'fig5_revocation.png': 'Figure_5', 'fig7_iam_outage.png': 'Figure_7', 'fig9_failclosed.png': 'Figure_9' };
  for (const el of body_) {
    const t = el && el._tex; if (!t) continue;
    if (t.k === 'bul') { if (!ul) { tex += '\\begin{itemize}\n'; ul = true; } tex += '\\item ' + tx(t.t.replace(/^•\s+/, '')) + '\n'; continue; }
    flush();
    if (t.k === 'h1') {
      const m = t.t.match(/^(\d+)\.\s*(.*)$/);
      if (m) { secN++; subN = 0; if (+m[1] !== secN) throw new Error('section numbering mismatch at ' + t.t); tex += '\\section{' + esc(m[2]) + '}\n\n'; }
      else { if (t.t === 'References') continue; tex += '\\section*{' + esc(t.t) + '}\n\n'; }
    } else if (t.k === 'h2') {
      const m = t.t.match(/^(\d+)\.(\d+)\s*(.*)$/); if (!m) throw new Error('h2 ' + t.t);
      subN++; if (+m[1] !== secN || +m[2] !== subN) throw new Error('subsection numbering mismatch at ' + t.t + ' (auto ' + secN + '.' + subN + ')');
      tex += '\\subsection{' + esc(m[3]) + '}\n\n';
    } else if (t.k === 'p') {
      tex += tx(t.t) + '\n\n';
    } else if (t.k === 'fig') {
      const AW = (inner) => { const a = ((typeof ALT !== 'undefined' && ALT[t.file]) || '').replace(/[^\x20-\x7e]/g,' ').replace(/[\\{}%#&~^_$]/g,' ').replace(/\s+/g,' ').trim(); return a ? `\\BeginAccSupp{ActualText={${a}}}${inner}\\EndAccSupp{}` : inner; };
      figN++; const m = t.caption.match(/^Fig\.\s*(\d+)\.\s*(.*)$/s); if (+m[1] !== figN) throw new Error('figure order ' + t.caption);
      const cap = tx(m[2]);
      if (splitFig[t.file]) {
        const [a, b, kind] = splitFig[t.file];
        if (kind === 'wide') tex += `\\begin{figure*}[!t]\n\\centering\n\\begin{subfigure}{0.49\\textwidth}\\centering${AW('\\includegraphics[width=\\linewidth]{'+a+'}')}\\caption{}\\end{subfigure}\\hfill\n\\begin{subfigure}{0.49\\textwidth}\\centering${AW('\\includegraphics[width=\\linewidth]{'+b+'}')}\\caption{}\\end{subfigure}\n\\caption{${cap}}\n\\label{fig:${figN}}\n\\end{figure*}\n\n`;
        else tex += `\\begin{figure}[!tb]\n\\centering\n\\begin{subfigure}{\\columnwidth}\\centering${AW('\\includegraphics[width=0.95\\linewidth]{'+a+'}')}\\caption{}\\end{subfigure}\n\\begin{subfigure}{\\columnwidth}\\centering${AW('\\includegraphics[width=0.95\\linewidth]{'+b+'}')}\\caption{}\\end{subfigure}\n\\caption{${cap}}\n\\label{fig:${figN}}\n\\end{figure}\n\n`;
      } else tex += `\\begin{figure}[!tb]\n\\centering\n${AW('\\includegraphics[width=1\\columnwidth]{'+figName[t.file]+'}')}\n\\caption{${cap}}\n\\label{fig:${figN}}\n\\end{figure}\n\n`;
    } else if (t.k === 'table') {
      tabN++;
      const m = t.caption.match(/^TABLE @(\w+)\.\s*(.*)$/s); const key = m[1];
      const total = t.widths.reduce((a, b) => a + b, 0);
      const wide = total > 5200, env = wide ? 'table*' : 'table', ref = wide ? '\\textwidth' : '\\columnwidth';
      const n = t.widths.length, pad = 2 * n * 0.0055;
      const spec = t.widths.map((w, i) => `${(i === 0 || t.o.left) ? '>{\\raggedright\\arraybackslash}' : '>{\\centering\\arraybackslash}'}p{${(w / total * (0.98 - pad)).toFixed(3)}\\linewidth}`).join('');
      const row = r => r.map(c => tx(String(c))).join(' & ') + ' \\\\\n';
      tex += `\\begin{${env}}[!t]\n\\caption{${tx(sc(m[2]))}}\n\\label{tab:${key}}\n\\footnotesize\n\\renewcommand{\\arraystretch}{0.92}\\setlength{\\tabcolsep}{2pt}\n\\begin{tabular}{${spec}}\n\\toprule\n` + t.header.map(h => '\\textbf{' + tx(String(h)) + '}').join(' & ') + ' \\\\\n\\midrule\n' + t.rows.map(row).join('') + '\\bottomrule\n\\end{tabular}\n' + (t.o.note ? '\\par\\vspace{2pt}{\\scriptsize ' + tx(t.o.note) + '}\n' : '') + `\\end{${env}}\n\n`;
    }
  }
  flush();
  // tables: all must be referenced by key in order; verify numbering against the Word build's table order
  const TORDER = ['related', 'threat', 'lat', 'gas', 'sec', 'iam', 'outage', 'push', 'cut', 'scale', 'audit', 'tamper', 'claims'];
  const keys = [...tex.matchAll(/\\label\{tab:(\w+)\}/g)].map(x => x[1]);
  keys.forEach((k, i) => { if (TORDER.indexOf(k) !== i) console.error('TABLE ORDER differs from text numbering:', k, 'is #' + (i + 1), 'text expects #' + (TORDER.indexOf(k) + 1)); });
  // bibliography in order of first citation
  const bib = order.map(k => {
    if (process.env.FORMAT === 'elsevier') {
      const b = require('./elsref.js').build(k);
      const body = b.segs.map(s => s.i ? '\\textit{' + esc(s.t) + '}' : esc(s.t)).join('') + '\\href{' + b.url + '}{\\nolinkurl{' + b.url.replace(/([#%&_{}$])/g, '\\$1') + '}}.';
      return `\\bibitem{${k}} ${body}`;
    }
    const r = REFS[k], t = r.text, mDoi = t.match(/doi: (\S+?)\.?$/), mAx = t.match(/arXiv:\d+\.\d+/);
    let body;
    if (mDoi) { const i = t.lastIndexOf('doi: '); body = esc(t.slice(0, i)) + 'doi: \\href{' + r.url + '}{\\nolinkurl{' + mDoi[1].replace(/\.$/, '').replace(/([#%&_{}$])/g, '\\$1') + '}}.'; }
    else if (mAx) { const i = t.indexOf(mAx[0]); body = esc(t.slice(0, i)) + '\\href{' + r.url + '}{' + esc(t.slice(i)) + '}'; }
    else body = esc(t) + ' [Online]. Available: \\url{' + r.url + '}';
    return `\\bibitem{${k}} ${body}`;
  }).join('\n\n');
  const ab = tx(ABSTRACT);
  const kw = 'Zero trust; Blockchain; IIoT; Access control; Hyperledger Besu; Smart contracts; Audit';
  const mainSrc = fs.readFileSync(path.join(__dirname, 'texgen.js'), 'utf8');   // (keywords come from the docx front matter)
  const kwLine = (fs.readFileSync(path.join(__dirname, 'generate.js'), 'utf8').match(/COSE \? '[^']*' : '([^']*)'\)/g) || []).join('');
  const KW = process.env.KEYWORDS || 'Zero trust; Blockchain; IIoT; Access control; Hyperledger Besu; Smart contracts; Audit';
  const front = String.raw`\documentclass[a4paper,5p,times,twocolumn,number,sort&compress]{elsarticle}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{textcomp}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{array}
\usepackage{subcaption}
\usepackage{url}
\usepackage{microtype}
\usepackage[hidelinks,pdflang=en-GB,pdftitle={Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT}]{hyperref}
\usepackage{accsupp}
\urlstyle{same}
\setlength{\emergencystretch}{2em}
\journal{Future Generation Computer Systems}

\begin{document}

\begin{frontmatter}

\title{Blockchain-Assisted Zero-Trust Access Control and Tamper-Evident Audit for Industrial IoT: An Overhead and Governance Analysis}

\author[a]{Syed Irfan Raza Naqvi\corref{cor1}}
\ead{l259000@lhr.nu.edu.pk}
\author[b]{Muhammad Umar Aftab}
\ead{umar.aftab@nu.edu.pk}
\author[c]{Ahmad Mohsin}
\ead{a.mohsin@ecu.edu.au}
\author[d]{Rana Asif Rehman}
\ead{rasif@muscatuniversity.edu.om}
\author[e]{Sayed Qaiser Ali Shah}
\ead{qaiser.ali@iiu.edu.pk}
\cortext[cor1]{Corresponding author. Also: irfanrazanaqvi9@gmail.com}

\address[a]{FAST School of Computing, Department of Computer Science, National University of Computer and Emerging Sciences (FAST-NUCES), 852-B Milaad Street, Block B, Faisal Town, Lahore 54770, Pakistan}
\address[b]{Department of Computer Science, National University of Computer and Emerging Sciences (FAST-NUCES), Chiniot-Faisalabad Campus, FAST Square, Chiniot 38000, Pakistan}
\address[c]{School of Science, Edith Cowan University, 270 Joondalup Drive, Joondalup WA 6027, Australia}
\address[d]{Faculty of Engineering and Technology, Muscat University, Building 2089, Al Ghubra North, P.O. Box 550, PC 130, Muscat, Oman}
\address[e]{Department of Computer Science, Faculty of Computing and Information Technology, International Islamic University, New Campus, Sector H-10, Islamabad 44000, Pakistan}

\begin{abstract}
${ab}
\end{abstract}

\begin{keyword}
${KW.split(/;\s*/).map(esc).join(' \\sep ')}
\end{keyword}

\end{frontmatter}

`;
  const full = front + tex + '\\begin{thebibliography}{99}\n\\footnotesize\\raggedright\\setlength{\\itemsep}{0pt}\\sloppy\n\n' + bib + '\n\n\\end{thebibliography}\n\n\\end{document}\n';
  fs.writeFileSync(path.join(OUT, 'main.tex'), full);
  fs.writeFileSync(path.join(OUT, 'highlights.txt'), hiText.join('\n'));
  if (missing.size) console.error('UNMAPPED CHARS:', [...missing].join(' '));
  console.log('tex written', OUT, 'sections', secN, 'figs', figN, 'tables', tabN, 'refs', order.length);
};
