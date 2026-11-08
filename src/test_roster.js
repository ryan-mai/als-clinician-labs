"use strict";
const R = require("../roster.js"), S = require("../seed.js"), { createApp } = require("../server.js");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const now = Date.now(), recs = [...S.alexRecords(now), ...S.cohortRecords(now)];
const r = R.buildRoster(recs, [{ patient: "NEW-1", t: now, emergency: true, tier: null }, { patient: "DEMO-05", t: now, tier: 3 }], ["PLAN-ONLY"], now), by = Object.fromEntries(r.patients.map(p => [p.code, p]));
ok(r.patients[0].code === "NEW-1" && r.patients[0].level === "emergency", "emergency flag sorts first: " + r.patients[0].code);
ok(by["PLAN-ONLY"].level === "new" && !by["PLAN-ONLY"].hasReadings, "code with no readings is new");
ok(by["ALEX-CASE"].level === "declining" && by["ALEX-CASE"].motorScore < 85, "alex declining " + JSON.stringify([by["ALEX-CASE"].level, by["ALEX-CASE"].motorScore]));
ok(by["DEMO-01"].level === "declining", "fast hand decline is declining: " + by["DEMO-01"].level);
ok(by["DEMO-04"].level === "steady" && by["DEMO-04"].weeks >= 19, "long-running steady patient " + by["DEMO-04"].level + " " + by["DEMO-04"].weeks);
ok(by["DEMO-06"].quiet && by["DEMO-06"].daysSince >= 10, "quiet patient flagged");
ok(by["DEMO-05"].priority > 150 + 50 - 1 && by["DEMO-05"].tier === 3, "symptom tier raises priority");
ok(by["DEMO-02"].regions.includes("Speech & face"), "speech decline shows its area " + by["DEMO-02"].regions);
ok(by["ALEX-CASE"].trajectory.length >= 9 && by["ALEX-CASE"].trajectory.at(-1).pct < by["ALEX-CASE"].trajectory[0].pct - 10, "trajectory declines");
ok(r.cohort.levels.declining >= 3 && r.cohort.quiet.includes("DEMO-06"), "cohort counts " + JSON.stringify(r.cohort.levels));
ok(r.patients.every((p, i, a) => !i || a[i - 1].priority >= p.priority), "sorted by priority");
const t = R.templateInsights(r.patients, r.cohort); ok(t.headline && t.bullets.length >= 2 && t.bullets.some(b => /DEMO-06/.test(b)), "template insights " + JSON.stringify(t));
const facts = JSON.stringify(R.insightFacts(r.patients)); ok(!/answers|matters|hopes|questions/i.test(facts) && /DEMO-01/.test(facts), "Gemini facts contain only codes and numbers");
const one = R.patientRow("X", [], [], now); ok(one.level === "new" && one.trajectory.length === 0 && one.checkins === 0, "empty patient row");
// API
(async () => {
  const app = createApp({ dataFile: null, dataDir: require("os").tmpdir() + "/roster-test-" + now, env: { SEED_DEMO: "1" } }), srv = app.listen ? app : app.server || app;
  const s = (srv.listen ? srv : app.server); await new Promise(ok2 => s.listen(0, "127.0.0.1", ok2)); const base = "http://127.0.0.1:" + s.address().port;
  await new Promise(x => setTimeout(x, 300));
  const j = await (await fetch(base + "/api/patients")).json();
  ok(j.patients.some(p => p.code === "DEMO-01") && j.patients.some(p => p.code === "ALEX-CASE") && j.cohort.total >= 9, "api/patients lists seeded cohort: " + j.patients.length);
  const ins = await (await fetch(base + "/api/cohort-insights")).json(); ok(ins.source === "template" && ins.bullets.length, "api/cohort-insights falls back without a key");
  console.log(bad ? bad + " failed" : "roster tests passed"); process.exitCode = bad ? 1 : 0; s.close(); setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.log("FAIL", e); process.exit(1); });
