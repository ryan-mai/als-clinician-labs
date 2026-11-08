"use strict";
// Turns a dictated sentence into measurements, e.g. "grip left 28 right 31, FVC sitting 74 supine 61, SNIP 52".
// Fallback / confirm-card for the voice agent. Pure; node + browser. Always show the result to the clinician to confirm before saving.
(function (root) {
  const NUM = "(\\d+(?:\\.\\d+)?)";
  function parse(text) {
    const s = String(text || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " "), out = {}, notes = [];
    const win = (re) => { const m = re.exec(s); if (!m) return null; const rest = s.slice(m.index + m[0].length), next = rest.search(/\b(grip|fvc|vital capacity|snip|sniff|alsfrs|walk|nfl|neurofilament|ck|creatine)\b/); return next < 0 ? rest : rest.slice(0, next); };
    const sidePairs = (w, f) => { const re1 = new RegExp("\\b(left|right)\\b\\D{0,14}?" + NUM, "g"), re2 = new RegExp(NUM + "\\s*(?:kg|kilos?|kilograms?)?\\s*(?:on the |for the |in the )?\\b(left|right)\\b", "g"); let m, got = false;
      while ((m = re1.exec(w))) { f(m[1][0], +m[2]); got = true; } if (!got) while ((m = re2.exec(w))) f(m[2][0], +m[1]); };
    let w = win(/\bgrip(?: strength)?\b/);
    if (w != null) { let any = false;
      for (const m of s.matchAll(new RegExp("\\b(left|right)\\s+grip(?: strength)?\\D{0,10}?" + NUM, "g"))) { out["grip_kg_" + m[1][0]] = +m[2]; any = true; }
      sidePairs(w, (side, v) => { out["grip_kg_" + side] = v; any = true; }); if (!any) notes.push("grip: say left and right values"); }
    w = win(/\b(?:fvc|vital capacity)\b/);
    if (w != null) { let any = false; const sup = new RegExp("\\b(?:supine|lying)\\b\\D{0,14}?" + NUM).exec(w), sit = new RegExp("\\b(?:sitting|seated|upright|sit)\\b\\D{0,14}?" + NUM).exec(w);
      if (sup) { out.fvc_sup_pct = +sup[1]; any = true; } if (sit) { out.fvc_sit_pct = +sit[1]; any = true; }
      if (!any) { const n = new RegExp(NUM).exec(w); if (n) { out.fvc_sit_pct = +n[1]; any = true; notes.push("fvc: assumed sitting"); } } if (!any) notes.push("fvc: no value heard"); }
    const one = (re, key, label) => { const ww = win(re); if (ww == null) return; const n = new RegExp(NUM).exec(ww); n ? out[key] = +n[1] : notes.push(label + ": no value heard"); };
    one(/\b(?:snip|sniff)\b/, "snip_cmh2o", "snip");
    one(/\balsfrs(?:[- ]?r)?\b/, "alsfrs_r", "alsfrs");
    one(/\bwalk\b/, "walk10m_s", "walk");
    one(/\b(?:nfl|neurofilament)\b/, "nfl_pgml", "nfl");
    one(/\b(?:ck|creatine kinase|creatine)\b/, "ck", "ck");
    return { values: out, notes };
  }
  const api = { parse };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Dictation = api;
})(typeof window !== "undefined" ? window : globalThis);
