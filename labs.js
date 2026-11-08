"use strict";
// Lab-biomarker scoring + storage. Scoring is pure (testable in node); storage is Supabase REST if configured, else localStorage.
(function (root) {
  const normCdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  // NfL: age-adjust against controls, then report z and where the value sits among ALS and control residuals (empirical, from the Kim cohorts)
  function scoreNfl(ref, age, value) {
    const n = ref.nefl, expected = n.ctl_intercept + n.ctl_age_slope * age, resid = value - expected;
    const z = resid / n.ctl_resid_sd, pct = a => 100 * a.filter(x => x <= resid).length / a.length;
    const pc = pct(n.ctl_resid_sorted), pa = pct(n.als_resid_sorted);
    let band = z < 1 ? "within control range for age" : z < 2 ? "mildly above controls" : "well above controls";
    return { analyte: "nefl", value, expected, resid, z, pctControls: pc, pctAls: pa, band, flag: z >= 2 };
  }
  function scoreRoutine(ref, id, value) {
    const l = ref.labs.find(x => x.id === id); if (!l) return null;
    const flag = l.lo == null || l.hi == null ? "no reference range" : value < l.lo ? "low" : value > l.hi ? "high" : "in range";
    return { analyte: id, name: l.name, unit: l.unit, value, lo: l.lo, hi: l.hi, flag, als: l.als, note: l.note };
  }
  function scorePatient(ref, p) {
    const out = [], L = p.labs || {};
    if (L.nefl != null && !isNaN(L.nefl)) out.push(scoreNfl(ref, p.age, +L.nefl));
    for (const l of ref.labs) if (L[l.id] != null && !isNaN(L[l.id])) out.push(scoreRoutine(ref, l.id, +L[l.id]));
    return out;
  }
  // storage
  const cfg = () => root.SUPABASE_CONFIG || {}, remote = () => !!(cfg().url && cfg().anonKey);
  const hdr = () => ({ apikey: cfg().anonKey, Authorization: "Bearer " + cfg().anonKey, "Content-Type": "application/json", Prefer: "return=representation" });
  const lsX = () => { try { return JSON.parse(localStorage.getItem("als_labs_extra") || "{}"); } catch (e) { return {}; } };
  const sessionsOf = (x, code) => { const v = x[code]; return !v ? [] : Array.isArray(v) ? v : [{ t: null, period: null, labs: v }]; };   // old format was a plain {analyte: value} object
  const periodOf = d => { const h = d.getHours(); return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"; };
  const lsGet = () => { try { return JSON.parse(localStorage.getItem("als_labs_pts") || "[]"); } catch (e) { return []; } };
  const lsSet = v => { try { localStorage.setItem("als_labs_pts", JSON.stringify(v)); } catch (e) {} };
  async function listPatients(bundled) {
    if (remote()) {
      const r = await fetch(cfg().url + "/rest/v1/patients?select=*,lab_results(analyte,value,collected_at,created_at,period)&order=code", { headers: hdr() });
      if (!r.ok) throw new Error("Supabase " + r.status);
      return (await r.json()).map(p => ({ code: p.code, age: p.age, sex: p.sex, synthetic: p.synthetic, label: p.label, alsfrs_r: p.alsfrs_r,
        labs: Object.fromEntries(p.lab_results.sort((a, b) => a.created_at < b.created_at ? -1 : 1).map(x => [x.analyte, x.value])),
        history: Object.values(p.lab_results.reduce((m, x) => { (m[x.created_at] = m[x.created_at] || { t: x.created_at, period: x.period, labs: {} }).labs[x.analyte] = x.value; return m; }, {})).sort((a, b) => a.t < b.t ? -1 : 1) }));
    }
    const x = lsX(); return bundled.concat(lsGet()).map(p => { const ss = sessionsOf(x, p.code); return ss.length ? { ...p, labs: Object.assign({}, p.labs, ...ss.map(s => s.labs)), history: ss } : p; });
  }
  async function savePatient(p) {   // p: {code, age, sex, alsfrs_r, labs}; always marked synthetic in the demo
    if (remote()) {
      let r = await fetch(cfg().url + "/rest/v1/patients?on_conflict=code", { method: "POST", headers: { ...hdr(), Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ code: p.code, age: p.age, sex: p.sex, synthetic: true, alsfrs_r: p.alsfrs_r ?? null }) });
      if (!r.ok) throw new Error("Supabase patient " + r.status);
      const id = (await r.json())[0].id;
      const rows = Object.entries(p.labs).filter(([, v]) => v != null && !isNaN(v)).map(([analyte, value]) => ({ patient_id: id, analyte, value }));
      r = await fetch(cfg().url + "/rest/v1/lab_results", { method: "POST", headers: hdr(), body: JSON.stringify(rows) });
      if (!r.ok) throw new Error("Supabase labs " + r.status);
      return;
    }
    const all = lsGet().filter(x => x.code !== p.code); all.push({ ...p, synthetic: true }); lsSet(all);
  }
  // add results to an EXISTING patient code (patient-side tests); never creates patients or changes age/sex
  async function addResults(code, labs, meta = {}) {
    const period = meta.period || periodOf(new Date());
    const rows = Object.entries(labs).filter(([, v]) => v != null && !isNaN(v));
    if (!rows.length) throw new Error("No values to save");
    if (remote()) {
      let r = await fetch(cfg().url + "/rest/v1/patients?select=id&code=eq." + encodeURIComponent(code), { headers: hdr() });
      if (!r.ok) throw new Error("Supabase " + r.status);
      const f = await r.json(); if (!f.length) throw new Error("Unknown patient code");
      r = await fetch(cfg().url + "/rest/v1/lab_results", { method: "POST", headers: hdr(), body: JSON.stringify(rows.map(([analyte, value]) => ({ patient_id: f[0].id, analyte, value, period }))) });
      if (!r.ok) throw new Error("Supabase labs " + r.status); return;
    }
    const known = (await listPatients([])).some(p => p.code === code) || !!(await fetch("synthetic_patients.json").then(x => x.json()).catch(() => [])).find(p => p.code === code);
    if (!known) throw new Error("Unknown patient code");
    const x = lsX(); x[code] = sessionsOf(x, code).concat([{ t: new Date().toISOString(), period, labs: Object.fromEntries(rows) }]); try { localStorage.setItem("als_labs_extra", JSON.stringify(x)); } catch (e) {}
  }
  root.Labs = { periodOf, addResults, scorePatient, scoreNfl, scoreRoutine, listPatients, savePatient, isRemote: remote, normCdf };
  if (typeof module !== "undefined") module.exports = root.Labs;
})(typeof window !== "undefined" ? window : globalThis);

// ---- aggregation + CSV (pure; works on the patient list from listPatients) ----
(function (root) {
  const L = root.Labs, IDS = ["nefl", "creatinine", "ck", "albumin", "uric_acid", "bicarbonate", "crp",
    ...["grip", "foot"].flatMap(k => ["rate", "amp", "speed", "decrement"].flatMap(m => ["r", "l"].map(s => `${k}_${m}_${s}`))),
    "nfl_pgml", "grip_kg_r", "grip_kg_l", "walk10m_s", "fvc_sit_pct", "fvc_supine_pct", "snip_cmh2o"];
  const CAM = /^(grip|foot)_(rate|amp|speed|decrement)_(r|l)$/;
  const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  // Per analyte: n, median, IQR, % flagged (NfL z>=2; routine out of range). Optionally split by synthetic label.
  L.aggregate = function (ref, pts) {
    const rows = IDS.map(id => {
      const sc = pts.map(p => (L.scorePatient(ref, p).find(r => r.analyte === id) || null)).filter(Boolean);
      const vals = sc.map(r => id === "nefl" ? r.z : r.value), flagged = sc.filter(r => id === "nefl" ? r.flag : (r.flag === "low" || r.flag === "high")).length;
      const byLabel = {}; for (const p of pts) { const r = L.scorePatient(ref, p).find(x => x.analyte === id); if (!r || !p.label) continue;
        (byLabel[p.label] = byLabel[p.label] || []).push(id === "nefl" ? r.z : r.value); }
      return { id, n: vals.length, median: q(vals, .5), q1: q(vals, .25), q3: q(vals, .75), pctFlagged: sc.length ? 100 * flagged / sc.length : NaN,
        byLabel: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, { n: v.length, median: q(v, .5) }])) };
    });
    return { n_patients: pts.length, rows };
  };
  // CSV: header code,age,sex,alsfrs_r,nefl,creatinine,... ; returns {patients, errors}
  L.parseCsv = function (text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean), errors = [], patients = [];
    if (lines.length < 2) return { patients, errors: ["Need a header row and at least one data row."] };
    const h = lines[0].split(",").map(x => x.trim().toLowerCase());
    for (const need of ["code", "age"]) if (!h.includes(need)) return { patients, errors: ["Missing column: " + need] };
    lines.slice(1).forEach((ln, i) => {
      const c = ln.split(",").map(x => x.trim()), o = Object.fromEntries(h.map((k, j) => [k, c[j]])), labs = {};
      for (const id of IDS) if (o[id] !== undefined && o[id] !== "") { const v = +o[id]; if (isNaN(v)) errors.push(`Row ${i + 2}: ${id} is not a number`); else labs[id] = v; }
      const age = +o.age;
      if (!o.code) errors.push(`Row ${i + 2}: missing code`); else if (!(age >= 0 && age <= 120)) errors.push(`Row ${i + 2}: bad age`);
      else if (/^\d{6,}$/.test(o.code)) errors.push(`Row ${i + 2}: code looks like an MRN; use a de-identified code`);
      else if (!Object.keys(labs).length) errors.push(`Row ${i + 2}: no lab values`);
      else patients.push({ code: o.code, age, sex: o.sex === "F" || o.sex === "M" ? o.sex : "X", alsfrs_r: o.alsfrs_r ? +o.alsfrs_r : null, labs });
    });
    return { patients, errors };
  };
  L.toCsv = pts => ["code,age,sex,alsfrs_r," + IDS.join(","), ...pts.map(p => [p.code, p.age, p.sex, p.alsfrs_r ?? "", ...IDS.map(i => p.labs[i] ?? "")].join(","))].join("\n");
  // ---- camera-test views: one row per (session, test, side) ----
  L.isCamera = id => CAM.test(id);
  L.cameraRows = function (history) {
    const rows = [];
    for (const h of history || []) { const g = {};
      for (const [id, v] of Object.entries(h.labs || {})) { const m = CAM.exec(id); if (m) { const k = m[1] + "_" + m[3]; (g[k] = g[k] || { t: h.t, period: h.period, kind: m[1], side: m[3] })[m[2]] = v; } }
      rows.push(...Object.values(g)); }
    return rows;
  };
  // Latest morning session vs latest afternoon/evening session, per test and side: % change in range and speed
  L.diurnal = function (rows) {
    const out = [];
    for (const k of ["grip_r", "grip_l", "foot_r", "foot_l"]) {
      const r = rows.filter(x => x.kind + "_" + x.side === k), am = r.filter(x => x.period === "morning").pop(), pm = r.filter(x => x.period && x.period !== "morning").pop();
      if (am && pm) out.push({ key: k, kind: am.kind, side: am.side, ampChange: am.amp ? 100 * (pm.amp - am.amp) / am.amp : null, speedChange: am.speed ? 100 * (pm.speed - am.speed) / am.speed : null });
    }
    return out;
  };
  // Right/left ratios from the latest values (no flag: usual dominant-side differences are not defined here)
  L.asymmetry = function (labs) {
    const out = [], pair = (a, b, name) => { if (labs[a] != null && labs[b] != null && labs[b] > 0) out.push({ name, r: labs[a], l: labs[b], ratio: labs[a] / labs[b] }); };
    pair("grip_kg_r", "grip_kg_l", "Dynamometer grip (kg)");
    for (const [k, nm] of [["grip", "Fist"], ["foot", "Toe-lift"]]) for (const [m, mn] of [["rate", "rate"], ["amp", "range"], ["speed", "speed"]]) pair(`${k}_${m}_r`, `${k}_${m}_l`, `${nm} ${mn} (camera)`);
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);
