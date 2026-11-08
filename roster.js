"use strict";
// Care-team roster for the Patients page: one row per patient code with a status level, the biggest changes, a weekly trajectory,
// and cohort-level numbers for the charts and the Gemini summary. Pure functions (no I/O) so they can be tested.
const Measures = require("./measures.js");
const DAY = 864e5, WEEK = 7 * DAY, med = Measures.median;
const LEVELS = ["emergency", "declining", "watch", "steady", "early", "new"];
const REGION_GROUP = { bulbar: "Speech & face", handR: "Hands", handL: "Hands", footR: "Legs", footL: "Legs", chest: "Breathing" };
const clean = r => !(r.quality && r.quality.valid === false);

// Average % of the patient's own starting level across the score metrics, one point per week since their first reading.
function trajectory(recs) {
  if (!recs.length) return [];
  const t0 = Math.min(...recs.map(r => r.t)), by = {};
  for (const r of recs) if (clean(r) && Measures.METRICS[r.metric] && Measures.METRICS[r.metric].score) (by[r.metric] = by[r.metric] || []).push(r);
  const weeks = new Map();
  for (const [id, rs] of Object.entries(by)) {
    rs.sort((a, b) => a.t - b.t); const def = Measures.METRICS[id], base = med(rs.filter(x => x.t - rs[0].t < WEEK).map(x => x.value)); if (!(base > 0)) continue;
    const w = {}; for (const x of rs) (w[Math.floor((x.t - t0) / WEEK)] = w[Math.floor((x.t - t0) / WEEK)] || []).push(x.value);
    for (const [k, vs] of Object.entries(w)) { const v = med(vs); if (!(v > 0)) continue; const pct = Math.max(0, Math.min(120, 100 * (def.good === "higher" ? v / base : base / v))); (weeks.get(+k) || weeks.set(+k, []).get(+k)).push(pct); }
  }
  return [...weeks].sort((a, b) => a[0] - b[0]).map(([w, ps]) => ({ w, pct: Math.round(ps.reduce((a, b) => a + b, 0) / ps.length * 10) / 10 }));
}

function patientRow(code, recs, triage = [], now = Date.now()) {
  const mine = recs.filter(r => r.patient === code && clean(r)), sum = Measures.summary(mine, code);
  const tri = triage.filter(r => r.patient === code).sort((a, b) => b.t - a.t)[0] || null;
  const firstT = mine.length ? Math.min(...mine.map(r => r.t)) : null, lastT = mine.length ? Math.max(...mine.map(r => r.t)) : null;
  const comp = mine.filter(r => r.source === "companion"), sessions = new Set(comp.map(r => r.session || r.t));
  const sessions28 = new Set(comp.filter(r => now - r.t < 28 * DAY).map(r => r.session || r.t));
  const changes = Object.entries(sum.metrics).filter(([id, m]) => Measures.METRICS[id].status && isFinite(m.pctOfBaseline))
    .map(([id, m]) => ({ id, label: Measures.METRICS[id].label, unit: Measures.METRICS[id].unit, region: Measures.METRICS[id].region, pct: Math.round(m.pctOfBaseline), status: m.status, latest: m.latest, baseline: m.baseline, slope: m.slopePctPerWeek == null ? null : +m.slopePctPerWeek.toFixed(1) }))
    .sort((a, b) => a.pct - b.pct);
  const bad = changes.filter(c => c.status === "bad").length, warn = changes.filter(c => c.status === "warn").length;
  const regions = [...new Set(Object.entries(sum.regions).filter(([, s]) => s === "bad" || s === "warn").map(([r]) => REGION_GROUP[r]).filter(Boolean))];
  const emergency = !!(tri && tri.emergency), tier = tri && tri.tier != null ? tri.tier : null, ms = sum.motorScore;
  const daysSince = lastT == null ? null : Math.max(0, Math.floor((now - lastT) / DAY)), weeks = firstT == null ? 0 : Math.floor((now - firstT) / WEEK) + 1;
  let level;
  if (emergency) level = "emergency";
  else if (!mine.length) level = "new";
  else if (ms == null) level = "early";
  else if (ms < 85 || bad >= 2) level = "declining";
  else if (bad || warn || ms < 95) level = "watch";
  else level = "steady";
  const quiet = daysSince != null && daysSince >= 7;
  const priority = { emergency: 1000, declining: 300 + (100 - (ms == null ? 100 : ms)) * 2 + bad * 10, watch: 150 + (100 - (ms == null ? 100 : ms)) + warn * 4, steady: 10, early: 5, new: 20 }[level] + (quiet && level !== "new" ? 40 : 0) + (tier != null && tier >= 2 ? 50 : 0);
  return { code, level, quiet, priority: Math.round(priority), motorScore: ms, firstT, lastT, weeks, daysSince, checkins: sessions.size, checkins28: sessions28.size, tier, emergency, changes: changes.slice(0, 4), bad, warn, regions, trajectory: trajectory(mine), hasReadings: mine.length > 0 };
}

const byPriority = (a, b) => b.priority - a.priority || a.code.localeCompare(b.code);

function buildRoster(recs, triage = [], extraCodes = [], now = Date.now()) {
  const codes = new Set([...recs.map(r => r.patient), ...triage.map(r => r.patient), ...extraCodes]);
  const patients = [...codes].map(c => patientRow(c, recs, triage, now)).sort(byPriority);
  return { patients, cohort: cohortStats(patients), now };
}

function cohortStats(patients) {
  const levels = Object.fromEntries(LEVELS.map(l => [l, 0])); for (const p of patients) levels[p.level]++;
  const regions = {}; for (const g of new Set(Object.values(REGION_GROUP))) regions[g] = patients.filter(p => p.regions.includes(g)).map(p => p.code);
  const scored = patients.filter(p => p.motorScore != null);
  return { total: patients.length, levels, regions, avgMotorScore: scored.length ? Math.round(scored.reduce((a, p) => a + p.motorScore, 0) / scored.length) : null, quiet: patients.filter(p => p.quiet).map(p => p.code), emergencies: patients.filter(p => p.emergency).map(p => p.code) };
}

// The compact, de-identified facts Gemini is allowed to see (codes and numbers only, nothing typed by a patient).
function insightFacts(patients) {
  return patients.filter(p => p.hasReadings || p.emergency).slice(0, 40).map(p => ({
    code: p.code, level: p.level, weeks_in_programme: p.weeks, checkins_last_28_days: p.checkins28, days_since_last_reading: p.daysSince, motor_score_pct_of_own_baseline: p.motorScore,
    biggest_changes: p.changes.filter(c => c.status !== "ok").slice(0, 3).map(c => ({ measure: c.label, pct_of_baseline: c.pct, slope_pct_per_week: c.slope })), areas_affected: p.regions, symptom_screen_tier: p.tier, urgent_flag: p.emergency
  }));
}

function templateInsights(patients, cohort) {
  const L = cohort.levels, n = patients.filter(p => p.hasReadings).length, out = [], by = patients.filter(p => p.motorScore != null);
  const headline = n ? `${n} patient${n > 1 ? "s" : ""} with readings: ${L.declining} declining, ${L.watch} to watch, ${L.steady} steady.` : "No patients have readings yet.";
  if (cohort.emergencies.length) out.push(`Urgent symptom flag: ${cohort.emergencies.join(", ")}. Contact now.`);
  const worst = [...by].sort((a, b) => a.motorScore - b.motorScore)[0];
  if (worst && worst.motorScore < 95) { const c = worst.changes[0]; out.push(`${worst.code} has the lowest motor score at ${worst.motorScore}% of their own baseline over ${worst.weeks} weeks${c ? `, led by ${c.label.toLowerCase()} at ${c.pct}%` : ""}.`); }
  const common = Object.entries(cohort.regions).filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length)[0];
  if (common) out.push(`${common[0]} is the most common area of change (${common[1].length} patients: ${common[1].slice(0, 5).join(", ")}).`);
  if (cohort.quiet.length) out.push(`${cohort.quiet.length} patient${cohort.quiet.length > 1 ? "s have" : " has"} not checked in for a week or more: ${cohort.quiet.slice(0, 5).join(", ")}.`);
  const steadyLong = patients.filter(p => p.level === "steady" && p.weeks >= 8).map(p => p.code);
  if (steadyLong.length) out.push(`Stable for 8+ weeks: ${steadyLong.slice(0, 5).join(", ")}.`);
  if (!out.length && n) out.push("No notable differences between patients right now.");
  return { source: "template", headline, bullets: out.slice(0, 5) };
}

module.exports = { buildRoster, patientRow, trajectory, cohortStats, insightFacts, templateInsights, LEVELS, REGION_GROUP };
