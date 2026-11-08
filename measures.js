"use strict";
// Measurement registry, validation, trend engine. Pure (node + browser). One record = one reading:
//   { patient, metric, value, t (ms epoch), source: companion|clinic|lab|import, session?, quality? }
// "Higher is better" metrics are compared as latest/baseline; "lower is better" as baseline/latest, so a score under 100 always means worse.
(function (root) {
  const M = (label, unit, good, min, max, region, o = {}) => ({ label, unit, good, min, max, region, status: true, score: false, ...o });
  const METRICS = {};
  for (const [s, R] of [["r", "handR"], ["l", "handL"]]) {
    METRICS["grip_rate_" + s] = M("Fist rate", "/s", "higher", .1, 8, R);
    METRICS["grip_amp_" + s] = M("Fist range", "palm lengths", "higher", .05, 5, R, { score: true });
    METRICS["grip_speed_" + s] = M("Fist closing speed", "palm lengths/s", "higher", .05, 50, R);
    METRICS["grip_decrement_" + s] = M("Fist fatigue", "%", "higher", -100, 100, R, { status: false });
    METRICS["grip_kg_" + s] = M("Grip strength", "kg", "higher", 0, 120, R, { score: true });
    METRICS["pinch_kg_" + s] = M("Key pinch", "kg", "higher", 0, 40, R, { score: true });
    METRICS["grip_score_" + s] = M("Fist strength score (camera)", "score", "higher", .01, 100, R, { score: true });
    METRICS["pinch_score_" + s] = M("Pinch strength score (camera)", "score", "higher", .01, 100, R, { score: true });
  }
  for (const [s, R] of [["r", "footR"], ["l", "footL"]]) {
    METRICS["foot_rate_" + s] = M("Toe-lift rate", "/s", "higher", .1, 8, R);
    METRICS["foot_amp_" + s] = M("Toe-lift range", "deg", "higher", 1, 120, R, { score: true });
    METRICS["foot_speed_" + s] = M("Toe-lift speed", "deg/s", "higher", 1, 2000, R);
    METRICS["foot_decrement_" + s] = M("Toe-lift fatigue", "%", "higher", -100, 100, R, { status: false });
  }
  Object.assign(METRICS, {
    speech_wpm: M("Speaking rate", "words/min", "higher", 20, 300, "bulbar", { score: true }),
    troponin_t_ngl: M("hs-Troponin T", "ng/L", "lower", 0, 500, null, { status: false }),
    amylin_pgml: M("Amylin", "pg/mL", "lower", 0, 2000, null, { status: false }),
    glutamate_um: M("Glutamate", "uM", "lower", 0, 200, null, { status: false }),
    choline_umol: M("Choline", "umol/L", "higher", 0, 50, null, { status: false }),
    basophil_count: M("Basophil count", "x10^9/L", "higher", 0, 5, null, { status: false }),
    eosinophil_count: M("Eosinophil count", "x10^9/L", "lower", 0, 5, null, { status: false }),
    vowel_vsa: M("Vowel space area", "kHz^2", "higher", .005, 3, "bulbar", { score: true }),
    vowel_vcr: M("Vowel centralization", "ratio", "lower", .3, 3, "bulbar"),
    lip_range: M("Lip spread range", "eye widths", "higher", .01, 2, "bulbar"),
    jaw_speed: M("Jaw movement speed", "eye widths/s", "higher", .01, 30, "bulbar"),
    ddk_rate: M("Speech rate (pa-ta-ka)", "syll/s", "higher", 1, 12, "bulbar", { score: true }),
    ddk_cv: M("Speech rhythm variability", "%", "lower", 0, 100, "bulbar"),
    ddk_pauses: M("Speech pauses", "count", "lower", 0, 50, "bulbar", { status: false }),
    mpt_s: M("Sustained vowel", "s", "higher", .5, 60, "bulbar"),
    gait_cadence: M("Walking cadence", "steps/min", "higher", 40, 200, "legs"),
    gait_stride_cv: M("Stride variability", "%", "lower", .1, 50, "legs"),
    walk10m_s: M("10 m walk", "s", "lower", 2, 120, "legs", { source: "clinic" }),
    fvc_sit_pct: M("FVC sitting", "%", "higher", 0, 200, "chest"),
    fvc_sup_pct: M("FVC supine", "%", "higher", 0, 200, "chest"),
    snip_cmh2o: M("Respiratory pressure (SNIP)", "cmH2O", "higher", 0, 200, "chest"),
    alsfrs_r: M("ALSFRS-R", "pts", "higher", 0, 48, null, { status: false }),
    nfl_pgml: M("Serum NfL", "pg/mL", "lower", 0, 5000, null, { status: false }),
    ck: M("Creatine kinase", "U/L", "lower", 0, 50000, null, { status: false }),
  });
  const REGIONS = ["bulbar", "chest", "handR", "handL", "footR", "footL"];
  const SOURCES = ["companion", "clinic", "lab", "import"];
  const DAY = 864e5;

  function validate(rec, now = Date.now()) {
    const e = m => ({ ok: false, error: m });
    if (!rec || typeof rec !== "object") return e("record must be an object");
    const p = String(rec.patient || "").trim();
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(p)) return e("patient must be a 2-32 character de-identified code");
    if (/^\d{6,}$/.test(p)) return e("patient code looks like an MRN; use a de-identified code");
    const def = METRICS[rec.metric]; if (!def) return e("unknown metric: " + rec.metric);
    const v = Number(rec.value); if (!isFinite(v) || rec.value === null || rec.value === "" || typeof rec.value === "boolean") return e("value must be a number");
    if (v < def.min || v > def.max) return e(`${rec.metric} ${v} outside plausible range ${def.min} to ${def.max} ${def.unit}`);
    const t = rec.t == null ? now : typeof rec.t === "string" ? Date.parse(rec.t) : Number(rec.t);
    if (!isFinite(t)) return e("bad timestamp"); if (t > now + DAY || t < now - 3 * 365 * DAY) return e("timestamp outside the last 3 years");
    const source = rec.source || "companion"; if (!SOURCES.includes(source)) return e("unknown source: " + source);
    const q = rec.quality && typeof rec.quality === "object" ? { valid: rec.quality.valid !== false, note: String(rec.quality.note || "").slice(0, 200) } : undefined;
    return { ok: true, rec: { patient: p, metric: rec.metric, value: v, t: Math.round(t), source, session: rec.session ? String(rec.session).slice(0, 64) : undefined, quality: q } };
  }
  // many readings from one session -> records (invalid ones listed in errors, valid ones kept)
  function fromSession(patient, values, opts = {}) {
    const t = opts.t ?? Date.now(), session = opts.session || `${patient}-${t}`, recs = [], errors = [];
    for (const [metric, value] of Object.entries(values || {})) {
      const r = validate({ patient, metric, value, t, source: opts.source || "companion", session, quality: opts.quality }, opts.now);
      r.ok ? recs.push(r.rec) : errors.push(`${metric}: ${r.error}`);
    }
    return { recs, errors };
  }

  const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function theilSen(pts) {        // robust slope (value per ms) over [{t, v}]
    const p = pts.slice(-120), s = []; for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[j].t > p[i].t) s.push((p[j].v - p[i].v) / (p[j].t - p[i].t));
    return s.length ? med(s) : 0;
  }
  function series(recs, patient, metric) {
    return recs.filter(r => r.patient === patient && r.metric === metric && !(r.quality && r.quality.valid === false)).sort((a, b) => a.t - b.t).map(r => ({ t: r.t, v: r.value, source: r.source }));
  }
  function weekly(s) {            // [{week, v (median), n}] weeks counted from the first reading
    if (!s.length) return []; const t0 = s[0].t, w = {}; for (const x of s) (w[Math.floor((x.t - t0) / (7 * DAY))] = w[Math.floor((x.t - t0) / (7 * DAY))] || []).push(x.v);
    return Object.keys(w).map(Number).sort((a, b) => a - b).map(k => ({ week: k + 1, v: med(w[k]), n: w[k].length }));
  }
  function metricSummary(s, def) {
    const n = s.length; if (!n) return null;
    const base = med(s.filter(x => x.t - s[0].t < 7 * DAY).map(x => x.v)), latest = med(s.filter(x => s[n - 1].t - x.t < 7 * DAY).map(x => x.v));   // first week vs last week of readings
    const span = (s[n - 1].t - s[0].t) / DAY, sign = def.good === "higher" ? 1 : -1;
    const pct = !(base > 0) || !(latest > 0) ? NaN : 100 * (def.good === "higher" ? latest / base : base / latest);
    const slopeWk = n >= 4 && span >= 14 && base > 0 ? sign * 100 * theilSen(s.map(x => ({ t: x.t, v: x.v }))) * 7 * DAY / base : null;   // % of baseline per week; negative = getting worse
    let status = "none"; if (def.status && n >= 3 && isFinite(pct)) {
      status = (pct < 85 || (slopeWk != null && slopeWk < -3)) ? "bad" : (pct < 95 || (slopeWk != null && slopeWk < -1.5)) ? "warn" : "ok";
    }
    return { n, baseline: base, latest, last: s[n - 1].v, lastT: s[n - 1].t, pctOfBaseline: pct, slopePctPerWeek: slopeWk, spanDays: span, status };
  }
  const RANK = { none: 0, ok: 1, warn: 2, bad: 3 };
  function summary(recs, patient) {
    const metrics = {}; for (const id of Object.keys(METRICS)) { const m = metricSummary(series(recs, patient, id), METRICS[id]); if (m) metrics[id] = m; }
    const regions = {}; for (const r of REGIONS) regions[r] = "none";
    for (const [id, m] of Object.entries(metrics)) { const rg = METRICS[id].region; if (!rg) continue;
      const st = rg === "legs" && m.status === "bad" ? "warn" : m.status;   // walking is bilateral: it can raise a leg to "watch" but not blame one side
      for (const r of rg === "legs" ? ["footR", "footL"] : [rg]) if (RANK[st] > RANK[regions[r]]) regions[r] = st; }
    const sc = Object.entries(metrics).filter(([id, m]) => METRICS[id].score && isFinite(m.pctOfBaseline)).map(([, m]) => Math.max(0, Math.min(120, m.pctOfBaseline)));
    const asym = []; for (const [k, name] of [["grip_kg", "Grip strength"], ["grip_amp", "Fist range"], ["foot_amp", "Toe-lift range"]]) {
      const r = metrics[k + "_r"], l = metrics[k + "_l"]; if (r && l && l.latest > 0) asym.push({ name, r: r.latest, l: l.latest, ratio: r.latest / l.latest }); }
    return { patient, metrics, regions, motorScore: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null, asymmetry: asym, activity: activity(recs, patient) };
  }
  // companion activity: distinct sessions, XP, streak of consecutive local days (today may still be pending)
  function activity(recs, patient, now = Date.now(), tzOffsetMin = new Date().getTimezoneOffset()) {
    const mine = recs.filter(r => r.patient === patient && r.source === "companion"), sess = new Set(mine.map(r => r.session || r.t));
    const dayOf = t => Math.floor((t - tzOffsetMin * 6e4) / DAY), days = new Set(mine.map(r => dayOf(r.t)));
    let d = dayOf(now), streak = 0; if (!days.has(d)) d--; while (days.has(d)) { streak++; d--; }
    return { sessions: sess.size, xp: sess.size * 10, streak, daysActive: days.size, doneToday: days.has(dayOf(now)) };
  }
  const api = { METRICS, REGIONS, SOURCES, validate, fromSession, series, weekly, summary, activity, theilSen, median: med };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Measures = Object.assign(root.Measures || {}, api);
})(typeof window !== "undefined" ? window : globalThis);
