// Emulated centralised PKI-IAM / directory server (baseline B1). One HTTP hop per lookup plus an emulated
// WAN round-trip (WAN_RTT_MS) and directory processing time (DIR_MS). In-memory store loaded from config.
const http = require("http");
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
const WAN = Number(process.env.WAN_RTT_MS || 40), DIR = Number(process.env.DIR_MS || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new Map(cfg.devices.map((d) => [d.did, { pkh: d.pkh, cls: d.cls, revoked: false, trust: d.name === "atk-lowtrust" ? 20 : 70 }]));
const srv = http.createServer((req, res) => {
  const ch = [];
  req.on("data", (c) => ch.push(c));
  req.on("end", async () => {
    const b = JSON.parse(Buffer.concat(ch).toString() || "{}");
    if (req.url === "/lookup") {
      await sleep(WAN + DIR); // WAN round trip + directory query
      res.end(JSON.stringify(db.get(b.did) || null));
    } else if (req.url === "/admin/revoke") {
      const r = db.get(b.did); if (r) r.revoked = true; res.end("{}");
    } else res.end("{}");
  });
});
srv.keepAliveTimeout = 60000;
srv.listen(Number(process.env.PORT || 9100), () => console.log("central ready"));
