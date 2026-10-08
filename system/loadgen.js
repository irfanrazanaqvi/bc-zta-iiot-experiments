// Open-loop load generator: N devices each send one signed access request per second (staggered phases).
// Requests are signed before the timed window so the generator's own CPU is not the bottleneck.
const http = require("http");
const { h, now, sleep, stats, ethers } = require("./lib");

const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });
const HOST = process.env.PEP_HOST || "127.0.0.1";
function post(port, path, body, timeoutMs = 30000, host = HOST) {
  return new Promise((resolve) => {
    const t0 = now();
    const rq = http.request({ host, port, path, method: "POST", agent, headers: { "content-type": "application/json" }, timeout: timeoutMs }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString()); } catch (e) {} resolve({ ms: now() - t0, out: j }); });
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ ms: now() - t0, out: null, timeout: true }); });
    rq.on("error", () => resolve({ ms: now() - t0, out: null, error: true }));
    rq.end(JSON.stringify(body));
  });
}
let nonceCtr = 0;
async function makeReq(dev, resource, ts, opts = {}) {
  const nonce = opts.nonce ?? `${Date.now().toString(36)}-${++nonceCtr}`;
  const msg = `${dev.did}|${resource}|${ts}|${nonce}`;
  const signer = opts.signer || dev.wallet;
  const sig = await signer.signMessage(msg);
  return { did: dev.did, res: resource, ts, nonce, sig, proof: opts.proof ?? dev.proof, cls: dev.cls };
}

async function runLoad({ port, devices, resource, durationS, warmupS, timeoutMs = 30000 }) {
  const N = devices.length, total = warmupS + durationS;
  const plan = [];
  // calibrate signing speed, then schedule the window after pre-signing is expected to finish (+50% margin)
  const cal0 = now();
  for (let j = 0; j < 40; j++) await devices[0].wallet.signMessage("calibration-" + j);
  const perSig = (now() - cal0) / 40;
  const t0w = Date.now() + 2000 + Math.ceil(1.5 * perSig * N * total);
  // signing
  for (let i = 0; i < N; i++) {
    const phase = (i / N) * 1000;
    for (let k = 0; k < total; k++) plan.push({ i, k, at: t0w + phase + k * 1000, req: null });
  }
  for (let j = 0; j < plan.length; j += 64) await Promise.all(plan.slice(j, j + 64).map(async (p) => { p.req = await makeReq(devices[p.i], resource, p.at); }));
  if (Date.now() > t0w - 500) console.warn("warning: pre-signing finished late; early requests may be stale");
  const lat = [], pending = [];
  let ok = 0, denied = 0, fail = 0, measured = 0;
  const reasons = {};
  let tWarmEnd = null, statsAtWarm = null;
  plan.sort((a, b) => a.at - b.at);
  for (const p of plan) {
    const w = p.at - Date.now();
    if (w > 1) await sleep(w);
    pending.push(post(port, "/access", p.req, timeoutMs).then((r) => {
      if (p.k < warmupS) return;
      measured++;
      if (r.timeout || r.error || !r.out) { fail++; return; }
      lat.push(r.ms);
      if (r.out.ok) ok++; else { denied++; reasons[r.out.reason] = (reasons[r.out.reason] || 0) + 1; }
    }));
  }
  await Promise.all(pending);
  const span = durationS;
  return { devices: N, duration_s: durationS, offered_rps: N, measured, ok, denied, failed_or_timeout: fail, reasons, goodput_rps: ok / span, ...stats(lat) };
}
async function getStats(port) { return (await post(port, "/stats", {})).out; }
module.exports = { post, makeReq, runLoad, getStats };
