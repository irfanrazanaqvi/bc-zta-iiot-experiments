// Keycloak (real OIDC identity provider) used as the central-IAM baseline "keycloak".
// Each device is a Keycloak user (username = DID) with attributes device_class, trust and pkh; the device holds an access token and the
// PEP calls the token-introspection endpoint on every request (RFC 7662), i.e. one online lookup at the central server per request.
// Revocation = the administrator disables the account; introspection then reports the token as inactive.
const http = require("http");
const REALM = process.env.KC_REALM || "bczta";
const CLIENT = process.env.KC_CLIENT || "bczta-pep";
const SECRET = process.env.KC_SECRET || "bczta-secret";
const PASS = "BcZta-device-1!";
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(base, method, path, { headers = {}, json, form, timeout = 60000 } = {}) {
  const u = new URL(base);
  let body = null;
  if (json !== undefined) { body = JSON.stringify(json); headers = { ...headers, "content-type": "application/json" }; }
  else if (form) { body = new URLSearchParams(form).toString(); headers = { ...headers, "content-type": "application/x-www-form-urlencoded" }; }
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: u.hostname, port: u.port || 80, path, method, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) }, agent, timeout }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c));
      res.on("end", () => { const text = Buffer.concat(ch).toString(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j, text, headers: res.headers }); });
    });
    rq.on("timeout", () => rq.destroy(new Error("keycloak request timeout " + path)));
    rq.on("error", reject);
    rq.end(body);
  });
}

class Keycloak {
  constructor(base, opts = {}) {
    this.base = base; this.adminUser = opts.adminUser || process.env.KC_ADMIN || "admin"; this.adminPass = opts.adminPass || process.env.KC_ADMIN_PASSWORD || "admin";
    this._tok = null; this._tokExp = 0; this.ids = new Map();
  }
  async waitReady(maxMs = 180000) {
    const t0 = Date.now();
    for (;;) {
      try { const r = await request(this.base, "GET", "/realms/master"); if (r.status === 200) return; } catch (e) { /* not up yet */ }
      if (Date.now() - t0 > maxMs) throw new Error("keycloak not ready at " + this.base);
      await sleep(2000);
    }
  }
  async adminToken(force = false) {
    if (!force && this._tok && Date.now() < this._tokExp - 15000) return this._tok;
    const r = await request(this.base, "POST", "/realms/master/protocol/openid-connect/token", { form: { grant_type: "password", client_id: "admin-cli", username: this.adminUser, password: this.adminPass } });
    if (r.status !== 200) throw new Error("keycloak admin login failed: " + r.status + " " + r.text.slice(0, 200));
    this._tok = r.json.access_token; this._tokExp = Date.now() + r.json.expires_in * 1000;
    return this._tok;
  }
  async admin(method, path, json) {
    const r = await request(this.base, method, "/admin/realms" + path, { headers: { authorization: "Bearer " + (await this.adminToken()) }, json });
    return r;
  }
  /** Keep the admin token fresh in the background so that a revocation call never has to log in first. */
  keepAlive() { this._ka = setInterval(() => this.adminToken(true).catch(() => {}), 30000); this._ka.unref(); }

  /** (Re)creates the realm with one confidential client (token mappers for class / trust / pkh) and one user per device. */
  async setupRealm(devices, { trustOf = () => 70 } = {}) {
    await this.waitReady();
    const del = await this.admin("DELETE", "/" + REALM);
    if (![204, 404].includes(del.status)) throw new Error("realm delete failed " + del.status + " " + del.text.slice(0, 200));
    let r = await this.admin("POST", "", { realm: REALM, enabled: true, sslRequired: "none", accessTokenLifespan: 14400, ssoSessionIdleTimeout: 28800, ssoSessionMaxLifespan: 28800, registrationAllowed: false, bruteForceProtected: false });
    if (r.status !== 201) throw new Error("realm create failed " + r.status + " " + r.text.slice(0, 300));
    // allow custom user attributes (Keycloak >= 24 uses a declarative user profile)
    r = await this.admin("GET", `/${REALM}/users/profile`);
    if (r.status !== 200) throw new Error("user profile read failed " + r.status);
    const prof = r.json; prof.unmanagedAttributePolicy = "ENABLED";
    r = await this.admin("PUT", `/${REALM}/users/profile`, prof);
    if (r.status !== 200) throw new Error("user profile update failed " + r.status + " " + r.text.slice(0, 300));
    const mapper = (name, type) => ({ name, protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper",
      config: { "user.attribute": name, "claim.name": name, "jsonType.label": type, "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true", "userinfo.token.claim": "false" } });
    r = await this.admin("POST", `/${REALM}/clients`, { clientId: CLIENT, secret: SECRET, enabled: true, publicClient: false, clientAuthenticatorType: "client-secret", directAccessGrantsEnabled: true,
      standardFlowEnabled: false, serviceAccountsEnabled: false, protocolMappers: [mapper("device_class", "int"), mapper("trust", "int"), mapper("pkh", "String")] });
    if (r.status !== 201) throw new Error("client create failed " + r.status + " " + r.text.slice(0, 300));
    const users = devices.map((d, i) => ({ username: d.did, enabled: true, emailVerified: true, firstName: "device", lastName: String(i), email: `d${i}@bczta.local`,
      attributes: { device_class: [String(d.cls)], trust: [String(trustOf(d))], pkh: [d.pkh] }, credentials: [{ type: "password", value: PASS, temporary: false }] }));
    for (let i = 0; i < users.length; i += 100) {
      r = await this.admin("POST", `/${REALM}/partialImport`, { ifResourceExists: "FAIL", users: users.slice(i, i + 100) });
      if (r.status !== 200) throw new Error("user import failed " + r.status + " " + r.text.slice(0, 300));
    }
    await this.loadIds(devices.length);
    if (this.ids.size < devices.length) throw new Error(`only ${this.ids.size}/${devices.length} users were created`);
  }
  async loadIds(n) {
    this.ids = new Map();
    for (let first = 0; first < n + 100; first += 200) {
      const r = await this.admin("GET", `/${REALM}/users?first=${first}&max=200&briefRepresentation=true`);
      if (r.status !== 200) throw new Error("user list failed " + r.status);
      for (const u of r.json) this.ids.set(u.username, u.id);
      if (r.json.length < 200) break;
    }
  }
  /** Obtains one access token per device (resource-owner password grant). */
  async issueTokens(devices, concurrency = 10) {
    let next = 0, failed = 0;
    const worker = async () => {
      while (next < devices.length) {
        const d = devices[next++];
        const r = await request(this.base, "POST", `/realms/${REALM}/protocol/openid-connect/token`, { form: { grant_type: "password", client_id: CLIENT, client_secret: SECRET, username: d.did, password: PASS } });
        if (r.status === 200) d.token = r.json.access_token; else { failed++; if (failed < 3) console.error("token request failed", r.status, r.text.slice(0, 200)); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failed) throw new Error(failed + " token requests failed");
  }
  /** Revocation: the administrator disables the account. Resolves when Keycloak has acknowledged the change. */
  async revoke(did) {
    const id = this.ids.get(did); if (!id) throw new Error("unknown keycloak user " + did);
    const r = await this.admin("PUT", `/${REALM}/users/${id}`, { enabled: false });
    if (r.status !== 204) throw new Error("disable failed " + r.status + " " + r.text.slice(0, 200));
  }
}
/** Token introspection (RFC 7662) as performed by the PEP for every request; returns the parsed JSON ({active, device_class, trust, pkh, ...}). */
const introAuth = "Basic " + Buffer.from(CLIENT + ":" + SECRET).toString("base64");
async function introspect(base, token, timeout = 5000) {
  const r = await request(base, "POST", `/realms/${REALM}/protocol/openid-connect/token/introspect`, { headers: { authorization: introAuth }, form: { token }, timeout });
  if (r.status !== 200 || !r.json) throw new Error("introspect http " + r.status);
  return r.json;
}
module.exports = { Keycloak, REALM, CLIENT, SECRET, request, introspect };
