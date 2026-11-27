// Elsevier numbered reference style (FGCS Guide for Authors): initials without spaces, no "and", no quotes
// around titles, journal in italics, "volume (year) pages", DOI/URL as full link.
const REFS = require('./refs.js');
const OVR = {
  naqvi: { conf: 'in: Proc. 17th Int. Conf. Open Source Syst. Technol. (ICOSST), 2023' },
  pbft: { conf: 'in: Proc. 3rd USENIX Symp. Oper. Syst. Design Implement. (OSDI), New Orleans, LA, USA, 1999, pp. 173–186' },
  fabric: { conf: 'in: Proc. 13th EuroSys Conf., Porto, Portugal, 2018, Art. 30' },
  dahlmanns: { conf: 'in: Proc. ACM Internet Meas. Conf. (IMC), Virtual Event, 2020, pp. 101–110' },
  novo: { journal: 'IEEE Internet Things J.', tail: '5 (2018) 1184–1195' },
  rfc7662: { report: 'RFC 7662, Internet Engineering Task Force, 2015' },
  rfc4511: { report: 'RFC 4511, Internet Engineering Task Force, 2006' },
  rfc5280: { report: 'RFC 5280, Internet Engineering Task Force, 2008' },
  rfc6960: { report: 'RFC 6960, Internet Engineering Task Force, 2013' },
  rfc6066: { report: 'RFC 6066, Internet Engineering Task Force, 2011' },
  rfc6962: { report: 'RFC 6962, Internet Engineering Task Force, 2013' },
  did: { report: 'W3C Recommendation, World Wide Web Consortium, 2022' },
  nist: { report: 'NIST Special Publication 800-207, National Institute of Standards and Technology, Gaithersburg, MD, USA, 2020' },
};
function auth(a) {
  a = a.replace(/,? and /g, ', ').replace(/, Ed\.$/, ' (Ed.)');
  a = a.replace(/\b([A-Z]\.)(?:-[a-z]\.)? ?(?=[A-Z]\.)/g, m => m.replace(/ $/, ''));
  // collapse "S. I. R." -> "S.I.R."
  a = a.replace(/(\b[A-Z]\.) (?=[A-Z]\.)/g, '$1').replace(/(\b[A-Z]\.) (?=[A-Z]\.)/g, '$1');
  a = a.replace(/(\b[A-Z]\.) (?=[A-Z]\.)/g, '$1');
  return a.replace(/\bet al\.,?$/, 'et al.');
}
function build(k) {
  const r = REFS[k], t = r.text;
  const m = t.match(/^(.*?), “(.*?),” (.*)$/);
  if (!m) throw new Error('parse ' + k);
  let au = auth(m[1]); const title = m[2], rest = m[3];
  const head = au.endsWith('et al.') ? au.replace(/et al\.$/, 'et al.,') : au + ',';
  const segs = [{ t: head + ' ' + title + ', ' }];
  const o = OVR[k] || {};
  let url = r.url, linkText = null;
  const dm = t.match(/doi: (\S+?)\.?$/); if (dm) url = 'https://doi.org/' + dm[1];
  if (o.conf) { segs.push({ t: o.conf + '. ' }); }
  else if (o.report) { segs.push({ t: o.report + '. ' }); }
  else if (o.journal) { segs.push({ t: o.journal, i: true }, { t: ' ' + o.tail + '. ' }); }
  else if (/^arXiv:/.test(rest)) { const id = rest.match(/arXiv:(\S+?),/)[1], y = rest.match(/(\d{4})\.$/)[1]; segs.push({ t: 'arXiv:' + id + ' (' + y + '). ' }); }
  else {
    const j = rest.match(/^(.*?), vol\. (\d+)(?:, no\. [\d–-]+)?(?:, (?:pp\. ([\d–]+)|Art\. no\. (\S+?)))?, (\d{4})(?: \(online [^)]*\))?, doi: (\S+?)\.?$/);
    if (!j) throw new Error('parse2 ' + k + ': ' + rest);
    segs.push({ t: j[1], i: true }, { t: ' ' + j[2] + ' (' + j[5] + ') ' + (j[3] || j[4]) + '. ' });
  }
  linkText = url;
  return { segs, url, linkText };
}
module.exports = { build };
