"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const KEY = process.env.ACCESS_KEY || ""; // leer = offen, ohne Code
const GIST = process.env.GIST_ID || "", TOKEN = process.env.GITHUB_TOKEN || "", GH = process.env.GH_API || "https://api.github.com";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data"), FILE = path.join(DATA_DIR, "items.json");
const PUB = path.join(__dirname, "public");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Speicher: GitHub-Gist (ohne Gist nur eine Datei, geht bei Render-Neustart verloren) ---------- */
const db = { rev: Date.now(), items: {} };
const gh = (p, o = {}) => fetch(GH + p, Object.assign({}, o, { headers: { authorization: "Bearer " + TOKEN, accept: "application/vnd.github+json", "user-agent": "brotfund-server", "content-type": "application/json" } }));
let store;
if (GIST && TOKEN) {
  store = {
    load: async () => {
      const r = await gh("/gists/" + GIST);
      if (!r.ok) throw new Error("Gist lesen: HTTP " + r.status);
      const f = (await r.json()).files["daten.json"];
      let txt = f ? f.content : "{}";
      if (f && f.truncated) txt = await (await fetch(f.raw_url)).text();
      return JSON.parse(txt || "{}");
    },
    save: async data => {
      const r = await gh("/gists/" + GIST, { method: "PATCH", body: JSON.stringify({ files: { "daten.json": { content: JSON.stringify(data) } } }) });
      if (!r.ok) throw new Error("Gist speichern: HTTP " + r.status);
    }
  };
} else {
  console.warn("Kein GIST_ID/GITHUB_TOKEN gesetzt: Daten liegen nur in einer Datei.");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store = {
    load: async () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { return {}; } },
    save: async data => fs.writeFileSync(FILE, JSON.stringify(data))
  };
}
let dirty = false, saving = false, timer = null;
function persist() { db.rev++; dirty = true; clearTimeout(timer); timer = setTimeout(flush, 3000); }
async function flush() {
  if (saving) { timer = setTimeout(flush, 1000); return; }
  if (!dirty) return;
  saving = true; dirty = false;
  try { await store.save({ items: db.items }); }
  catch (e) { console.error(e.message); dirty = true; timer = setTimeout(flush, 30000); }
  saving = false;
}
process.on("SIGTERM", async () => {
  clearTimeout(timer);
  await Promise.race([(async () => { while (dirty || saving) { if (saving) await sleep(300); else await flush(); } })(), sleep(8000)]);
  process.exit(0);
});

/* ---------- Abgleich: pro Auftrag gewinnt der neuere Zeitstempel (ts) ---------- */
const STR = ["min", "max", "onDate", "onTime", "buy", "sDate", "sTime", "sPrice", "ship", "note"];
function clean(r) {
  if (!r || typeof r.code !== "string" || !/^LC-\d{6}$/.test(r.code) || !Number.isFinite(r.ts)) return null;
  const o = { code: r.code, ts: r.ts };
  if (r.del) { o.del = true; return o; }
  for (const k of STR) o[k] = typeof r[k] === "string" ? r[k].slice(0, 2000) : "";
  o.codeOk = !!r.codeOk; o.created = Number.isFinite(r.created) ? r.created : r.ts;
  return o;
}
function mergeIn(list) {
  let n = 0;
  for (const x of Array.isArray(list) ? list : []) {
    const r = clean(x), e = r && db.items[r.code];
    if (!r || (e && e.ts >= r.ts)) continue;
    db.items[r.code] = r; n++;
  }
  if (n) persist();
  return n;
}

/* ---------- HTTP ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let s = "";
  req.on("data", c => { s += c; if (s.length > 5e6) { no(new Error("zu groß")); req.destroy(); } });
  req.on("end", () => ok(s)); req.on("error", no);
});
const inject = '<script>try{var q=new URLSearchParams(location.search).get("k");if(q)localStorage.setItem("bf_key",q)}catch(e){}</script>';

const handler = async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  try {
    if (p === "/health") return send(res, 200, { ok: true });
    if (p.startsWith("/api/")) {
      if (KEY && !eq(req.headers["x-api-key"] || "", KEY)) return send(res, 401, { error: "Zugang fehlt" });
      if (p === "/api/sync" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)), n = mergeIn(b.items);
        if (!n && +b.rev === db.rev) return send(res, 200, { rev: db.rev, unchanged: true });
        return send(res, 200, { rev: db.rev, items: Object.values(db.items) });
      }
      if (p === "/api/items" && req.method === "GET") return send(res, 200, { rev: db.rev, items: Object.values(db.items) });
      return send(res, 404, { error: "Nicht gefunden" });
    }
    const page = ["/", "/dashboard", "/portal", "/portal.html", "/dashboard.html"].includes(p);
    const fp = path.join(PUB, page ? "index.html" : p.slice(1));
    if (!fp.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Nicht gefunden"); }
      const html = path.extname(fp) === ".html";
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "cache-control": html ? "no-cache" : "public, max-age=3600" });
      res.end(html && KEY ? buf.toString("utf8").replace("<head>", "<head>" + inject) : buf);
    });
  } catch (e) { console.error(e.message); send(res, e instanceof SyntaxError ? 400 : 500, { error: "Anfrage fehlerhaft" }); }
};

(async () => {
  db.items = (await store.load()).items || {};
  http.createServer(handler).listen(PORT, () => console.log("Server läuft auf Port " + PORT + ", " + Object.keys(db.items).length + " Einträge geladen"));
})().catch(e => { console.error("Start fehlgeschlagen:", e.message); process.exit(1); });
