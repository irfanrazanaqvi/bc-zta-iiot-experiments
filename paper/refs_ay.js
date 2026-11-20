// Author-year (Elsevier Harvard-style) labels and list entries, derived from the IEEE-style refs.js text.
// Used only by the Computers & Security build. Authors are taken as given in refs.js; "et al." entries stay "et al.".
module.exports = function (REFS) {
  const MON = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.?';
  function parse(k) {
    const r = REFS[k];
    let t = r.text;
    const q = t.indexOf('“');
    const authPart = t.slice(0, q).replace(/,\s*$/, '').trim();
    const qe = t.indexOf('”');
    const title = t.slice(q + 1, qe).replace(/,$/, '');
    let rest = t.slice(qe + 1).replace(/^,?\s*/, '');
    let etal = false, names = [];
    if (/\bet al\.?$/.test(authPart)) { etal = true; names = [authPart.replace(/\s*et al\.?$/, '')]; }
    else names = authPart.replace(/,?\s*Ed\.$/, '').split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    const ed = /,\s*Ed\.$/.test(authPart);
    const people = names.map(n => {
      n = n.replace(/\s+3rd$/, '');
      const CS = { 'A. Abou Elkalam': ['Abou Elkalam', 'A.'], 'A. Ait Ouahman': ['Ait Ouahman', 'A.'] };
      if (CS[n]) return { sur: CS[n][0], ini: CS[n][1] };
      const m = n.match(/^(.*?)\s*((?:ur\s+)?[^\s]+)$/);
      let sur = m[2], ini = m[1];
      if (/\bur$/.test(ini)) { sur = 'ur ' + sur; ini = ini.replace(/\s*ur$/, ''); }
      const I = ini.split(/\s+/).filter(Boolean).map(x => x.replace(/\./g, '').split('-').map(y => y[0] + '.').join('-')).join('');
      return { sur, ini: I };
    });
    return { title, rest, people, etal, ed, year: r.year };
  }
  const P = {};
  Object.keys(REFS).forEach(k => P[k] = parse(k));
  // labels with a/b suffix on collisions
  const base = k => { const p = P[k]; const n = p.people.length;
    const a = p.etal || n >= 3 ? p.people[0].sur + ' et al.' : n === 2 ? p.people[0].sur + ' and ' + p.people[1].sur : p.people[0].sur; return a; };
  const groups = {};
  Object.keys(REFS).forEach(k => { const key = base(k) + '|' + P[k].year; (groups[key] = groups[key] || []).push(k); });
  const suffix = {};
  Object.values(groups).forEach(g => { if (g.length > 1) g.sort((a, b) => P[a].title.localeCompare(P[b].title)).forEach((k, i) => suffix[k] = 'abcdefgh'[i]); });
  const yr = k => P[k].year + (suffix[k] || '');
  const label = k => base(k) + ', ' + yr(k);
  function authors(k) {
    const p = P[k];
    let s = p.people.map(x => x.sur + ', ' + x.ini).join(', ');
    if (p.etal) s += ', et al.'; else if (p.ed) s += ' (Ed.)';
    return s;
  }
  function entry(k) {
    const p = P[k], r = REFS[k];
    let rest = p.rest, link = r.url;
    const head = authors(k) + ', ' + yr(k) + '. ' + p.title + '. ';
    let m;
    if ((m = rest.match(/^arXiv:(\d+\.\d+),/))) return { pre: head + 'arXiv preprint arXiv:' + m[1] + '. ', link };
    if ((m = rest.match(/^Internet Eng\. Task Force, RFC (\d+),/))) return { pre: head + 'RFC ' + m[1] + ', Internet Engineering Task Force. ', link };
    if (/^W3C Recommendation/.test(rest)) return { pre: head + 'W3C Recommendation. World Wide Web Consortium. ', link };
    if ((m = rest.match(/^Nat\. Inst\. Standards Technol\., Gaithersburg, MD, USA, Spec\. Publ\. (\S+),/))) return { pre: head + 'NIST Special Publication ' + m[1] + '. National Institute of Standards and Technology, Gaithersburg, MD, USA. ', link };
    rest = rest.replace(/,?\s*doi: \S+?\.?$/, '').replace(/\.$/, '');
    if (/^in Proc\./.test(rest)) {
      const parts = rest.replace(/^in /, '').split(/,\s*/);
      const keep = []; let pp = '';
      parts.forEach(x => { if (/^pp\./.test(x)) pp = x; else if (/^Art\. no\./.test(x)) pp = x; else if (new RegExp('^(' + MON + '\\s+)?\\d{4}$').test(x) || new RegExp('^' + MON + '$').test(x)) {} else keep.push(x); });
      return { pre: head + 'In: ' + keep.join(', ') + (pp ? ', ' + pp : '') + '. ', link };
    }
    // journal article
    m = rest.match(/^(.*?),\s*vol\.\s*([^,]+)(?:,\s*no\.\s*([^,]+))?(?:,\s*Art\. no\.\s*([^,]+))?(?:,\s*pp\.\s*([^,]+))?(?:,\s*(?:(?:Apr|Jun|May)\.\s*)?\d{4}.*)?$/);
    if (!m) throw new Error('cannot parse journal ref ' + k + ': ' + rest);
    let s = m[1] + ' ' + m[2] + (m[3] ? ' (' + m[3] + ')' : '') + (m[5] ? ', ' + m[5] : m[4] ? ', ' + m[4] : '');
    return { pre: head + s + '. ', link };
  }
  return { label, entry, yr, authors, P, name: base };
};
