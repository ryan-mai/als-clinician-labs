"use strict";
// Control vs ALS reference values (from the NeuroMotion biomarker table) and the logic that places a patient against them. Pure; node + browser.
// Each band is {lo, hi} or a point {v}; points count as "inside" within +-15%. Where the source table was unclear the row carries `confirm` so the page can say so.
(function (root) {
  const C = (lo, hi, text) => ({ lo, hi, text }), P = (v, text) => ({ v, text });
  const SECTIONS = [
    { id: "physical", title: "Physical measures", note: "ALS typically weakens and wastes the thenar (thumb-base) hand muscles and affects hand muscles unevenly, often on one side.", rows: [
      { id: "grip", name: "Grip strength", unit: "kg", axis: [0, 60], metrics: ["grip_kg_r", "grip_kg_l"], pick: "min", control: P(48, "About 48 kg"), als: P(13.9, "13.9 kg") },
      { id: "pinch", name: "Key pinch", unit: "kg", axis: [0, 14], metrics: ["pinch_kg_r", "pinch_kg_l"], pick: "min", control: P(11, "About 11 kg"), als: C(2, 3, "2-3 kg") },
      { id: "wpm", name: "Speaking rate", unit: "words/min", axis: [90, 200], metrics: ["speech_wpm"], control: C(150, 190, "150-190 words/min"), als: C(119, 168, "119-168 words/min"), note: "Ranges overlap heavily: one reading alone does not separate the groups." },
      { id: "walk", name: "10 m walk", unit: "s", axis: [0, 30], metrics: ["walk10m_s"], control: C(0, 8, "Under 8 s"), als: C(7.5, 30, "7.5 to 25+ s") } ] },
    { id: "blood", title: "Blood biomarkers", rows: [
      { id: "nfl", name: "Serum neurofilament light chain", unit: "pg/mL", axis: [0, 250], metrics: ["nfl_pgml"], control: C(0, 15, "Below 15 pg/mL"), als: C(70, 218, "70-218 pg/mL") },
      { id: "ck", name: "Creatine kinase", unit: "U/L", axis: [0, 500], metrics: ["ck"], control: C(0, 195, "Below 195 U/L"), als: C(160, 240, "160-240 U/L") },
      { id: "trop", name: "High-sensitivity troponin T", unit: "ng/L", axis: [0, 25], metrics: ["troponin_t_ngl"], control: P(6, "6 ng/L"), als: P(16.5, "16.5 ng/L") },
      { id: "amylin", name: "Amylin (fasting)", unit: "pg/mL", axis: [0, 350], metrics: ["amylin_pgml"], control: P(156.78, "156.78 pg/mL"), als: P(285.41, "285.41 pg/mL") },
      { id: "glu", name: "Glutamate", unit: "µM", axis: [0, 45], metrics: ["glutamate_um"], control: P(10, "About 10 µM"), als: C(32.8, 38.59, "32.8-38.59 µM") },
      { id: "chol", name: "Choline", unit: "µmol/L", axis: [0, 9], metrics: ["choline_umol"], control: C(7.0, 7.3, "7.0-7.3 µmol/L"), als: P(1.8, "1.80 µmol/L") },
      { id: "baso", name: "Basophil count", unit: "×10⁹/L", axis: [0, 0.3], metrics: ["basophil_count"], control: C(0, 0.236, "0.118 ± 0.118"), als: C(0, 0.05, "0.025 ± 0.025") },
      { id: "eos", name: "Eosinophil count", unit: "×10⁹/L", axis: [0, 0.3], metrics: ["eosinophil_count"], control: C(0, 0.104, "0.052 ± 0.052"), als: C(0.048, 0.26, "0.154 ± 0.106") } ] },
    { id: "resp", title: "Respiratory", rows: [
      { id: "snip", name: "Respiratory pressure (SNIP)", unit: "cmH₂O", axis: [0, 120], metrics: ["snip_cmh2o"], control: C(47.9, 105.7, "76.8 ± 28.9 cmH₂O"), als: { text: "Below 70 cmH₂O" }, cutoff: 70, cutoffDir: "above-normal",
        confirm: "Source row said 'Blood oxygen'; read as SNIP with 70 as the normal cut-off. Please confirm." },
      { id: "fvc", name: "FVC, sitting up", unit: "% predicted", axis: [40, 120], metrics: ["fvc_sit_pct"], control: C(80, 120, "80-120%"), als: C(40, 80, "Below 80%"), confirm: "ALS value read as 'below 80%'. Please confirm." },
      { id: "fvcsup", name: "FVC, lying flat", unit: "% predicted", axis: [40, 120], metrics: ["fvc_sup_pct"], info: true, control: { text: "Compared as a drop from sitting" }, als: { text: "Compared as a drop from sitting" } },
      { id: "fvcdrop", name: "FVC drop lying flat vs sitting", unit: "%", axis: [0, 40], derive: v => (v.fvc_sit_pct > 0 && v.fvc_sup_pct != null ? 100 * (v.fvc_sit_pct - v.fvc_sup_pct) / v.fvc_sit_pct : null), needs: ["fvc_sit_pct", "fvc_sup_pct"], control: C(0, 10, "Within 10%"), als: C(10, 40, "Over 10% drop"), confirm: "Worked out from the two FVC rows. Please confirm." } ] },
    { id: "rule", title: "Genetic panel and rule-outs", note: "CSF (spinal tap) and muscle biopsy are used to rule out other neurological diseases, mainly Parkinson's (alpha-synuclein) and MS (oligoclonal bands, kappa free light chains). Low CSF VEGF may indicate progression of degeneration.", qualitative: [
      { id: "gen", name: "Genetic panel (C9orf72, SOD1, TARDBP, FUS + 28 genes)", control: "No pathogenic variant detected", als: "Some ALS patients carry a variant (e.g. SOD1); not all do", alex: "No pathogenic variant detected", tone: "neutral", say: "A negative panel does not rule out ALS." },
      { id: "vbf", name: "Venous blood flow", control: "-", als: "-", alex: null, tileOnly: true, say: "No reference values or result are recorded yet." },
      { id: "csf", name: "CSF: VEGF, alpha-synuclein, OCBs / kappa light chains", control: "-", als: "-", alex: null, say: "Pending. Would help rule out Parkinson's and MS." },
      { id: "bio", name: "Muscle biopsy", control: "-", als: "-", alex: null, say: "Pending. Used to rule out other neuromuscular disease." } ] },
  ];
  const WHY = {
    grip: "Hand squeeze strength. ALS weakens the hand, often more on one side.",
    pinch: "Thumb-to-finger strength. The thumb-base muscles are often hit early.",
    wpm: "How fast someone speaks. Slowing can point to weak speech muscles.",
    walk: "Time to walk 10 metres. Slower walking suggests leg weakness.",
    nfl: "A protein released when nerve cells are damaged. Higher in ALS.",
    ck: "A muscle enzyme that rises when muscle is breaking down.",
    trop: "A heart and muscle protein. Slightly higher in ALS, likely from muscle damage.",
    amylin: "A hormone released with insulin. Reported higher in ALS.",
    glu: "A nerve-signalling chemical. Too much is toxic to motor neurons.",
    chol: "A nutrient used to make nerve-signalling chemicals. Lower in ALS.",
    baso: "A type of white blood cell. Reported lower in ALS.",
    eos: "A type of white blood cell. Reported higher in ALS.",
    snip: "Sniff pressure, a test of how strong the breathing muscles are.",
    fvc: "How much air can be blown out. Falls as breathing muscles weaken.",
    fvcdrop: "Breathing worse lying flat points to a weak diaphragm.",
    fvcsup: "Air blown out while lying flat. The reference table compares it with the sitting value (see the drop).",
  };
  // importance for ALS at a glance (higher = shown earlier among markers in the same state)
  const WEIGHT = { nfl: 100, grip: 95, pinch: 90, fvc: 85, fvcdrop: 84, snip: 80, ck: 70, wpm: 65, walk: 60, fvcsup: 50, trop: 40, amylin: 35, glu: 30, chol: 28, baso: 20, eos: 20, gen: 45, csf: 30, bio: 25, vbf: 10 };
  const TIER = { als: 0, beyond: 0, "toward-als": 2, overlap: 3, "toward-control": 4, control: 5, info: 6, none: 7 };
  SECTIONS.forEach(sec => { (sec.rows || []).forEach(r => { r.why = WHY[r.id] || ""; r.weight = WEIGHT[r.id] || 0; }); (sec.qualitative || []).forEach(r => { r.weight = WEIGHT[r.id] || 0; }); });
  // Short status pill for a placed row (as returned inside evaluate()): Normal / Borderline / High / Low / No data
  function pill(row) {
    const p = row.placed, v = row.value;
    if (p.state === "info") return { text: v == null ? "No data" : "See drop", dark: false };
    if (p.state === "none") return { text: "No data", dark: false };
    if (p.state === "control") return { text: "Normal", dark: false };
    if (p.state === "toward-control" || p.state === "toward-als" || p.state === "overlap") return { text: "Borderline", dark: false };
    if (row.cutoff != null) return { text: (row.cutoffDir === "above-normal" ? v < row.cutoff : v > row.cutoff) ? "Low" : "High", dark: true };
    const c = row.control, lo = c.v != null ? c.v : c.lo, hi = c.v != null ? c.v : c.hi;
    return { text: v > hi ? "High" : v < lo ? "Low" : "Abnormal", dark: true };
  }
  const band = (b, tol) => (b.v != null ? { lo: b.v * (1 - tol), hi: b.v * (1 + tol), point: true } : b.lo != null ? { lo: b.lo, hi: b.hi } : null);
  const dist = (v, b) => (v < b.lo ? b.lo - v : v > b.hi ? v - b.hi : 0);
  // value (number) against one numeric row -> {state, label, tone}
  function place(row, value) {
    if (row.info) return { state: "info", label: value == null ? "Not measured yet" : "See FVC drop", tone: value == null ? "none" : "neutral" };
    if (value == null || !isFinite(value)) return { state: "none", label: "Not measured yet", tone: "none" };
    if (row.cutoff != null && !row.als.lo && row.als.v == null) { const low = row.cutoffDir === "above-normal" ? value < row.cutoff : value > row.cutoff; return low ? { state: "als", label: `Below the ${row.cutoff} cut-off`, tone: "bad" } : { state: "control", label: "Normal range", tone: "ok" }; }
    const c = band(row.control, .15), a = band(row.als, .15), inC = dist(value, c) === 0, inA = dist(value, a) === 0;
    if (inC && inA) return { state: "overlap", label: "In both ranges", tone: "neutral" };
    if (inA) return { state: "als", label: "In the ALS range", tone: "bad" };
    if (inC) return { state: "control", label: "In the control range", tone: "ok" };
    const lo = Math.min(c.lo, a.lo), hi = Math.max(c.hi, a.hi);
    if (value > hi) return { state: "beyond", label: "Above both ranges", tone: "warn" };
    if (value < lo) return { state: "beyond", label: "Below both ranges", tone: "warn" };
    return dist(value, a) < dist(value, c) ? { state: "toward-als", label: "Closer to ALS", tone: "warn" } : { state: "toward-control", label: "Closer to control", tone: "ok" };
  }
  // values: {metric_id: number}. Returns each numeric row with Alex's value(s), placement; plus an evidence summary.
  function evaluate(values) {
    const sections = SECTIONS.map(sec => ({ ...sec, rows: (sec.rows || []).map(row => {
      let vals = row.derive ? (row.needs.every(k => values[k] != null) ? [row.derive(values)] : []) : row.metrics.map(k => values[k]).filter(v => v != null && isFinite(v));
      const shown = row.derive ? vals : row.metrics.map(k => values[k]), v = vals.length ? (row.pick === "min" ? Math.min(...vals) : vals[0]) : null;
      return { ...row, shown, value: v, placed: place(row, v) };
    }) }));
    const all = sections.flatMap(s => s.rows).filter(r => !r.info), meas = all.filter(r => r.placed.state !== "none"), n = st => meas.filter(r => st.includes(r.placed.state)).length;
    return { sections, summary: { measured: meas.length, total: all.length, inAls: n(["als"]), towardAls: n(["toward-als"]), beyond: n(["beyond"]), control: n(["control", "toward-control"]), overlap: n(["overlap"]),
      notMeasured: all.filter(r => r.placed.state === "none").map(r => r.name) } };
  }
  // order for display: abnormal first, then by clinical importance; "tier" overrides let qualitative tiles slot in
  const rank = (state, weight) => (TIER[state] ?? 7) * 1000 - weight;
  const api = { SECTIONS, place, evaluate, pill, rank };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Reference = api;
})(typeof window !== "undefined" ? window : globalThis);
