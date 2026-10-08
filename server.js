"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const WRITE_KEY = process.env.WRITE_KEY || "", READ_KEY = process.env.READ_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "items.json"), PUB = path.join(__dirname, "public");
const OPEN = process.env.OPEN_ACCESS === "1"; // 1 = kein Zugangscode nötig
if (!OPEN && (!WRITE_KEY || !READ_KEY)) { console.error("WRITE_KEY und READ_KEY müssen gesetzt sein."); process.exit(1); }

/* ---------- Speicher (JSON-Datei) ---------- */
let db = { rev: 0, items: {} };
fs.mkdirSync(DATA_DIR, { recursive: true });
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
let timer = null;
function save() {
  db.rev++;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(db), err => err ? console.error(err) : fs.rename(tmp, FILE, e => e && console.error(e)));
  }, 300);
}
process.on("SIGTERM", () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

/* ---------- Zugang ---------- */
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const role = req => { if (OPEN) return "write"; const k = req.headers["x-api-key"] || ""; return eq(k, WRITE_KEY) ? "write" : eq(k, READ_KEY) ? "read" : null; };

/* ---------- Prüfung ---------- */
const NUMS = ["min", "max", "on", "buy", "sold", "sp", "ship", "g"], STAT = ["Offen", "Online", "Verkauft"];
const isNum = v => v === null || (typeof v === "number" && isFinite(v));
function clean(code, b) {
  if (!/^LC-\d{1,6}$/.test(code) || !b || b.code !== code || !STAT.includes(b.status)) return null;
  const o = { code, status: b.status, desc: typeof b.desc === "boolean" ? b.desc : null, inr: typeof b.inr === "boolean" ? b.inr : null, text: String(b.text || "").slice(0, 2000), updated: Date.now() };
  for (const k of NUMS) { const v = b[k] ?? null; if (!isNum(v)) return null; o[k] = v; }
  return o;
}

/* ---------- HTTP ---------- */
// Komfort-Link: ?k=CODE in der Adresse wird im Browser gespeichert, dann fragt die Seite nicht mehr nach dem Code
const inject = f => '<script>try{' + (OPEN
  ? 'localStorage.setItem("rs_key","open");localStorage.setItem("rs_read_key","open")'
  : 'var q=new URLSearchParams(location.search).get("k");if(q)localStorage.setItem("' + (f === "dashboard.html" ? "rs_read_key" : "rs_key") + '",q)') + '}catch(e){}</script>';
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
const readBody = req => new Promise((ok, no) => {
  let s = "";
  req.on("data", c => { s += c; if (s.length > 50000) { no(new Error("zu groß")); req.destroy(); } });
  req.on("end", () => ok(s)); req.on("error", no);
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  try {
    if (p === "/health") return send(res, 200, { ok: true });

    if (p.startsWith("/api/")) {
      const r = role(req);
      if (!r) return send(res, 401, { error: "Zugangscode falsch" });
      if (p === "/api/items" && req.method === "GET") {
        if (+u.searchParams.get("rev") === db.rev) return send(res, 200, { rev: db.rev, unchanged: true });
        return send(res, 200, { rev: db.rev, items: Object.values(db.items) });
      }
      const m = /^\/api\/items\/([^/]+)$/.exec(p);
      if (m) {
        if (r !== "write") return send(res, 403, { error: "Nur Lesezugriff" });
        const code = decodeURIComponent(m[1]);
        if (req.method === "PUT") {
          const o = clean(code, JSON.parse(await readBody(req)));
          if (!o) return send(res, 400, { error: "Ungültige Daten" });
          db.items[code] = o; save(); return send(res, 200, { ok: true });
        }
        if (req.method === "DELETE") { delete db.items[code]; save(); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: "Nicht gefunden" });
    }

    const file = p === "/" ? "portal.html" : p === "/dashboard" ? "dashboard.html" : p.slice(1);
    const fp = path.join(PUB, file);
    if (!fp.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Nicht gefunden"); }
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(path.extname(fp) === ".html" ? buf.toString("utf8").replace("<head>", "<head>" + inject(file)) : buf);
    });
  } catch (e) { send(res, 400, { error: "Anfrage fehlerhaft" }); }
}).listen(PORT, () => console.log("Server läuft auf Port " + PORT));
