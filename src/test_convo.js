"use strict";
// Conversation speaking-rate tests (timelines built by hand so the right answer is known) and the question-plan / chat-session API (ElevenLabs stubbed).
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const C = require("../convo.js"), { createApp, createStore } = require("../server.js");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- word counting
ok(C.countWords("I'm fine, thanks.") === 3, "contraction is one word");
ok(C.countWords("my mother-in-law came over") === 4, "hyphenated word is one word");
ok(C.countWords("well (laughs) it was [pause] fine") === 4, "stage directions are not words");
ok(C.countWords("") === 0 && C.countWords(null) === 0 && C.countWords("   ") === 0, "empty text has no words");
ok(C.countWords("Il a dit « ça va très bien »") === 7, "accented letters count");

// ---- the tracker. Helper: play a patient turn of `secs` seconds starting at t, sampling every 50 ms.
function talk(tr, t, secs) { for (let x = 0; x < secs * 1000; x += 50) tr.sample(true, t + x); return t + secs * 1000; }
function session(turns, opts = {}) {                                   // turns: [{words, secs}] ; returns the tracker
  const tr = C.createTracker(opts); let t = 1000;
  for (const u of turns) {
    tr.mode("speaking", t); t += 3000;                                  // the assistant asks something
    tr.sample(true, t - 500);                                           // ... and its voice is audible the whole time (must be ignored)
    tr.mode("listening", t); t += 700;                                  // patient takes a moment, then speaks
    t = talk(tr, t, u.secs); tr.text("word ".repeat(u.words)); t += 600;
  }
  return tr;
}
let r = session([{ words: 50, secs: 20 }, { words: 40, secs: 16 }, { words: 30, secs: 12 }]).result();   // 120 words in 48 s = 150 wpm
ok(r.valid && near(r.wpm, 150, 3), "known timeline gives ~150 wpm, got " + r.wpm);
ok(r.turns === 3 && near(r.speechS, 48, 0.5), "three turns, ~48 s of speech, got " + r.turns + " / " + r.speechS);

// the assistant talking, and its tail right after it stops, must not count as the patient
{ const tr = C.createTracker(); tr.mode("speaking", 0); for (let t = 0; t < 5000; t += 50) tr.sample(true, t);
  tr.mode("listening", 5000); for (let t = 5000; t < 5000 + C.GUARD_MS - 50; t += 50) tr.sample(true, t);
  ok(tr.speechS() === 0, "assistant speech and its tail are ignored"); tr.sample(true, 5000 + C.GUARD_MS); ok(tr.chunks().length === 0, "a single blip is below the minimum stretch"); }

// a long silence mid-answer (thinking) is not counted, a short pause is
{ const a = C.createTracker(); a.mode("listening", 0); let t = C.GUARD_MS; t = talk(a, t, 10); t += 1500; t = talk(a, t, 10);       // 1.5 s pause stays inside one stretch
  ok(a.chunks().length === 1 && near(a.speechS(), 21.5, 0.2), "short pause stays in the speaking time: " + a.speechS());
  const b = C.createTracker(); b.mode("listening", 0); t = C.GUARD_MS; t = talk(b, t, 10); t += 5000; t = talk(b, t, 10);            // 5 s silence splits it
  ok(b.chunks().length === 2 && near(b.speechS(), 20, 0.2), "long silence is not counted: " + b.speechS()); }

// noise bursts (cough, chair) shorter than the minimum are dropped
{ const tr = C.createTracker(); tr.mode("listening", 0); tr.sample(true, 1000); tr.sample(true, 1050); ok(tr.chunks().length === 0, "very short bursts are dropped"); }

// too little speech is reported, not turned into a number
r = session([{ words: 8, secs: 4 }]).result(); ok(!r.valid && r.reasons.length === 1 && /8 words/.test(r.reasons[0]), "too few words -> invalid with a reason: " + JSON.stringify(r.reasons));
r = session([{ words: 60, secs: 8 }]).result(); ok(!r.valid && /seconds/.test(r.reasons[0]), "too little speaking time -> invalid: " + JSON.stringify(r.reasons));
r = session([{ words: 400, secs: 20 }]).result(); ok(!r.valid && /Implausible/.test(r.reasons[0]), "1200 wpm is rejected as implausible");
r = C.createTracker().result(); ok(!r.valid && r.wpm === undefined, "nothing heard -> invalid, no rate");

// slower speech reads as a lower rate (the thing the doctor is looking for)
const fast = session([{ words: 80, secs: 30 }]).result().wpm, slow = session([{ words: 56, secs: 30 }]).result().wpm;
ok(fast > slow * 1.35 && near(fast, 160, 3) && near(slow, 112, 3), `160 vs 112 wpm are told apart: ${fast.toFixed(0)} vs ${slow.toFixed(0)}`);
ok(C.toValues({ wpm: 149.6 }).speech_wpm === 150, "stored as a whole number of words/min under the existing speech_wpm metric");

// mode events that repeat or are unknown do nothing; time must start a new window only on a real switch
{ const tr = C.createTracker(); tr.mode("listening", 0); tr.mode("listening", 5000); tr.mode("thinking", 6000); talk(tr, C.GUARD_MS, 3); ok(tr.chunks().length === 1 && tr.chunks()[0][0] === C.GUARD_MS, "repeated listening does not restart the guard"); }

// camera frames are kept only while the patient was speaking
{ const t0 = 10000, frames = Array.from({ length: 100 }, (_, i) => ({ t: i / 10, open: 0.2 })), kept = C.framesIn(frames, [[12000, 14000]], t0);   // speech 2-4 s into the recording
  ok(kept.length > 0 && kept.every(f => f.t >= 1.85 && f.t <= 4.15) && kept.length < 30, "frames outside speech are dropped: " + kept.length); }

// ---- question lists
{ let q = C.cleanQuestions("1. How was today?\n- Any changes?\n\n  \nok\n" + "x".repeat(400)); ok(q.questions.length === 3 && q.questions[0] === "How was today?" && q.questions[1] === "Any changes?" && q.questions[2].length === C.MAX_QUESTION_LEN && q.dropped === 1, "list bullets/numbers stripped, blanks and 2-letter lines dropped, long lines capped: " + JSON.stringify(q.questions.map(s => s.slice(0, 20))));
  q = C.cleanQuestions(Array.from({ length: 30 }, (_, i) => "Question number " + i)); ok(q.questions.length === C.MAX_QUESTIONS, "at most " + C.MAX_QUESTIONS + " questions");
  q = C.cleanQuestions(["Line one\u0000\nstill line one"]); ok(q.questions.length === 1 && !/[\u0000-\u001f]/.test(q.questions[0]), "control characters removed");
  ok(C.numbered(["a b c", "d e f"]) === "1. a b c\n2. d e f", "numbered for the agent prompt"); }

// ---- onboarding options
ok(typeof C.ONBOARD.matters[0][0] === "string" && C.ONBOARD.changes === undefined, "only the interests list lives here; the symptom questionnaire comes from triage.js");
{ let o = C.cleanOnboarding({ matters: ["cooking", "family", "cooking"], consent: true }); ok(o.ok && o.value.matters.length === 2 && o.value.consent === true, "valid onboarding accepted, duplicates removed");
  ok(!C.cleanOnboarding({ matters: ["cooking"] }).ok, "consent is required");
  ok(!C.cleanOnboarding({ matters: ["cooking"], consent: "yes" }).ok, "consent must be exactly true");
  ok(!C.cleanOnboarding({ matters: ["flying"], consent: true }).ok, "unknown option refused");
  ok(!C.cleanOnboarding({ matters: "cooking", consent: true }).ok, "options must be a list");
  ok(C.cleanOnboarding({ consent: true }).ok, "choosing no interests is allowed");
  ok(C.interestsText(["family", "cooking"]) === "time with family, cooking and food" && C.interestsText([]) === "nothing specific shared" && C.interestsText(null) === "nothing specific shared", "interests as plain words for the assistant"); }

// ---- API
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-convo-")), store = createStore(path.join(dir, "m.json"));
  const realFetch = global.fetch, seen = []; global.fetch = async (url, o) => { if (String(url).startsWith("https://api.elevenlabs.io/")) { seen.push({ url: String(url), key: o && o.headers && o.headers["xi-api-key"] }); return { ok: true, status: 200, json: async () => ({ signed_url: "wss://example.test/signed" }) }; } return realFetch(url, o); };
  const mkApp = env => createApp({ store, env: { SEED_DEMO: "0", SESSION_SECRET: "s", ...env }, dataDir: dir });
  const run = async (app, fn) => { await app.ready; const srv = http.createServer(app.listeners("request")[0]); await new Promise(r => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port; try { await fn(port); } finally { srv.close(); } };
  const call = (port, method, p, body, cookie) => new Promise(res => { const d = body ? JSON.stringify(body) : null, rq = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(d ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, r => { let b = ""; r.on("data", c => b += c); r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ s: r.statusCode, j, h: r.headers, b }); }); }); if (d) rq.write(d); rq.end(); });
  const ck = r => (r.h["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

  await run(mkApp({ ELEVENLABS_API_KEY: "k-test", ELEVENLABS_CHAT_AGENT_ID: "agent-chat", ELEVENLABS_AGENT_ID: "agent-dictate" }), async port => {
    let a = await call(port, "GET", "/api/health"); ok(a.j.elevenlabsChat === true && a.j.elevenlabs === true, "health reports both agents " + a.b);
    const cookie = null;   // no doctor sign-in any more: the care-team routes are open (a shared site is protected by ACCESS_TOKEN)
    a = await call(port, "GET", "/api/conversation-plan?patient=PT-1", null, cookie); ok(a.s === 200 && a.j.isDefault === true && a.j.questions.length === C.DEFAULT_QUESTIONS.length, "no plan saved -> suggested questions " + a.b);
    a = await call(port, "POST", "/api/conversation-plan", { patient: "123456789", questions: ["How are you?"] }, cookie); ok(a.s === 400, "MRN-like code refused");
    a = await call(port, "POST", "/api/conversation-plan", { patient: "PT-1", questions: "not a list" }, cookie); ok(a.s === 400, "questions must be a list");
    a = await call(port, "POST", "/api/conversation-plan", { patient: "PT-1", questions: ["  How was your morning?  ", "", "Any trouble with swallowing?", "no"] }, cookie);
    ok(a.s === 200 && a.j.saved && !a.j.isDefault && a.j.questions.length === 2 && a.j.questions[0] === "How was your morning?" && a.j.dropped === 1, "plan saved and cleaned " + a.b);
    a = await call(port, "GET", "/api/conversation-plan?patient=PT-1", null, cookie); ok(a.j.questions[1] === "Any trouble with swallowing?" && !a.j.isDefault, "plan reads back");
    a = await call(port, "GET", "/api/conversation-plan?patient=PT-2", null, cookie); ok(a.j.isDefault, "another patient is unaffected");
    ok(JSON.parse(fs.readFileSync(path.join(dir, "conversation_plans.json"), "utf8"))["PT-1"].by === "care-team@biohacks", "plan is attributed to the built-in care team");

    a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=PT-1");        // patient page: no sign-in
    ok(a.s === 200 && a.j.signedUrl === "wss://example.test/signed" && a.j.dynamicVariables.questions === "1. How was your morning?\n2. Any trouble with swallowing?" && a.j.dynamicVariables.question_count === "2", "chat session carries this patient's questions " + a.b);
    ok(/agent_id=agent-chat/.test(seen[seen.length - 1].url) && seen[seen.length - 1].key === "k-test", "chat session uses the chat agent id, not the dictation agent");
    ok(!/k-test/.test(a.b), "the API key is never sent to the browser");
    a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=PT-9"); ok(a.s === 200 && a.j.dynamicVariables.question_count === String(C.DEFAULT_QUESTIONS.length), "patient with no plan gets the suggested questions");
    a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=x"); ok(a.s === 400, "bad code refused");
    a = await call(port, "GET", "/api/eleven-session?agent=chat"); ok(a.s === 400, "missing code refused");
    a = await call(port, "GET", "/api/eleven-session"); ok(a.s === 200 && /agent_id=agent-dictate/.test(seen[seen.length - 1].url) && a.j.dynamicVariables === undefined, "clinic dictation session unchanged");
    a = await call(port, "POST", "/api/conversation-plan", { patient: "PT-1", questions: [] }, cookie); ok(a.s === 200 && a.j.isDefault, "empty list goes back to the suggested questions");
    a = await call(port, "POST", "/api/conversation-plan", { patient: "__proto__", questions: ["Is this safe to store?"] }, cookie); ok(a.s === 200, "odd-looking code is handled");
    a = await call(port, "GET", "/api/conversation-plan?patient=constructor", null, cookie); ok(a.s === 200 && a.j.isDefault, "inherited property names are not mistaken for plans " + a.b);
    ok(({}).questions === undefined, "object prototype was not polluted");
    const audit = fs.readFileSync(path.join(dir, "audit.log"), "utf8"); ok(/conversation_plan_saved/.test(audit), "saving questions is audited");

    // patient onboarding (patient page, no sign-in)
    a = await call(port, "GET", "/api/patient/status?patient=PT-NEW"); ok(a.s === 200 && a.j.known === false && a.j.onboarded === false && a.j.questions.length === C.DEFAULT_QUESTIONS.length, "new code: not known, suggested questions returned " + a.b);
    a = await call(port, "GET", "/api/patient/status?patient=x"); ok(a.s === 400, "bad code refused");
    await call(port, "POST", "/api/conversation-plan", { patient: "PT-Q", questions: ["Only this question?"] }, cookie);
    a = await call(port, "GET", "/api/patient/status?patient=PT-Q"); ok(a.j.questions.length === 1 && a.j.questions[0] === "Only this question?", "status carries the doctor's saved questions " + a.b);
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-NEW", matters: ["cooking"], answers: { fasc: true } }); ok(a.s === 400 && /confirm/.test(a.j.error), "onboarding without consent refused " + a.b);
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-NEW", matters: ["flying"], consent: true }); ok(a.s === 400, "unknown option refused");
    a = await call(port, "GET", "/api/patient/status?patient=PT-NEW"); ok(a.j.known === false, "a refused onboarding does not make the patient known");
    a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=PT-NEW"); ok(a.j.dynamicVariables.interests === "nothing specific shared", "no onboarding -> no interests passed " + a.b);
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-NEW", answers: { arm_weak: true, wasting: true, progressive: true, spread: true, leg_weak: "true" }, months: 7, matters: ["cooking", "family"], consent: true, tier: 0 }); ok(a.s === 201 && a.j.saved && a.j.emergency === false && a.j.tier === undefined, "onboarding saved, and no tier is sent back to the patient " + a.b);
    a = await call(port, "GET", "/api/triage?patient=PT-NEW"); ok(a.s === 200 && a.j.length === 1 && a.j[0].tier === 3 && a.j[0].source === "patient" && a.j[0].clinician === "patient self-report" && a.j[0].answers.arm_weak === true && a.j[0].answers.leg_weak === false && a.j[0].answers.months === 7, "the server worked out tier 3 from the answers (ignoring the tier the phone sent and non-boolean answers) " + a.b);
    a = await call(port, "GET", "/api/patient/status?patient=PT-NEW"); ok(a.j.known === true && a.j.onboarded === true, "after onboarding the patient is known");
    a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=PT-NEW"); ok(a.j.dynamicVariables.interests === "cooking and food, time with family", "interests reach the assistant " + a.b);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "patient_onboarding.json"), "utf8"))["PT-NEW"]; ok(saved.matters[0] === "cooking" && saved.consent === true && saved.at > 0, "stored with consent and time");
    a = await call(port, "POST", "/api/measurements", { patient: "PT-OLD", metric: "speech_wpm", value: 150 }); ok(a.s === 201, "seed a reading");
    a = await call(port, "GET", "/api/patient/status?patient=PT-OLD"); ok(a.j.known === true && a.j.onboarded === false, "a patient with readings is known without onboarding (no flow for them)");
    a = await new Promise(res => { const d = JSON.stringify({ patient: "PT-X", consent: true }), rq = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/patient/onboard", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d), Origin: "http://evil.example" } }, r => { r.resume(); r.on("end", () => res({ s: r.statusCode })); }); rq.write(d); rq.end(); }); ok(a.s === 403, "cross-site onboarding post refused");
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-EMG", answers: { sudden: true } }); ok(a.s === 201 && a.j.emergency === true, "sudden onset is flagged as an emergency without needing consent " + a.b);
    a = await call(port, "GET", "/api/triage?patient=PT-EMG"); ok(a.j.length === 1 && a.j[0].emergency === true && a.j[0].tier === null, "emergency flag recorded for the care team");
    a = await call(port, "GET", "/api/patient/status?patient=PT-EMG"); ok(a.j.known === false && a.j.onboarded === false, "an emergency flag does not count as finished onboarding");
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-ODD", answers: ["arm_weak"], months: "abc", matters: [], consent: true }); ok(a.s === 201, "odd answers shape is tolerated");
    a = await call(port, "GET", "/api/triage?patient=PT-ODD"); ok(a.j[0].tier === 0 && a.j[0].answers.months === null && a.j[0].answers.arm_weak === false, "non-list answers and non-numeric months are ignored");
    a = await call(port, "POST", "/api/patient/onboard", { patient: "PT-BIG", answers: { arm_weak: true }, months: 9999, consent: true }); a = await call(port, "GET", "/api/triage?patient=PT-BIG"); ok(a.j[0].answers.months === null, "implausible months are ignored");
    for (const [m, p] of [["GET", "/signin.html"], ["GET", "/onboarding.html"], ["GET", "/api/me"], ["GET", "/api/auth/config"], ["POST", "/api/auth/demo"]]) { a = await call(port, m, p, m === "POST" ? {} : null); ok(a.s === 404, "doctor sign-in is gone: " + p + " -> " + a.s); }
    for (const pg of ["/triage.html", "/index.html", "/compare.html", "/session.html"]) { a = await call(port, "GET", pg); ok(a.s === 200, pg + " opens without signing in"); }
    a = await call(port, "POST", "/api/triage", { patient: "PT-1", answers: { arm_weak: true } }); ok(a.s === 404, "the dashboard no longer saves a questionnaire (it comes from the patient)");
    { const au = fs.readFileSync(path.join(dir, "audit.log"), "utf8"); ok(/patient_onboarded/.test(au) && /patient_emergency_flag/.test(au) && /care-team@biohacks/.test(au), "audit log records patient onboarding and the emergency flag against the care team"); }
  });
  await run(mkApp({ ELEVENLABS_API_KEY: "k-test" }), async port => {
    let a = await call(port, "GET", "/api/eleven-session?agent=chat&patient=PT-1"); ok(a.s === 503 && /ELEVENLABS_CHAT_AGENT_ID/.test(a.j.error), "chat agent not configured -> 503 so the phone falls back to the passage " + a.b);
    a = await call(port, "GET", "/api/health"); ok(a.j.elevenlabsChat === false, "health says chat is off");
  });
  global.fetch = realFetch;
  console.log(bad ? bad + " FAILED" : "convo tests passed"); process.exit(bad ? 1 : 0);
})();
