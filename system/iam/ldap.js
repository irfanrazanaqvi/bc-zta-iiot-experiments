// OpenLDAP (real directory server) used as the central-IAM baseline "ldap".
// One entry per device under ou=devices (standard inetOrgPerson attributes, no custom schema):
//   uid = DID, description = key hash, employeeType = device class, title = trust score, departmentNumber = active | revoked.
// The PEP performs one LDAP search (filter uid=<DID>) per request over a small pool of persistent bound connections.
// Revocation = the administrator changes departmentNumber to "revoked" (ldapmodify).
const { Client, Attribute, Change } = require("ldapts");
const BASE = process.env.LDAP_BASE || "dc=bczta,dc=local";
const ADMIN_DN = process.env.LDAP_ADMIN_DN || "cn=admin," + BASE;
const ADMIN_PW = process.env.LDAP_ADMIN_PW || "bczta-ldap";
const OU = "ou=devices," + BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Ldap {
  constructor(url, { poolSize = 16 } = {}) { this.url = url; this.n = poolSize; this.slots = new Array(poolSize).fill(null); this.i = 0; }
  async _connect() {
    const c = new Client({ url: this.url, timeout: 15000, connectTimeout: 5000, strictDN: false });
    try { await c.bind(ADMIN_DN, ADMIN_PW); } catch (e) { try { await c.unbind(); } catch (e2) { /* ignore */ } throw e; }
    return c;
  }
  _slot(k) { if (!this.slots[k]) { const p = this._connect(); this.slots[k] = p; p.catch(() => { if (this.slots[k] === p) this.slots[k] = null; }); } return this.slots[k]; }
  async _drop(k, p) { if (this.slots[k] === p) this.slots[k] = null; try { const c = await p; await c.unbind(); } catch (e) { /* already closed */ } }
  async waitReady(maxMs = 60000) {
    const t0 = Date.now();
    for (;;) { try { const c = await this._connect(); await c.unbind(); return; } catch (e) { if (Date.now() - t0 > maxMs) throw new Error("ldap not ready at " + this.url + ": " + e.message); await sleep(1000); } }
  }
  /** Read one device record (the per-request lookup). Returns null if the entry does not exist. */
  async lookup(did) {
    const k = this.i++ % this.n, p = this._slot(k);
    try {
      const c = await p;
      const { searchEntries } = await c.search(OU, { scope: "sub", filter: `(uid=${did})`, attributes: ["description", "employeeType", "title", "departmentNumber"], sizeLimit: 2 });
      if (!searchEntries.length) return null;
      const e = searchEntries[0], one = (v) => (Array.isArray(v) ? v[0] : v);
      return { pkh: String(one(e.description)), cls: Number(one(e.employeeType)), trust: Number(one(e.title)), revoked: String(one(e.departmentNumber)) !== "active" };
    } catch (err) { await this._drop(k, p); throw err; }
  }
  /** (Re)creates ou=devices and one entry per device (existing entries are reset to their original values). */
  async setup(devices, { trustOf = () => 70 } = {}) {
    await this.waitReady();
    const c = await this._connect();
    try { await c.add(OU, { objectClass: ["organizationalUnit"], ou: "devices" }); } catch (e) { if (!/AlreadyExists|Already exists|already exists/i.test(String(e.name) + e.message)) throw e; }
    let next = 0;
    const worker = async () => {
      while (next < devices.length) {
        const d = devices[next++], dn = `uid=${d.did},${OU}`;
        const attrs = { description: d.pkh, employeeType: String(d.cls), title: String(trustOf(d)), departmentNumber: "active" };
        try { await c.add(dn, { objectClass: ["inetOrgPerson"], cn: d.did, sn: "device", uid: d.did, ...attrs }); }
        catch (e) {
          if (!/AlreadyExists|Already exists|already exists/i.test(String(e.name) + e.message)) throw e;
          await c.modify(dn, Object.entries(attrs).map(([type, v]) => new Change({ operation: "replace", modification: new Attribute({ type, values: [v] }) })));
        }
      }
    };
    await Promise.all(Array.from({ length: 1 }, worker));   // one bound connection; ~260 entries
    await c.unbind();
  }
  async revoke(did) {
    if (!this._admin) this._admin = await this._connect();
    try {
      await this._admin.modify(`uid=${did},${OU}`, new Change({ operation: "replace", modification: new Attribute({ type: "departmentNumber", values: ["revoked"] }) }));
    } catch (e) { try { await this._admin.unbind(); } catch (e2) { /* ignore */ } this._admin = null; throw e; }
  }
  async close() { for (let k = 0; k < this.n; k++) if (this.slots[k]) await this._drop(k, this.slots[k]); if (this._admin) { try { await this._admin.unbind(); } catch (e) { /* ignore */ } this._admin = null; } }
}
module.exports = { Ldap, BASE };
