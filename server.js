"use strict";
// Backend for the console + companion. Serves this folder and a small JSON API. Readings live in store.js: a JSON file by default, or Tiger Data (TimescaleDB) when DATABASE_URL is set.
//   POST /api/measurements   {patient, metric, value, t?, source?, quality?}  or  {patient, values:{metric:value}, source?, quality?, t?}
//   GET  /api/measurements   ?patient=&metric=&since=
//   GET  /api/summary        ?patient=      trends, region status (for the 3D body), motor score, streak/XP
//   POST /api/dictation      {text}         parse spoken results -> values (to confirm, nothing saved)
//   POST /api/summarize      {patient}      Gemini plain-language + neurologist bullets (template fallback without GEMINI_API_KEY)
//   POST /api/report-summary {findings}  Gemini summarises the report findings: mode "brief" = 3-sentence summary, mode "report" = narrative sections of the full report (source:"template" when no key or on failure; the page then uses its own text)
//   POST /api/extract-labs   {mime, data(base64)}  read an image/PDF results sheet with Gemini (confirm before saving)
//   GET  /api/eleven-session                signed URL for the ElevenLabs agent (needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID)
//   GET  /api/eleven-session ?agent=chat&patient=CODE   signed URL for the patient check-in chat agent (needs ELEVENLABS_CHAT_AGENT_ID) + the doctor's questions as dynamic variables
//   GET  /api/patient/status ?patient=CODE   is this code new (phone shows onboarding first) + the doctor's chat questions
//   POST /api/patient/onboard {patient, answers{symptom keys}, months, matters, consent}   the phone onboarding: the server works out the triage tier; sudden onset = emergency flag
//   GET  /api/triage ?patient=CODE   the patient's self-reported symptom screens (care team; no sign-in, protect a shared site with ACCESS_TOKEN)
//   GET/POST /api/conversation-plan  ?patient= / {patient, questions[]}   the questions the doctor wants asked in that patient's check-in chat (care team)
//   GET  /api/series         ?patient=&metrics=a,b   weekly buckets per metric (from the continuous aggregate on Tiger Data)
//   GET  /api/engine                         storage statistics + live benchmark for the Data engine page
//   GET  /api/health
// Env: PORT (8780), HOST (127.0.0.1), DATABASE_URL (Tiger Cloud / Postgres), DATABASE_SSL (no-verify if the certificate check fails), DATA_FILE, GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_CHAT_AGENT_ID. Keys never reach the browser.
// Demo scope: de-identified/synthetic patient codes only, no authentication. Do not expose beyond localhost with real data.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path"), { URL } = require("url");
const Auth = require("./auth.js"), Triage = require("./triage.js");
const Measures = require("./measures.js"), Dictation = require("./dictation.js"), Convo = require("./convo.js");
const ROOT = __dirname, MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PRIVATE = new Set(["auth.js", "python", "patient_profiles.json", "server.js", "seed.js", "store.js", "package.json", "package-lock.json", "node_modules", "deploy", "elevenlabs", ".env", ".env.example", ".gitignore", "data_store"]);
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
// Report summary for the neurosurgeon: Gemini only summarises the findings the page already computed (values, reference placement, rule-outs, imaging captions). It never sees a name and is told not to add numbers or diagnose.
const reportCache = new Map();   // payload hash -> { t, out }; same data within 10 minutes returns the same text
const clip = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
function cleanFindings(f) {
  const arr = (a, n, fn) => (Array.isArray(a) ? a : []).slice(0, n).map(fn);
  return {
    case_code: clip(f.case_code, 32), fictional: f.fictional === true, counts: Object.fromEntries(Object.entries(f.counts && typeof f.counts === "object" ? f.counts : {}).slice(0, 12).map(([k, v]) => [clip(k, 30), Number(v) || 0])),
    markers: arr(f.markers, 30, m => ({ name: clip(m.name, 80), unit: clip(m.unit, 20), case_value: clip(m.case_value, 40), control_range: clip(m.control_range, 60), als_range: clip(m.als_range, 60), placement: clip(m.placement, 60) })),
    not_measured: arr(f.not_measured, 20, x => clip(x, 60)),
    rule_outs: arr(f.rule_outs, 10, r => ({ name: clip(r.name, 80), result: clip(r.result, 200) })),
    imaging: arr(f.imaging, 8, m => ({ study: clip(m.study, 120), finding: clip(m.finding, 400) }))
  };
}
async function reportSummary(findings, env, mode) {
  const head = "You help prepare a clinical report for a neurosurgeon reviewing a possible ALS case. Use ONLY the findings in the JSON below. Rules: formal third person, plain clinical prose, no diagnosis and no treatment advice, do not invent or round numbers, do not mention anything not in the data. If fictional is true, say it is a fictional case file. ";
  const ask = mode === "report"
    ? "Write the narrative sections of the report. Return JSON {\"abstract\": string (110 to 160 words: what was compared, which markers are in the ALS range, which are not measured, imaging, rule-outs, and that the comparison is descriptive and not diagnostic), \"results\": string (130 to 220 words: the marker findings with their numbers, hand asymmetry if right and left values are given, respiratory findings), \"imaging\": string (60 to 120 words summarising the imaging findings), \"rule_outs\": string (50 to 100 words: genetic panel, CSF and muscle biopsy status), \"limitations\": string (50 to 90 words)}."
    : "Write a very brief summary. Return JSON {\"summary\": string (at most 2 short sentences and 30 words in total, enough for two lines of text: the headline count of measured markers in the ALS range with the most notable marker, then one note on imaging or what is pending. Do not mention that the case is fictional)}.";
  const prompt = head + ask + "\nFINDINGS: " + JSON.stringify(findings);
  const KEYS = ["abstract", "results", "imaging", "rule_outs", "limitations"];
  const models = [env.GEMINI_MODEL || "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"].filter((m, i, a) => a.indexOf(m) === i); let last;
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", signal: AbortSignal.timeout(mode === "report" ? 45000 : 20000), headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }) });
      if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw new Error("Gemini " + r.status + (m ? ": " + m.slice(0, 140) : "")); }
      const j = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
      if (mode === "report") {
        if (KEYS.some(k => typeof j[k] !== "string" || j[k].trim().length < 30)) throw new Error("Gemini returned an unexpected shape");
        return { source: "gemini", sections: Object.fromEntries(KEYS.map(k => [k, clip(j[k], 1800)])) };
      }
      if (typeof j.summary !== "string" || j.summary.trim().length < 20) throw new Error("Gemini returned an unexpected shape");
      return { source: "gemini", summary: clip(j.summary, 500) };
    } catch (e) { last = e; console.error(`report-summary ${model} failed: ${e.message}`); }
  }
  throw last;
}
// Optional shared access key (ACCESS_TOKEN in .env). Open the site once with ?key=TOKEN; a cookie then lets you in. Use this whenever the server is reachable from outside this computer (e.g. a Cloudflare tunnel).
function authorised(req, res, u, token) {
  const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookie = (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(c => c[0] === "motor_access");
  if (cookie && eq(decodeURIComponent(cookie[1] || ""), token)) return true;
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  const grant = location => { res.writeHead(302, { "Set-Cookie": `motor_access=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`, Location: location, "Cache-Control": "no-store" }); res.end(); return false; };
  const key = u.searchParams.get("key");
  if (key && eq(key, token)) { u.searchParams.delete("key"); const rest = u.searchParams.toString(); return grant(u.pathname + (rest ? "?" + rest : "")); }       // /page?key=KEY
  const m = /^\/k\/([^/]+)\/?$/.exec(u.pathname);                                                                                                          // /k/KEY: short link with no query string, which survives apps that strip "?..."
  if (m && eq(decodeURIComponent(m[1]), token)) return grant("/session.html");
  const wantsPage = !u.pathname.startsWith("/api/") && String(req.headers.accept || "").includes("text/html");
  if (wantsPage) {   // a small sign-in page so the key can simply be typed or pasted
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    const card = (title, hint, action, ph, btn) => `<form method="get" action="${action}" style="background:#fff;padding:22px;border-radius:20px;box-shadow:0 8px 30px rgba(0,0,0,.15)"><h2 style="margin:0 0 6px;font-size:20px">${title}</h2><p style="margin:0 0 12px;color:#555;font-size:14px">${hint}</p><input name="key" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${ph}" style="width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:12px"><button style="margin-top:12px;width:100%;padding:12px;font-size:16px;border:0;border-radius:99px;background:#16191a;color:#fff">${btn}</button></form>`;
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NeuroMotion</title><body style="font:16px system-ui;background:#c9d3c6;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center"><div style="display:grid;gap:16px;width:min(380px,92vw);padding:16px 0"><h1 style="margin:0;text-align:center;font-size:24px">NeuroMotion</h1>` + card("Healthcare provider login", "Enter your access code to continue.", u.pathname.replace(/[^\w\/.\-]/g, ""), "access code", "Log in") + card("Patient login", "Welcome. Enter the code you were given.", "/session.html", "your code", "Continue") + `</div>`);
    return false;
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
  // ---- No doctor accounts: BioHacks itself is the care team. Triage records, question lists and the audit log are attributed to it. Protect a shared site with ACCESS_TOKEN (below), not sign-in.
  const dataDir = opts.dataDir || path.dirname(env.DATA_FILE || path.join(ROOT, "data_store", "measurements.json"));
  const clinicians = Auth.makeClinicianStore(dataDir), CARE_TEAM = { email: "care-team@biohacks", name: "BioHacks care team" };
  const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } };
  const codeOk = c => /^[A-Za-z0-9_-]{2,32}$/.test(c) && !/^\d{6,}$/.test(c);
  // The doctor's questions for each patient's check-in chat: { CODE: { questions[], updatedAt, by } } in data_store/conversation_plans.json.
  const plansFile = path.join(dataDir, "conversation_plans.json");
  const readMap = file => { const out = Object.create(null); try { const o = JSON.parse(fs.readFileSync(file, "utf8")); if (o && typeof o === "object") Object.assign(out, o); } catch (e) { /* none saved yet */ } return out; };   // null-prototype map: a code such as "__proto__" is just a key
  const writeMap = (file, o) => { fs.mkdirSync(dataDir, { recursive: true }); const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 1)); fs.renameSync(tmp, file); };
  const readPlans = () => readMap(plansFile), writePlans = o => writeMap(plansFile, o);
  // What each patient told us in their first-time onboarding on the phone: { CODE: { matters[], consent, at } } in data_store/patient_onboarding.json (consent is required to save one).
  // Their symptom answers go to the triage record (data_store/triage.json), where the server works out the tier.
  const onboardFile = path.join(dataDir, "patient_onboarding.json");
  const planFor = code => { const p = readPlans()[code]; return p && Array.isArray(p.questions) && p.questions.length ? { questions: p.questions, isDefault: false } : { questions: Convo.DEFAULT_QUESTIONS.slice(), isDefault: true }; };
  async function api(req, res, u) {
    const p = u.pathname, q = u.searchParams;
    if (p === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, records: await store.count(), store: store.kind, gemini: !!env.GEMINI_API_KEY, elevenlabs: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID), elevenlabsChat: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_CHAT_AGENT_ID) });
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
    if (p === "/api/report-summary" && req.method === "POST") {
      const b = await body(req, 60e3);
      if (!env.GEMINI_API_KEY) return json(res, 200, { source: "template", note: "GEMINI_API_KEY not set" });
      if (!b.findings || typeof b.findings !== "object" || !Array.isArray(b.findings.markers) || !b.findings.markers.length) return json(res, 400, { error: "findings with at least one marker are required" });
      const mode = b.mode === "report" ? "report" : "brief", f = cleanFindings(b.findings), key = mode + crypto.createHash("sha256").update(JSON.stringify(f)).digest("hex"), c = reportCache.get(key);
      if (c && Date.now() - c.t < 6e5) return json(res, 200, c.out);
      try { const out = await reportSummary(f, env, mode); reportCache.set(key, { t: Date.now(), out }); return json(res, 200, out); }
      catch (e) { console.error("report-summary failed:", e.message); return json(res, 200, { source: "template", note: "Gemini failed" }); }
    }
    if (p === "/api/dictation" && req.method === "POST") { const b = await body(req); return json(res, 200, Dictation.parse(b.text)); }
    if (p === "/api/summarize" && req.method === "POST") {
      const b = await body(req); if (!b.patient) return json(res, 400, { error: "patient is required" });
      const s = Measures.summary(await store.forPatient(b.patient), b.patient); if (!Object.keys(s.metrics).length) return json(res, 404, { error: "no measurements for this patient" });
      if (env.GEMINI_API_KEY) { try { return json(res, 200, { ...(await geminiWithFallback(s, env)), motorScore: s.motorScore }); } catch (e) { console.error("gemini failed:", e.message); } }
      return json(res, 200, { ...templateSummary(s), motorScore: s.motorScore, note: env.GEMINI_API_KEY ? "Gemini failed; template used" : "GEMINI_API_KEY not set; template used" });
    }
    if (p === "/api/eleven-session" && req.method === "GET" && q.get("agent") === "chat") {   // patient check-in chat: open like the rest of the patient page, keyed by the de-identified code
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_CHAT_AGENT_ID) return json(res, 503, { error: "ELEVENLABS_API_KEY and ELEVENLABS_CHAT_AGENT_ID are not set" });
      const code = String(q.get("patient") || ""); if (!codeOk(code)) return json(res, 400, { error: "patient code is required" });
      const plan = planFor(code);
      const r = await fetch("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + encodeURIComponent(env.ELEVENLABS_CHAT_AGENT_ID), { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
      if (!r.ok) return json(res, 502, { error: "ElevenLabs " + r.status });
      return json(res, 200, { signedUrl: (await r.json()).signed_url, dynamicVariables: { questions: Convo.numbered(plan.questions), question_count: String(plan.questions.length), interests: Convo.interestsText((readMap(onboardFile)[code] || {}).matters) }, questions: plan.questions });
    }
    if (p === "/api/patient/status" && req.method === "GET") {   // patient page: is this code new (show onboarding first), and what will the chat ask about
      const code = String(q.get("patient") || ""); if (!codeOk(code)) return json(res, 400, { error: "patient code is required" });
      const onboarded = !!readMap(onboardFile)[code], known = onboarded || await store.hasPatient(code);
      return json(res, 200, { known, onboarded, questions: planFor(code).questions });
    }
    if (p === "/api/patient/onboard" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "cross-site request refused" });
      const b = await body(req, 20e3), code = String(b.patient || "").trim(); if (!codeOk(code)) return json(res, 400, { error: "patient code is required" });
      const src = b.answers && typeof b.answers === "object" && !Array.isArray(b.answers) ? b.answers : {}, ans = {};
      for (const k of [...Triage.SYMPTOMS, ...Triage.PATTERN, ...Triage.RED_FLAGS, ...Triage.RISKS].map(x => x.key).concat("sudden")) ans[k] = src[k] === true;
      const mo = Number(b.months); ans.months = b.months != null && b.months !== "" && isFinite(mo) && mo >= 0 && mo <= 600 ? mo : null;
      const result = Triage.evaluate(ans);          // the server decides the tier; whatever the phone computed is ignored
      if (result.emergency) {                       // sudden, stroke-like onset: record it for the care team and tell the phone to show the emergency advice. No consent needed to flag a safety problem.
        clinicians.addTriage({ patient: code, t: Date.now(), clinician: "patient self-report", source: "patient", answers: ans, emergency: true, tier: null });
        clinicians.audit("patient_emergency_flag", CARE_TEAM, { patient: code }); return json(res, 201, { saved: true, emergency: true });
      }
      const c = Convo.cleanOnboarding(b); if (!c.ok) return json(res, 400, { error: c.error });
      clinicians.addTriage({ patient: code, t: Date.now(), clinician: "patient self-report", source: "patient", answers: ans, emergency: false, tier: result.tier });
      const all = readMap(onboardFile); all[code] = { ...c.value, at: Date.now() }; writeMap(onboardFile, all);
      clinicians.audit("patient_onboarded", CARE_TEAM, { patient: code, tier: result.tier });
      return json(res, 201, { saved: true, emergency: false });      // the tier is for the care team: it is not sent back to the patient's phone
    }
    if (p === "/api/eleven-session" && req.method === "GET") {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) return json(res, 503, { error: "ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are not set" });
      const r = await fetch("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + encodeURIComponent(env.ELEVENLABS_AGENT_ID), { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
      if (!r.ok) return json(res, 502, { error: "ElevenLabs " + r.status }); return json(res, 200, { signedUrl: (await r.json()).signed_url });
    }
    if (p === "/api/triage" || p === "/api/conversation-plan") {   // care-team side: no sign-in (BioHacks is the care team); a shared site is protected by ACCESS_TOKEN
      if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { error: "cross-site request refused" });
      if (p === "/api/conversation-plan" && req.method === "GET") {
        const code = String(q.get("patient") || ""); if (!codeOk(code)) return json(res, 400, { error: "patient is required" });
        return json(res, 200, planFor(code));
      }
      if (p === "/api/conversation-plan" && req.method === "POST") {
        const b = await body(req), code = String(b.patient || "").trim(); if (!codeOk(code)) return json(res, 400, { error: "patient must be a 2-32 character de-identified code (no names or MRNs)" });
        if (b.questions != null && !Array.isArray(b.questions)) return json(res, 400, { error: "questions must be a list" });
        const { questions, dropped } = Convo.cleanQuestions(b.questions || []), plans = readPlans();
        if (!questions.length) delete plans[code]; else plans[code] = { questions, updatedAt: Date.now(), by: CARE_TEAM.email };   // an empty list goes back to the suggested questions
        writePlans(plans); clinicians.audit("conversation_plan_saved", CARE_TEAM, { patient: code, count: questions.length });
        return json(res, 200, { ...planFor(code), saved: true, dropped });
      }
      if (p === "/api/triage" && req.method === "GET") {
        const code = String(q.get("patient") || ""); if (!codeOk(code)) return json(res, 400, { error: "patient is required" });
        clinicians.audit("triage_viewed", CARE_TEAM, { patient: code }); return json(res, 200, clinicians.triageFor(code));
      }
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
