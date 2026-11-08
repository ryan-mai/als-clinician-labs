"use strict";
// Alex's demo record: clinic baseline (from synthetic_patients.json ALEX-CASE) + a seeded 10-week companion trend.
(function (root) {
  const weeks = 10, mk = (a, b, n) => Array.from({ length: weeks }, (_, i) => { const t = i / (weeks - 1), j = Math.sin(i * 12.9898 + n) * .5; return +(a + (b - a) * t + j * (Math.abs(b - a) * .06 + .1)).toFixed(2); });
  const series = { gripR: mk(24, 14, 1), gripL: mk(34, 32, 2), ddk: mk(6.4, 5.2, 3) };
  const clinic = { fvcSit: 78, fvcSup: 64, nfl: 88, ck: 470, snip: 52, walk: 14.2 };
  function compute() {
    const last = a => a[a.length - 1], now = { gripR: 14, gripL: 32, ddk: last(series.ddk) }, pc = a => Math.round(100 * last(a) / a[0]);
    const pct = { gripR: pc(series.gripR), gripL: pc(series.gripL), ddk: pc(series.ddk) };
    const score = Math.round((pct.gripR + pct.gripL + pct.ddk) / 3);
    const asym = Math.round(100 * now.gripR / now.gripL);
    const status = { handR: "bad", handL: "ok", bulbar: "warn", chest: "warn", footR: "warn", footL: "ok" };
    const regionText = {
      handR: `Grip fell to ${now.gripR} kg (${pct.gripR}% of week 1); right is ${asym}% of left. Largest decline.`,
      handL: `Grip steady at ${now.gripL} kg (${pct.gripL}% of week 1). Used as Alex's own reference side.`,
      bulbar: `Pa-ta-ka rate ${now.ddk.toFixed(1)} syll/s, down to ${pct.ddk}% of week 1. Slowing speech is an early bulbar sign.`,
      chest: `FVC ${clinic.fvcSit}% sitting, ${clinic.fvcSup}% supine (a ${clinic.fvcSit - clinic.fvcSup}-point drop). SNIP ${clinic.snip} cmH2O.`,
      footR: `10 m walk ${clinic.walk} s. Right toe-lift speed trending down in the companion reps.`,
      footL: `No clear change in left leg reps so far.`
    };
    const findings = [
      { t: "Right-hand weakness is progressing", b: `Right grip is ${asym}% of left and fell to ${pct.gripR}% of its week-1 value in ${weeks} weeks.`, g: "Motor", c: "bad" },
      { t: "Speech rate is slowing", b: `Syllable rate dropped to ${pct.ddk}% of baseline.`, g: "Bulbar", c: "warn" },
      { t: "Biomarkers support follow-up", b: `NfL ${clinic.nfl} pg/mL and CK ${clinic.ck} U/L are raised; supine FVC drop ${clinic.fvcSit - clinic.fvcSup} pts. Suggest neurology review.`, g: "Labs", c: "bad" }];
    return { weeks, series, clinic, now, pct, score, asym, status, regionText, findings, visit: "7 Nov 2026" };
  }
  root.Alex = { compute };
  if (typeof module !== "undefined") module.exports = root.Alex;
})(typeof window !== "undefined" ? window : globalThis);
