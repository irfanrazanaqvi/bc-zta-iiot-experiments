// Tiny control agent for multi-host runs: lets the orchestrator (run_e2e.js on the controller VM) push the run
// config and start/stop pep.js / central.js on this VM.  POST /config, /start {file,env,ready}, /stop {file}; GET /health.
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const CONFIG = process.env.CONFIG || path.join(__dirname, "agent_config.json");
const procs = new Map();
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
    if (req.url === "/stop") { await stopProc(b.file); return res.end("{}"); }
    if (req.url === "/start") {
      await stopProc(b.file);
      await new Promise((resolve, reject) => {
        const p = spawn("node", [path.join(__dirname, b.file)], { env: { ...process.env, CONFIG, ...b.env }, stdio: ["ignore", "pipe", "inherit"] });
        procs.set(b.file, p);
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
