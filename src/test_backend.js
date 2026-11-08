"use strict";
const M = require("../measures.js"), D = require("../ddk.js"), Dic = require("../dictation.js"), { createApp } = require("../server.js");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const DAY = 864e5, now = Date.now();

// ---- validation ----
ok(M.validate({ patient: "ALEX-CASE", metric: "grip_kg_r", value: 14 }).ok, "valid record");
ok(!M.validate({ patient: "A", metric: "grip_kg_r", value: 14 }).ok, "short code rejected");
ok(!M.validate({ patient: "12345678", metric: "grip_kg_r", value: 14 }).ok, "MRN-like code rejected");
ok(!M.validate({ patient: "ALEX-CASE", metric: "nope", value: 1 }).ok, "unknown metric rejected");
ok(!M.validate({ patient: "ALEX-CASE", metric: "grip_kg_r", value: 900 }).ok, "implausible value rejected");
ok(!M.validate({ patient: "ALEX-CASE", metric: "grip_kg_r", value: "abc" }).ok, "non-number rejected");
ok(!M.validate({ patient: "ALEX-CASE", metric: "grip_kg_r", value: null }).ok, "null rejected");
ok(!M.validate({ patient: "ALEX-CASE", metric: "grip_kg_r", value: 10, t: now + 5 * DAY }).ok, "future timestamp rejected");
const fs = M.fromSession("ALEX-CASE", { grip_kg_r: 14, ddk_rate: 99, ck: 470 }, { source: "clinic" });
ok(fs.recs.length === 2 && fs.errors.length === 1 && fs.recs[0].session === fs.recs[1].session, "session splits valid/invalid " + JSON.stringify(fs));

// ---- trends: right grip declines 24 -> 14 kg over 10 weeks, left stays ~33; speech slows; calm metric stays flat ----
const recs = [];
for (let d = 0; d < 70; d++) { const t = now - (70 - d) * DAY, f = d / 69, j = Math.sin(d * 7) * .4;
  for (const [metric, value] of [["grip_amp_r", 1.2 - .5 * f + .02 * j], ["grip_amp_l", 1.25 + .02 * j], ["ddk_rate", 6.4 - 1.2 * f + .1 * j], ["gait_stride_cv", 3 + .05 * j]])
    recs.push(...M.fromSession("ALEX-CASE", { [metric]: value }, { t, source: "companion", session: "s" + d + metric.slice(0, 3), now }).recs); }
const S = M.summary(recs, "ALEX-CASE");
ok(S.metrics.grip_amp_r.status === "bad" && S.metrics.grip_amp_r.pctOfBaseline < 70, "right grip declining " + JSON.stringify(S.metrics.grip_amp_r));
ok(S.metrics.grip_amp_l.status === "ok", "left grip ok " + S.metrics.grip_amp_l.status + " " + S.metrics.grip_amp_l.pctOfBaseline);
ok(S.metrics.ddk_rate.status !== "ok" && S.metrics.ddk_rate.slopePctPerWeek < 0, "speech slowing " + JSON.stringify(S.metrics.ddk_rate));
ok(S.metrics.gait_stride_cv.status === "ok", "flat lower-is-better metric ok " + S.metrics.gait_stride_cv.status);
ok(S.regions.handR === "bad" && S.regions.handL === "ok" && S.regions.bulbar !== "ok" && S.regions.chest === "none", "regions " + JSON.stringify(S.regions));
ok(S.motorScore > 60 && S.motorScore < 95, "motor score " + S.motorScore);
ok(S.asymmetry.length === 1 && S.asymmetry[0].ratio < .7, "asymmetry " + JSON.stringify(S.asymmetry));
ok(M.weekly(M.series(recs, "ALEX-CASE", "ddk_rate")).length >= 10, "weekly buckets");
// lower-is-better worsening (stride variability rising) must read < 100
const hi = []; for (let d = 0; d < 30; d++) hi.push(...M.fromSession("P1", { gait_stride_cv: 3 + d * .15 }, { t: now - (30 - d) * DAY, now }).recs);
ok(M.summary(hi, "P1").metrics.gait_stride_cv.pctOfBaseline < 80, "lower-is-better worsening < 100");
// too little data -> no status
ok(M.summary(M.fromSession("P2", { grip_amp_r: 1 }, { now }).recs, "P2").metrics.grip_amp_r.status === "none", "1 reading -> no status");
// invalid-quality readings are ignored
const q = M.fromSession("P3", { ddk_rate: 5 }, { quality: { valid: false }, now }).recs; ok(M.series(q, "P3", "ddk_rate").length === 0, "invalid-quality readings excluded");
// streak
const mk = (daysAgo, s) => ({ patient: "P4", metric: "ddk_rate", value: 5, t: now - daysAgo * DAY + 3600e3, source: "companion", session: s });
const act = M.activity([mk(0, "a"), mk(1, "b"), mk(2, "c"), mk(4, "d")], "P4", now, 0); ok(act.streak >= 3 && act.sessions === 4 && act.xp === 40, "streak " + JSON.stringify(act));
ok(M.activity([mk(1, "a"), mk(2, "b")], "P4", now, 0).streak === 2, "streak survives a not-yet-done today");
ok(M.activity([mk(3, "a")], "P4", now, 0).streak === 0, "streak broken");

// ---- speech: synthetic pa-ta-ka at a given rate ----
const SR = 16000, burst = (rate, secs, jitter = 0, noise = .002, amp = .6) => { const n = SR * secs, x = new Float32Array(n); let t = 0, nextOn = 0.3, i = 0;
  const onsets = []; while (nextOn < secs - .2) { onsets.push(nextOn); nextOn += (1 / rate) * (1 + jitter * Math.sin(onsets.length * 2.3)); }
  for (const o of onsets) for (let k = 0; k < SR * .09; k++) { const idx = Math.round(o * SR) + k; if (idx < n) x[idx] += amp * Math.sin(Math.PI * k / (SR * .09)) * Math.sin(2 * Math.PI * 180 * idx / SR); }
  for (let k = 0; k < n; k++) x[k] += noise * (Math.random() * 2 - 1); return x; };
let r = D.analyzeDDK(burst(6, 8), SR); ok(r.valid && Math.abs(r.rate - 6) < .4, "ddk 6/s " + JSON.stringify(r));
r = D.analyzeDDK(burst(4, 8), SR); ok(r.valid && Math.abs(r.rate - 4) < .3, "ddk 4/s " + r.rate);
const cvSteady = D.analyzeDDK(burst(5, 8, 0), SR).cv, cvJit = D.analyzeDDK(burst(5, 8, .35), SR).cv; ok(cvJit > cvSteady + 5, `jitter raises cv ${cvSteady} -> ${cvJit}`);
ok(!D.analyzeDDK(burst(6, 2), SR).valid, "too short rejected");
ok(!D.analyzeDDK(new Float32Array(SR * 6).map(() => (Math.random() - .5) * .01), SR).valid, "noise only rejected");
ok(!D.analyzeDDK(burst(6, 8, 0, .002, .0005), SR).valid, "too quiet rejected");
const v = D.ddkToValues(D.analyzeDDK(burst(6, 8), SR)); ok(M.fromSession("P5", v, { now }).errors.length === 0, "ddk values pass validation");
const vowel = new Float32Array(SR * 9); for (let k = 0; k < SR * 6.5; k++) vowel[k + SR] = .4 * Math.sin(2 * Math.PI * 150 * k / SR); for (let k = 0; k < vowel.length; k++) vowel[k] += .002 * (Math.random() * 2 - 1);
r = D.analyzeMPT(vowel, SR); ok(r.valid && Math.abs(r.mpt - 6.5) < .4, "mpt 6.5 s " + r.mpt);

// ---- dictation ----
let p = Dic.parse("Grip left 28 right 31, FVC sitting 74 supine 61, SNIP 52, ALSFRS-R 32, ten meter walk 14.2 seconds");
ok(p.values.grip_kg_l === 28 && p.values.grip_kg_r === 31 && p.values.fvc_sit_pct === 74 && p.values.fvc_sup_pct === 61 && p.values.snip_cmh2o === 52 && p.values.alsfrs_r === 32 && p.values.walk10m_s === 14.2, "dictation full " + JSON.stringify(p));
p = Dic.parse("right grip 14 kilos, left 32"); ok(p.values.grip_kg_r === 14 && p.values.grip_kg_l === 32, "dictation side-first " + JSON.stringify(p));
p = Dic.parse("grip strength 28"); ok(p.values.grip_kg_l === undefined && p.notes.length === 1, "grip without side flagged " + JSON.stringify(p));
p = Dic.parse("fvc 80"); ok(p.values.fvc_sit_pct === 80 && p.notes.some(n => /assumed/.test(n)), "fvc default sitting");
p = Dic.parse("NfL 88 and CK 470"); ok(p.values.nfl_pgml === 88 && p.values.ck === 470, "labs " + JSON.stringify(p));
ok(Object.keys(Dic.parse("hello there").values).length === 0, "nothing heard");

// ---- API ----
(async () => {
  const srv = createApp({ dataFile: null, env: { SEED_DEMO: "0" } }); await new Promise(r => srv.listen(0, "127.0.0.1", r)); const base = "http://127.0.0.1:" + srv.address().port;
  const call = async (m, u, b) => { let r; try { r = await fetch(base + u, { method: m, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : typeof b === "string" ? b : JSON.stringify(b) }); } catch (e) { return { s: 0, j: null }; } let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
  let a = await call("GET", "/api/health"); ok(a.s === 200 && a.j.records === 0 && !a.j.gemini, "health");
  a = await call("POST", "/api/measurements", { patient: "ALEX-CASE", values: { grip_kg_r: 14, grip_kg_l: 32, ddk_rate: 5.2 }, source: "clinic" }); ok(a.s === 201 && a.j.saved === 3, "post session " + JSON.stringify(a));
  a = await call("POST", "/api/measurements", { patient: "ALEX-CASE", values: { ddk_rate: 99 } }); ok(a.s === 400, "all-invalid session -> 400");
  a = await call("POST", "/api/measurements", { patient: "ALEX-CASE", values: { ddk_rate: 5, grip_kg_r: 999 } }); ok(a.s === 201 && a.j.saved === 1 && a.j.rejected.length === 1, "partial session " + JSON.stringify(a));
  a = await call("POST", "/api/measurements", { patient: "ALEX-CASE", metric: "mpt_s", value: 7.5 }); ok(a.s === 201, "single record");
  a = await call("POST", "/api/measurements", "{not json"); ok(a.s === 400, "bad json -> 400");
  a = await call("POST", "/api/measurements", { patient: "ALEX-CASE", values: { ck: "x".repeat(200000) } }); ok(a.s === 413 || a.s === 0, "oversize body -> 413");
  a = await call("GET", "/api/measurements?patient=ALEX-CASE&metric=grip_kg_r"); ok(a.s === 200 && a.j.length === 1 && a.j[0].value === 14, "get measurements");
  a = await call("GET", "/api/measurements"); ok(a.s === 400, "patient required");
  a = await call("GET", "/api/summary?patient=ALEX-CASE"); ok(a.s === 200 && a.j.metrics.grip_kg_r && a.j.regions.handR === "none", "summary (1 reading each -> no status) " + JSON.stringify(a.j && a.j.regions));
  a = await call("POST", "/api/dictation", { text: "grip left 28 right 31" }); ok(a.j.values.grip_kg_r === 31, "dictation endpoint");
  a = await call("POST", "/api/summarize", { patient: "ALEX-CASE" }); ok(a.s === 200 && a.j.source === "template" && a.j.patient_summary && Array.isArray(a.j.neurologist_bullets), "summarize template " + JSON.stringify(a));
  a = await call("POST", "/api/summarize", { patient: "NOBODY" }); ok(a.s === 404, "summarize no data -> 404");
  a = await call("GET", "/api/eleven-session"); ok(a.s === 503, "eleven without keys -> 503");
  a = await call("GET", "/api/nope"); ok(a.s === 404, "unknown api");
  for (const [u, code] of [["/index.html", 200], ["/assets/body.glb", 200], ["/measures.js", 200], ["/server.js", 404], ["/.env", 404], ["/data_store/measurements.json", 404], ["/..%2f..%2fpackage.json", 404], ["/%2e%2e/%2e%2e/etc/passwd", 404]]) {
    const r = await fetch(base + u); ok(r.status === code, `static ${u} -> ${r.status} (want ${code})`); }
  srv.close(); console.log(bad ? bad + " FAILED" : "all backend tests passed"); process.exitCode = bad ? 1 : 0;
})();
// ---- demo seed produces the story the console shows ----
{ const S = M.summary(require("../seed.js").alexRecords(), "ALEX-CASE");
  const bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  bad2(S.regions.handR === "bad" && S.regions.handL === "ok", "seed: right hand bad, left ok " + JSON.stringify(S.regions));
  bad2(S.regions.footR === "bad" && S.regions.footL === "warn" && S.regions.bulbar === "bad", "seed: foot/bulbar " + JSON.stringify(S.regions));
  bad2(S.metrics.grip_kg_r.last === 14 && S.metrics.grip_kg_l.last === 32 && S.metrics.nfl_pgml.last === 88, "seed: clinic values");
  bad2(S.motorScore > 55 && S.motorScore < 90, "seed score " + S.motorScore);
  bad2(S.activity.daysActive >= 55, "seed activity " + JSON.stringify(S.activity));
  console.log("seed:", JSON.stringify({ score: S.motorScore, regions: S.regions, act: S.activity })); }
// ---- access key ----
(async () => {
  const bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  const srv = createApp({ dataFile: null, env: { SEED_DEMO: "0", ACCESS_TOKEN: "s3cret-token-xyz" } }); await new Promise(r => srv.listen(0, "127.0.0.1", r)); const base = "http://127.0.0.1:" + srv.address().port;
  let r = await fetch(base + "/index.html"); bad2(r.status === 401, "no key -> 401 (got " + r.status + ")");
  r = await fetch(base + "/api/health"); bad2(r.status === 401, "api without key -> 401");
  r = await fetch(base + "/index.html?key=wrong"); bad2(r.status === 401, "wrong key -> 401");
  r = await fetch(base + "/index.html?key=s3cret-token-xyz&patient=ALEX-CASE", { redirect: "manual" }); const ck = (r.headers.get("set-cookie") || "").split(";")[0];
  bad2(r.status === 302 && r.headers.get("location") === "/index.html?patient=ALEX-CASE" && ck.startsWith("motor_access="), "good key -> cookie + redirect without key " + r.status + " " + r.headers.get("location"));
  r = await fetch(base + "/api/health", { headers: { cookie: ck } }); bad2(r.status === 200, "cookie -> 200");
  r = await fetch(base + "/api/health", { headers: { cookie: "motor_access=nope" } }); bad2(r.status === 401, "bad cookie -> 401");
  srv.close(); console.log("access-key tests done");
})();
// ---- reading rate (words per minute) ----
(() => {
  const bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  const SR = 16000, read = (burstsPerSec, secs, lead = 1.5, trail = 2, gapEvery = 0, amp = .6) => { const n = Math.round(SR * (lead + secs + trail)), x = new Float32Array(n); let t = lead, c = 0;
    while (t < lead + secs - .05) { for (let k = 0; k < SR * .08; k++) { const i = Math.round(t * SR) + k; x[i] += amp * Math.sin(Math.PI * k / (SR * .08)) * Math.sin(2 * Math.PI * 170 * i / SR); } c++; t += 1 / burstsPerSec; if (gapEvery && c % gapEvery === 0) t += .5; }
    for (let k = 0; k < n; k++) x[k] += .002 * (Math.random() * 2 - 1); return { x, bursts: c }; };
  let { x, bursts } = read(7.2, 40); let r = D.analyzeReading(x, SR, Math.round(bursts / 3)); bad2(r.valid && Math.abs(r.wpm - 144) < 12, "reading 144 wpm -> " + JSON.stringify(r));
  ({ x, bursts } = read(5.4, 40)); r = D.analyzeReading(x, SR, Math.round(bursts / 3)); bad2(r.valid && Math.abs(r.wpm - 108) < 10, "reading ~108 wpm -> " + r.wpm);
  ({ x, bursts } = read(7.2, 40, 1.5, 2, 12)); const rp = D.analyzeReading(x, SR, Math.round(bursts / 3)); bad2(rp.valid && rp.pauseFrac > .08, "pauses detected " + rp.pauseFrac);
  bad2(!D.analyzeReading(read(7.2, 6).x, SR).valid, "short reading rejected");
  bad2(!D.analyzeReading(new Float32Array(SR * 30).map(() => (Math.random() - .5) * .01), SR).valid, "noise reading rejected");
  bad2(D.PASSAGE_WORDS > 80 && D.PASSAGE_WORDS < 110, "passage words " + D.PASSAGE_WORDS);
  bad2(M.fromSession("P6", D.readingToValues({ wpm: 141.4 }), {}).errors.length === 0, "wpm passes validation");
  console.log("reading tests done, passage words:", D.PASSAGE_WORDS);
})();
// ---- reference ranges ----
(() => {
  const R = require("../reference.js"), bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  const row = id => R.SECTIONS.flatMap(s => s.rows || []).find(r => r.id === id), st = (id, v) => R.place(row(id), v).state;
  bad2(st("grip", 14) === "als" && st("grip", 48) === "control" && st("grip", 25) === "toward-als" && st("grip", 38) === "toward-control", "grip placement " + st("grip", 14) + st("grip", 48) + st("grip", 25) + st("grip", 38));
  bad2(st("nfl", 8) === "control" && st("nfl", 88) === "als", "nfl 8/88");
  bad2(st("ck", 470) === "beyond" && st("ck", 100) === "control" && st("ck", 180) === "overlap", "ck beyond/control/overlap " + st("ck", 470) + st("ck", 100) + st("ck", 180));
  bad2(st("walk", 5) === "control" && st("walk", 14.2) === "als" && st("walk", 7.8) === "overlap", "walk");
  bad2(st("snip", 52) === "als" && st("snip", 90) === "control", "snip cutoff");
  bad2(st("fvc", 78) === "als" && st("fvc", 95) === "control", "fvc sitting");
  bad2(R.place(row("grip"), null).state === "none" && R.place(row("grip"), NaN).state === "none", "missing value -> none");
  const E = R.evaluate({ fvc_sit_pct: 78, fvc_sup_pct: 64, grip_kg_r: 14, grip_kg_l: 32 }), find = id => E.sections.flatMap(s => s.rows).find(r => r.id === id);
  bad2(Math.abs(find("fvcdrop").value - 17.95) < .1 && find("fvcdrop").placed.state === "als", "fvc drop derived " + find("fvcdrop").value);
  bad2(find("grip").value === 14 && find("grip").shown.length === 2, "grip uses weaker side, shows both");
  bad2(R.evaluate({}).summary.measured === 0, "empty values -> nothing measured");
  console.log("reference tests done");
})();
// ---- lab file reader ----
(() => {
  const L = require("../labfile.js"), bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  let r = L.parse("test,value,unit\nSerum neurofilament light chain,88,pg/mL\nCreatine Kinase,470,U/L\nGrip strength right,14,kg\nGrip strength left,32,kg\nHaemoglobin,13.5,g/dL\n", "labs.csv");
  bad2(r.values.nfl_pgml === 88 && r.values.ck === 470 && r.values.grip_kg_r === 14 && r.values.grip_kg_l === 32, "long csv " + JSON.stringify(r.values));
  bad2(r.skipped.includes("Haemoglobin") && !("hb" in r.values), "unknown marker reported as skipped " + r.skipped);
  r = L.parse("NfL,CK,FVC sitting,FVC supine,SNIP\n88,470,78,64,52\n", "wide.csv"); bad2(r.values.nfl_pgml === 88 && r.values.fvc_sup_pct === 64 && r.values.snip_cmh2o === 52, "wide csv " + JSON.stringify(r.values));
  r = L.parse("nfl_pgml;88\nck;470\n", "x.csv"); bad2(r.values.nfl_pgml === 88 && r.values.ck === 470, "semicolon pairs " + JSON.stringify(r.values));
  r = L.parse("Marker\tResult\nHS Troponin T\t16.5 ng/L\nGlutamate\t35,2\n", "t.tsv"); bad2(r.values.troponin_t_ngl === 16.5 && r.values.glutamate_um === 35.2, "tsv + comma decimals " + JSON.stringify(r.values));
  r = L.parse('{"values":{"nfl_pgml":88,"ck":470,"pinch_kg_r":3}}', "r.json"); bad2(r.values.pinch_kg_r === 3 && r.values.ck === 470, "json values");
  r = L.parse('[{"name":"Amylin","value":285.41},{"name":"Choline","result":"1.8 umol/L"}]', "r.json"); bad2(r.values.amylin_pgml === 285.41 && r.values.choline_umol === 1.8, "json array " + JSON.stringify(r.values));
  r = L.parse("Patient: ALEX\nNfL: 88 pg/mL\nCreatine kinase = 470\nWalk: 14.2 s\n", "note.txt"); bad2(r.values.nfl_pgml === 88 && r.values.ck === 470 && r.values.walk10m_s === 14.2, "text lines " + JSON.stringify(r.values));
  r = L.parse("grip left 28 right 31, SNIP 52", "dictated.txt"); bad2(r.values.grip_kg_l === 28 && r.values.snip_cmh2o === 52, "falls back to dictation parser " + JSON.stringify(r.values));
  r = L.parse("test,value\nNfL,pending\n", "p.csv"); bad2(Object.keys(r.values).length === 0 && r.notes.length === 1, "non-numeric value noted");
  r = L.parse("", "empty.csv"); bad2(Object.keys(r.values).length === 0, "empty file ok");
  r = L.parse("﻿test,value\nCK,470", "bom.csv"); bad2(r.values.ck === 470, "BOM stripped");
  console.log("lab file tests done");
})();
// ---- extract-labs endpoint (no key -> clear 503; input validation) ----
(async () => {
  const bad2 = (c, m) => { if (!c) { process.exitCode = 1; console.log("FAIL", m); } };
  const post = async (srv, b) => { const r = await fetch("http://127.0.0.1:" + srv.address().port + "/api/extract-labs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
  let srv = createApp({ dataFile: null, env: { SEED_DEMO: "0" } }); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  let a = await post(srv, { mime: "image/png", data: "A".repeat(200) }); bad2(a.s === 503 && /GEMINI_API_KEY/.test(a.j.error), "no key -> 503 " + a.s); srv.close();
  srv = createApp({ dataFile: null, env: { SEED_DEMO: "0", GEMINI_API_KEY: "fake" } }); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  a = await post(srv, { mime: "text/html", data: "A".repeat(200) }); bad2(a.s === 400, "bad mime -> 400 " + a.s);
  a = await post(srv, { mime: "image/png", data: "not base64!!" }); bad2(a.s === 400, "bad base64 -> 400");
  a = await post(srv, { mime: "image/png", data: "A".repeat(6.5e6) }); bad2(a.s === 413, "too large -> 413 " + a.s);
  srv.close(); console.log("extract endpoint tests done");
})();
