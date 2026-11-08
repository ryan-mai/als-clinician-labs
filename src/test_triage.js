"use strict";
// Parity test: the Python original (python/als_triage.py) and the JavaScript port (triage.js) must agree on every random case.
const path = require("path"), fs = require("fs"), { spawnSync } = require("child_process");
const T = require("../triage.js"); let bad = 0; const ok = (c, m) => { if (!c) { bad++; if (bad < 15) console.log("FAIL", m); } };
const root = path.join(__dirname, ".."), cands = [process.env.PYTHON, path.join(root, "..", ".venv", "Scripts", "python.exe"), path.join(root, "..", ".venv", "bin", "python"), "python3", "python"].filter(Boolean);
let res = null; for (const py of cands) { if (path.isAbsolute(py) && !fs.existsSync(py)) continue; const r = spawnSync(py, ["-I", path.join(__dirname, "triage_parity.py"), path.join(root, "python", "als_triage.py"), "600", "7"], { encoding: "utf8", maxBuffer: 64e6 }); if (r.status === 0) { res = JSON.parse(r.stdout); break; } }

// hand-checked cases (independent of Python)
const none = {}; ok(T.triage(none).tier === 0, "no symptoms -> 0");
ok(T.triage({ fasc: 1 }).tier === 1, "one isolated finding -> 1");
ok(T.triage({ fasc: 1, progressive: 1 }).tier === 2, "progressive LMN -> 2");
ok(T.triage({ arm_weak: 1, reflex: 1, progressive: 1 }).tier === 3, "progressive UMN+LMN -> 3");
ok(T.triage({ arm_weak: 1, leg_weak: 1, progressive: 1 }).tier === 3, "progressive, two regions -> 3");
ok(T.triage({ fasc: 1, family: 1 }).tier === 2, "family history bumps 1 -> 2");
ok(T.triage({ family: 1 }).tier === 0, "family history alone never raises a no-symptom case");
ok(T.triage({ fasc: 1, sensory: 1, sphincter: 1, fluctuating: 1 }).tier === 1, "atypical features never lower the tier");
ok(T.evaluate({ sudden: true }).emergency === true, "sudden onset -> emergency message, no tier");
const ev = T.evaluate({ arm_weak: 1, speech: 1, progressive: 1, months: 8, sensory: 1, family: 1 });
ok(ev.tier === 3 && ev.timeSensitive && /8 months/.test(ev.timeSensitive) && ev.atypical.length === 1 && ev.risks[0].tag === "strongest known risk factor" && ev.steps.some(s => /gene panel/.test(s)) && ev.steps.some(s => /Speech and swallowing/.test(s)), "evaluate bundle " + JSON.stringify(ev));
ok(![...T.SYMPTOMS, ...T.PATTERN, ...T.RED_FLAGS, ...T.RISKS].some(x => /age|years old|how old|sex/i.test(x.q)), "questions never ask age or sex");

if (!res) console.log("python not found: skipped the Python parity check (set PYTHON=path\\to\\python to run it)");
else {
  ok(JSON.stringify(res.tiers) === JSON.stringify(Object.fromEntries(Object.entries(T.TIERS))), "tier labels match");
  ok(res.follow_up === T.FOLLOW_UP_WEEKS, "follow-up weeks match");
  ok(JSON.stringify(res.symptoms) === JSON.stringify(T.SYMPTOMS.map(s => [s.key, s.label, s.group, s.region, s.q])), "symptom list matches");
  ok(JSON.stringify(res.pattern) === JSON.stringify(T.PATTERN.map(p => [p.key, p.q])), "pattern questions match");
  ok(JSON.stringify(res.red_flags) === JSON.stringify(T.RED_FLAGS.map(r => [r.key, r.q, r.note])), "red flags match");
  ok(JSON.stringify(res.risks) === JSON.stringify(T.RISKS.map(r => [r.key, r.q, r.strong])), "risks match");
  const seen = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const [i, c] of res.cases.entries()) {
    const j = T.triage(c.ans), steps = T.nextSteps(j.tier, c.ans), ev = T.evaluate(c.ans); seen[c.tier]++;
    ok(j.tier === c.tier, `case ${i}: tier JS ${j.tier} vs Python ${c.tier}`);
    ok(JSON.stringify(j.reasons) === JSON.stringify(c.reasons), `case ${i}: reasons differ ${JSON.stringify(j.reasons)} vs ${JSON.stringify(c.reasons)}`);
    ok(JSON.stringify(steps) === JSON.stringify(c.steps), `case ${i}: next steps differ`);
    ok(!!ev.timeSensitive === c.time_sensitive, `case ${i}: time-sensitive flag differs`);
  }
  ok(Object.values(seen).every(n => n >= 20), "random cases cover every tier " + JSON.stringify(seen));
  console.log(`python parity: ${res.cases.length} random cases, tiers seen ${JSON.stringify(seen)}`);
}
console.log(bad ? bad + " failures" : "all triage tests passed"); process.exit(bad ? 1 : 0);
