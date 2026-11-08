"use strict";
// Speaking rate from a free conversation instead of a fixed passage. Pure; node + browser.
//
// The patient chats with a voice assistant that asks the doctor's questions. We do not know in advance what they will say, so:
//   words = what the speech-to-text heard the PATIENT say (user transcripts only, never the assistant's)
//   time  = how long the patient was actually speaking: only while the assistant is listening (not talking), in continuous
//           stretches. A silence longer than SPLIT_MS (thinking, waiting) ends a stretch and is not counted; shorter pauses stay in,
//           because they are part of how someone speaks. The first GUARD_MS after the assistant stops are ignored so its voice
//           tail, picked up by the microphone, is not mistaken for the patient.
//   speaking rate = total words / total speaking time, in words per minute.
// Conversational rate is not the same as reading rate: compare a patient with their own earlier conversations, not with passage-reading ranges.
(function (root) {
  const GUARD_MS = 400, SPLIT_MS = 2000, HOP_MS = 50, MIN_CHUNK_S = 0.4, MIN_WORDS = 30, MIN_SPEECH_S = 15;
  // Suggested questions: open and friendly, but each one invites a few sentences. Doctors can replace them per patient (triage page).
  const DEFAULT_QUESTIONS = [
    "How has your day been so far? What have you been up to?",
    "Tell me about something you are looking forward to this week.",
    "Has anything felt different lately, with your speech, swallowing, hands, walking or breathing?",
    "Is there anything you have been finding harder than usual?",
    "Is there anything you would like your care team to know before your next visit?",
  ];
  const MAX_QUESTIONS = 12, MAX_QUESTION_LEN = 220;
  // Tidy a list typed by a doctor: trim, drop empties and control characters, cap the length and count. Returns {questions, dropped}.
  function cleanQuestions(list) {
    const src = Array.isArray(list) ? list : String(list == null ? "" : list).split(/\r?\n/), out = []; let dropped = 0;
    for (const q of src) {
      const t = String(q == null ? "" : q).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
      if (!t) continue; if (t.length < 3 || out.length >= MAX_QUESTIONS) { dropped++; continue; } out.push(t.slice(0, MAX_QUESTION_LEN));
    }
    return { questions: out, dropped };
  }
  const numbered = qs => qs.map((q, i) => `${i + 1}. ${q}`).join("\n");

  // Patient onboarding on the phone (first check-in only). The symptom questionnaire itself comes from triage.js; this file owns the interests list and the consent check.
  // Interests: [id, title, sub]. The server only accepts these ids.
  const ONBOARD = {
    matters: [["family", "Time with family", "Meals, visits, the people around you"], ["cooking", "Cooking and food", "Making and sharing meals"], ["work", "Work or teaching", "Your job or something you do for others"], ["hobbies", "Hobbies and making things", "Music, crafts, reading, games"], ["outdoors", "Being outdoors", "Walks, gardening, fresh air"], ["travel", "Travel and visiting", "Trips and seeing friends"]],
  };
  // -> {ok, value:{matters[], consent}} or {ok:false, error}. Unknown interest ids are an error and consent must be exactly true.
  function cleanOnboarding(b) {
    b = b && typeof b === "object" ? b : {}; let matters = [];
    if (b.matters != null) { if (!Array.isArray(b.matters)) return { ok: false, error: "unknown option" }; const ids = ONBOARD.matters.map(x => x[0]);
      for (const v of b.matters) { if (typeof v !== "string" || !ids.includes(v)) return { ok: false, error: "unknown option" }; if (!matters.includes(v)) matters.push(v); } }
    if (b.consent !== true) return { ok: false, error: "please confirm you are happy to go ahead" };
    return { ok: true, value: { matters, consent: true } };
  }
  // what the assistant is told about the patient (as a dynamic variable): their interests only, in plain words
  const interestsText = ids => { const t = (Array.isArray(ids) ? ids : []).map(id => (ONBOARD.matters.find(x => x[0] === id) || [])[1]).filter(Boolean).map(s => s.toLowerCase()); return t.length ? t.join(", ") : "nothing specific shared"; };

  // Words in a transcript. "don't" and "mother-in-law" are one word each; stage directions such as (laughs) or [pause] are not words.
  function countWords(text) {
    const t = String(text == null ? "" : text).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ");
    return (t.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  }

  // Feed it, in time order (t in milliseconds, any clock): mode("speaking"|"listening", t) when the assistant starts/stops talking,
  // sample(active, t) about every 50 ms (is the patient making sound right now), text(transcript) for each patient transcript.
  function createTracker(o = {}) {
    const guard = o.guardMs ?? GUARD_MS, split = o.splitMs ?? SPLIT_MS, hop = o.hopMs ?? HOP_MS;
    let mode = "speaking", since = 0, win = 0; const acts = [], counts = [];       // the assistant speaks first, so we start in its turn
    const words = () => counts.reduce((a, b) => a + b, 0);
    function chunks() {                                                         // [[startMs, endMs], ...] of continuous patient speech
      const out = []; let cur = null;
      for (const a of acts) { if (cur && a.win === cur.win && a.t - cur.b <= split) cur.b = a.t; else { if (cur) out.push(cur); cur = { win: a.win, a: a.t, b: a.t }; } }
      if (cur) out.push(cur);
      return out.map(c => [c.a, c.b + hop, c.win]).filter(c => (c[1] - c[0]) / 1000 >= MIN_CHUNK_S);
    }
    return {
      mode(m, t) { if (m !== "speaking" && m !== "listening") return; if (m === mode) return; mode = m; if (m === "listening") { since = t; win++; } },
      sample(active, t) { if (active && mode === "listening" && t - since >= guard) acts.push({ t, win }); },
      text(s) { const n = countWords(s); if (n) counts.push(n); },
      words, chunks,
      speechS() { return chunks().reduce((s, c) => s + (c[1] - c[0]) / 1000, 0); },
      result() {
        const ch = chunks(), speechS = ch.reduce((s, c) => s + (c[1] - c[0]) / 1000, 0), w = words(), reasons = [];
        const out = { valid: false, reasons, words: w, speechS, chunks: ch.map(c => [c[0], c[1]]), turns: new Set(ch.map(c => c[2])).size };
        if (w < MIN_WORDS) reasons.push(`We only heard ${w} words from you. A little more chatting would help`);
        else if (speechS < MIN_SPEECH_S) reasons.push(`We only measured ${speechS.toFixed(0)} seconds of you speaking, and need ${MIN_SPEECH_S}`);
        if (w && speechS > 0) out.wpm = w / (speechS / 60);
        if (!reasons.length && !(out.wpm >= 40 && out.wpm <= 300)) reasons.push("Implausible rate: " + (out.wpm || 0).toFixed(0) + " words/min. The assistant's voice may have been picked up; try earphones");
        out.valid = reasons.length === 0; return out;
      },
    };
  }
  // Keep only camera frames recorded while the patient was speaking (frame.t is seconds since t0Ms, a performance.now() value). Mouth movement while
  // listening to the assistant would dilute the jaw-speed measure.
  const framesIn = (frames, chunksMs, t0Ms, padMs = 100) => frames.filter(f => { const t = t0Ms + f.t * 1000; return chunksMs.some(c => t >= c[0] - padMs && t <= c[1] + padMs); });
  const toValues = m => ({ speech_wpm: Math.round(m.wpm) });
  const api = { createTracker, countWords, cleanQuestions, numbered, framesIn, toValues, ONBOARD, cleanOnboarding, interestsText, DEFAULT_QUESTIONS, MAX_QUESTIONS, MAX_QUESTION_LEN, GUARD_MS, SPLIT_MS, MIN_WORDS, MIN_SPEECH_S };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Convo = api;
})(typeof window !== "undefined" ? window : globalThis);
