"use strict";
// Backend for the console + companion. Serves this folder and a small JSON API. Readings live in store.js: a JSON file by default, or Tiger Data (TimescaleDB) when DATABASE_URL is set.
//   POST /api/measurements   {patient, metric, value, t?, source?, quality?}  or  {patient, values:{metric:value}, source?, quality?, t?}
//   GET  /api/measurements   ?patient=&metric=&since=
//   GET  /api/summary        ?patient=      trends, region status (for the 3D body), motor score, streak/XP
//   POST /api/dictation      {text}         parse spoken results -> values (to confirm, nothing saved)
//   POST /api/summarize      {patient}      Gemini plain-language + neurologist bullets (template fallback without GEMINI_API_KEY)
//   POST /api/extract-labs   {mime, data(base64)}  read an image/PDF results sheet with Gemini (confirm before saving)
//   GET  /api/eleven-session                signed URL for the ElevenLabs agent (needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID)
//   GET  /api/series         ?patient=&metrics=a,b   weekly buckets per metric (from the continuous aggregate on Tiger Data)
//   GET  /api/engine                         storage statistics + live benchmark for the Data engine page
//   GET  /api/health
// Env: PORT (8780), HOST (127.0.0.1), DATABASE_URL (Tiger Cloud / Postgres), DATABASE_SSL (no-verify if the certificate check fails), DATA_FILE, GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID. Keys never reach the browser.
// Demo scope: de-identified/synthetic patient codes only, no authentication. Do not expose beyond localhost with real data.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path"), { URL } = require("url");
const Measures = require("./measures.js"), Dictation = require("./dictation.js");
const ROOT = __dirname, MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PRIVATE = new Set(["server.js", "seed.js", "store.js", "package.json", "package-lock.json", "node_modules", ".env", ".env.example", ".gitignore", "data_store"]);
// Load KEY=value lines from clinician_labs/.env into process.env (real environment variables win). The file is git-ignored and never served.
function loadEnvFile(file) {
  try { for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2"); } }
  catch (e) { /* no .env file: fine */ }
}
if (require.main === module) loadEnvFile(path.join(ROOT, ".env"));

const { createJsonStore, makeStore } = require("./store.js");
const createStore = createJsonStore;   // kept for older callers
const templateSummary = s => {
  const m = s.metrics, f = id => m[id], bits = [], bullets = [];
  const dec = Object.entries(m).filter(([id, x]) => x.status === "bad").map(([id, x]) => `${Measures.METRICS[id].label} at ${Math.round(x.pctOfBaseline)}% of baseline`);
  const watch = Object.entries(m).filter(([, x]) => x.status === "warn").map(([id]) => Measures.METRICS[id].label);
  if (dec.length) { bits.push("Some measures have dropped from where you started: " + dec.slice(0, 3).join("; ") + "."); bullets.push("Declining: " + dec.join("; ")); }
  if (watch.length) { bits.push("Worth watching: " + watch.slice(0, 3).join(", ") + "."); bullets.push("Watch: " + watch.join(", ")); }
  for (const a of s.asymmetry) if (a.ratio < .8 || a.ratio > 1.25) bullets.push(`${a.name} asymmetry: right/left ${a.ratio.toFixed(2)}`);
  if (!bits.length) bits.push(Object.keys(m).length ? "Your measures are steady compared with your own baseline." : "No measurements yet.");
  return { source: "template", patient_summary: bits.join(" ") + " This is not a diagnosis; your neurologist will interpret it.", neurologist_bullets: bullets.length ? bullets : ["No declining or watch-level measures."] };
};
async function geminiSummary(s, env, model) {
  const compact = { motor_score: s.motorScore, asymmetry: s.asymmetry, measures: Object.fromEntries(Object.entries(s.metrics).map(([id, x]) => [Measures.METRICS[id].label + " (" + Measures.METRICS[id].unit + ")", { latest: +x.latest.toFixed(2), baseline: +x.baseline.toFixed(2), pct_of_baseline: Math.round(x.pctOfBaseline), slope_pct_per_week: x.slopePctPerWeek == null ? null : +x.slopePctPerWeek.toFixed(1), status: x.status, n: x.n }])) };
  const prompt = "You summarise ALS motor monitoring data for a clinic demo. Rules: plain language, no diagnosis, no treatment advice, do not invent numbers, mention only what is in the data. Return JSON {\"patient_summary\": string (max 70 words, kind and non-clinical, speaks to the patient as 'you'), \"neurologist_bullets\": string[] (max 6, terse, with numbers)}.\nDATA: " + JSON.stringify(compact);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", signal: AbortSignal.timeout(12000), headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }) });
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw new Error("Gemini " + r.status + (m ? ": " + m.slice(0, 160) : "")); }
  const j = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
  if (typeof j.patient_summary !== "string" || !Array.isArray(j.neurologist_bullets)) throw new Error("Gemini returned an unexpected shape");
  return { source: "gemini", patient_summary: j.patient_summary.slice(0, 600), neurologist_bullets: j.neurologist_bullets.slice(0, 6).map(x => String(x).slice(0, 240)) };
}
// Optional shared access key (ACCESS_TOKEN in .env). Open the site once with ?key=TOKEN; a cookie then lets you in. Use this whenever the server is reachable from outside this computer (e.g. a Cloudflare tunnel).
function authorised(req, res, u, token) {
  const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookie = (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(c => c[0] === "motor_access");
  if (cookie && eq(decodeURIComponent(cookie[1] || ""), token)) return true;
  const key = u.searchParams.get("key");
  if (key && eq(key, token)) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    u.searchParams.delete("key"); const rest = u.searchParams.toString();
    res.writeHead(302, { "Set-Cookie": `motor_access=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`, Location: u.pathname + (rest ? "?" + rest : ""), "Cache-Control": "no-store" }); res.end(); return false;
  }
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("Access key required. Open this site with ?key=YOUR_KEY once."); return false;
}
function createApp(opts = {}) {
  const env = opts.env || process.env, store = opts.store || (opts.dataFile !== undefined ? createJsonStore(opts.dataFile) : makeStore(env, ROOT));
  const ready = (async () => {
    if (!opts.store) await store.init();                               // a store passed in is already initialised by the caller
    if (env.SEED_DEMO !== "0" && !(await store.hasPatient("ALEX-CASE"))) { await store.add(require("./seed.js").alexRecords()); console.log("Seeded demo data for ALEX-CASE (set SEED_DEMO=0 to disable)."); }
  })();
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(b); };
  const body = (req, limit = 100e3) => new Promise((ok, no) => { let n = 0, c = [], over = false; req.on("data", d => { n += d.length; if (over) return; if (n > limit) { over = true; c = []; no(Object.assign(new Error("body too large"), { status: 413 })); } else c.push(d); }); req.on("end", () => { if (over) return; try { ok(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); } catch (e) { no(Object.assign(new Error("invalid JSON"), { status: 400 })); } }); req.on("error", no); });
  async function api(req, res, u) {
    const p = u.pathname, q = u.searchParams;
    if (p === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, records: await store.count(), store: store.kind, gemini: !!env.GEMINI_API_KEY, elevenlabs: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID) });
    if (p === "/api/measurements" && req.method === "POST") {
      const b = await body(req), t = b.t == null ? Date.now() : typeof b.t === "string" ? Date.parse(b.t) : Number(b.t);
      if (b.values && typeof b.values === "object") {
        const { recs, errors } = Measures.fromSession(b.patient, b.values, { source: b.source, quality: b.quality, t: isFinite(t) ? t : undefined, session: b.session });
        if (!recs.length) return json(res, 400, { error: errors.join("; ") || "no values" });
        await store.add(recs); return json(res, 201, { saved: recs.length, rejected: errors });
      }
      const v = Measures.validate(b); if (!v.ok) return json(res, 400, { error: v.error });
      await store.add([v.rec]); return json(res, 201, { saved: 1, rejected: [] });
    }
    if (p === "/api/measurements" && req.method === "GET") {
      const pt = q.get("patient"), m = q.get("metric"), since = Number(q.get("since") || 0);
      if (!pt) return json(res, 400, { error: "patient is required" });
      return json(res, 200, await store.query({ patient: pt, metric: m || undefined, since }));
    }
    if (p === "/api/summary" && req.method === "GET") { const pt = q.get("patient"); if (!pt) return json(res, 400, { error: "patient is required" }); return json(res, 200, Measures.summary(await store.forPatient(pt), pt)); }
    if (p === "/api/series" && req.method === "GET") {
      const pt = q.get("patient"), ms = String(q.get("metrics") || "").split(",").map(x => x.trim()).filter(Boolean);
      if (!pt) return json(res, 400, { error: "patient is required" });
      if (!ms.length || ms.length > 12 || ms.some(m => !Measures.METRICS[m])) return json(res, 400, { error: "metrics must be 1 to 12 known metric ids" });
      const t0 = Date.now(), series = await store.weekly(pt, ms); return json(res, 200, { series, source: store.kind, ms: Date.now() - t0 });
    }
    if (p === "/api/engine" && req.method === "GET") return json(res, 200, await store.engine());
    if (p === "/api/extract-labs" && req.method === "POST") {
      if (!env.GEMINI_API_KEY) return json(res, 503, { error: "Reading images and PDFs needs GEMINI_API_KEY in .env. CSV, JSON and text files work without it." });
      const b = await body(req, 8e6), mime = String(b.mime || ""), data = String(b.data || "");
      if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(mime)) return json(res, 400, { error: "Unsupported file type: " + mime });
      if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 100) return json(res, 400, { error: "File data is missing or not base64" });
      if (data.length > 6e6) return json(res, 413, { error: "File is too large (4 MB max)" });
      try { return json(res, 200, await extractLabs(mime, data, env)); } catch (e) { console.error("extract-labs failed:", e.message); return json(res, 502, { error: "Could not read that document: " + e.message }); }
    }
    if (p === "/api/dictation" && req.method === "POST") { const b = await body(req); return json(res, 200, Dictation.parse(b.text)); }
    if (p === "/api/summarize" && req.method === "POST") {
      const b = await body(req); if (!b.patient) return json(res, 400, { error: "patient is required" });
      const s = Measures.summary(await store.forPatient(b.patient), b.patient); if (!Object.keys(s.metrics).length) return json(res, 404, { error: "no measurements for this patient" });
      if (env.GEMINI_API_KEY) { try { return json(res, 200, { ...(await geminiWithFallback(s, env)), motorScore: s.motorScore }); } catch (e) { console.error("gemini failed:", e.message); } }
      return json(res, 200, { ...templateSummary(s), motorScore: s.motorScore, note: env.GEMINI_API_KEY ? "Gemini failed; template used" : "GEMINI_API_KEY not set; template used" });
    }
    if (p === "/api/eleven-session" && req.method === "GET") {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) return json(res, 503, { error: "ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are not set" });
      const r = await fetch("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + encodeURIComponent(env.ELEVENLABS_AGENT_ID), { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
      if (!r.ok) return json(res, 502, { error: "ElevenLabs " + r.status }); return json(res, 200, { signedUrl: (await r.json()).signed_url });
    }
    return json(res, 404, { error: "not found" });
  }
  function serveStatic(req, res, u) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    let rel; try { rel = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(ROOT, rel)), top = path.relative(ROOT, file).split(path.sep)[0];
    if (!file.startsWith(ROOT + path.sep) || PRIVATE.has(top) || top.startsWith(".")) { res.writeHead(404); return res.end("not found"); }
    fs.readFile(file, (err, d) => { if (err) { res.writeHead(404); return res.end("not found"); } res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(req.method === "HEAD" ? undefined : d); });
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (env.ACCESS_TOKEN && !authorised(req, res, u, env.ACCESS_TOKEN)) return;
    if (u.pathname.startsWith("/api/")) { try { await ready; await api(req, res, u); } catch (e) { json(res, e.status || 500, { error: e.status ? e.message : "server error" }); if (!e.status) console.error(e); } }
    else serveStatic(req, res, u);
  });
  server.store = store; server.ready = ready; return server;
}
if (require.main === module) {
  (async () => {
    const port = +process.env.PORT || 8780, host = process.env.HOST || "127.0.0.1", store = makeStore(process.env, ROOT);
    try {
      const caps = await store.init();
      if (store.kind === "tiger") console.log(`Tiger Data store ready (hypertable: ${caps.hypertable ? "yes" : "no"}, compression: ${caps.compression ? "yes" : "no"}, continuous aggregate: ${caps.cagg ? "yes" : "no"})`);
    } catch (e) { console.error("Could not start the database store: " + e.message + "\nCheck DATABASE_URL in .env. If the error mentions a certificate, add DATABASE_SSL=no-verify."); process.exit(1); }
    const app = createApp({ store }); await app.ready;
    app.listen(port, host, () => console.log(`Motor console + API on http://${host}:${port}`));
  })();
}
// Reads measurement values out of a photo/PDF of a results sheet. Returns only metrics we know, each checked against the same plausible ranges as manual entry.
async function extractLabs(mime, data, env) {
  const list = Object.entries(Measures.METRICS).map(([id, m]) => `${id}: ${m.label} (${m.unit})`).join("\n");
  const prompt = "Read this clinical results document and extract measurement values. Use ONLY these keys (key: meaning (unit)):\n" + list +
    "\nRules: include a key only if its value is clearly printed in the document; convert to the stated unit only if the conversion is exact; never guess or infer; ignore patient names and identifiers. Return JSON: {\"values\": {key: number}, \"unmatched\": [names of tests found but not in the list]}.";
  const models = [env.GEMINI_MODEL || "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"].filter((m, i, a) => a.indexOf(m) === i); let last;
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", signal: AbortSignal.timeout(40000), headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }) });
      if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw new Error(`Gemini ${r.status}${m ? ": " + m.slice(0, 140) : ""}`); }
      const j = JSON.parse((await r.json()).candidates[0].content.parts[0].text), values = {}, rejected = [];
      for (const [k, v] of Object.entries(j.values && typeof j.values === "object" ? j.values : {})) { const c = Measures.validate({ patient: "XX", metric: k, value: v }); c.ok ? (values[k] = c.rec.value) : rejected.push(`${k}: ${c.error}`); }
      return { source: "gemini", values, rejected, unmatched: (Array.isArray(j.unmatched) ? j.unmatched : []).slice(0, 20).map(x => String(x).slice(0, 80)) };
    } catch (e) { last = e; console.error(`extract ${model} failed: ${e.message}`); }
  }
  throw last;
}
// Try the configured model first, then a backup, so one overloaded model doesn't leave the card on template text.
async function geminiWithFallback(s, env) {
  const models = [env.GEMINI_MODEL || "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"].filter((m, i, a) => a.indexOf(m) === i); let last;
  for (const m of models) { try { return await geminiSummary(s, env, m); } catch (e) { last = e; console.error(`gemini ${m} failed: ${e.message}`); } }
  throw last;
}
module.exports = { createApp, createStore, templateSummary, loadEnvFile };
