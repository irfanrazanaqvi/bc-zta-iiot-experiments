// Tiny control agent for multi-host runs: lets the orchestrator (run_e2e.js on the controller VM) push the run
// config and start/stop pep.js / central.js on this VM.  POST /config, /start {file,env,ready}, /stop {file}; GET /health.
const http = require("http");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const CONFIG = process.env.CONFIG || path.join(__dirname, "agent_config.json");
const procs = new Map();      // key: id (or file)
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
const stopProc = (file) => new Promise((resolve) => {
  const p = procs.get(file); if (!p) return resolve();
  procs.delete(file);
  p.once("exit", resolve); p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 3000);
});
http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") return res.end("ok");
    const body = await readBody(req);
    if (req.url === "/config") { fs.writeFileSync(CONFIG, body); return res.end("{}"); }
    const b = JSON.parse(body || "{}");
    if (req.url === "/svc") {   // stop / start the central-IAM services installed on this VM (whitelisted commands only)
      const OVERRIDE = process.env.SVC_CMDS ? JSON.parse(process.env.SVC_CMDS) : null;    // tests only: run these commands instead of docker/systemctl
      const ipOk = typeof b.ip === "string" && /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b.ip);
      const CMDS = OVERRIDE || { besu: { stop: ["docker", "stop", "besu"], start: ["docker", "start", "besu"] },
        ledgercut: ipOk ? { stop: ["iptables", "-I", "OUTPUT", "1", "-p", "tcp", "-d", b.ip, "--dport", "8545", "-j", "DROP"], start: ["iptables", "-D", "OUTPUT", "-p", "tcp", "-d", b.ip, "--dport", "8545", "-j", "DROP"] } : {},
        kc: { stop: ["docker", "stop", "kc"], start: ["docker", "start", "kc"] }, ldap: { stop: ["systemctl", "stop", "slapd"], start: ["systemctl", "start", "slapd"] } };
      const c = CMDS[b.name] && CMDS[b.name][b.action];
      if (!c) { res.statusCode = 400; return res.end("{}"); }
      await new Promise((resolve, reject) => {
        const cb = (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve());
        if (OVERRIDE) execFile(c[0], c.slice(1), { timeout: 60000 }, cb); else execFile("sudo", c, { timeout: 60000 }, cb);
      });
      return res.end("{}");
    }
    if (req.url === "/stop") { await stopProc(b.id || b.file); return res.end("{}"); }
    if (req.url === "/start") {
      await stopProc(b.id || b.file);
      await new Promise((resolve, reject) => {
        const p = spawn("node", [path.join(__dirname, b.file)], { env: { ...process.env, CONFIG, ...b.env }, stdio: ["ignore", "pipe", "inherit"] });
        procs.set(b.id || b.file, p);
        let done = false;
        p.stdout.on("data", (d) => { if (!done && String(d).includes(b.ready)) { done = true; resolve(); } });
        p.on("exit", (c) => { if (!done) reject(new Error(b.file + " exited " + c)); });
        setTimeout(() => { if (!done) reject(new Error("start timeout")); }, 60000);
      });
      return res.end("{}");
    }
    res.statusCode = 404; res.end("{}");
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message) })); }
}).listen(Number(process.env.AGENT_PORT || 9500), () => console.log("agent ready"));
