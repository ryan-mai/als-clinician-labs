"use strict";
// Demo data for ALEX-CASE: 10 weeks of daily companion reps + three clinic visits (weeks 0, 5, 10) ending at the case-file values.
// Deterministic (no randomness) so the demo looks the same every time. Synthetic.
const Measures = require("./measures.js");
const DAY = 864e5;
function alexRecords(now = Date.now(), patient = "ALEX-CASE") {
  const recs = [], jit = (d, k) => Math.sin(d * 12.9898 + k * 78.233) * .5;
  for (let d = 0; d < 70; d++) {
    if (d % 11 === 5) continue;                                   // a few missed days
    const f = d / 69, t = now - (70 - d) * DAY + 9 * 3600e3 - ((now - (70 - d) * DAY) % DAY) * 0 , v = {
      grip_amp_r: 1.25 - .55 * f + .04 * jit(d, 1), grip_amp_l: 1.28 - .04 * f + .04 * jit(d, 2),
      foot_amp_r: 32 - 9 * f + 1.2 * jit(d, 3), foot_amp_l: 33 - .5 * f + 1.2 * jit(d, 4),
      grip_score_r: 1.9 * (1 - .42 * f) * (1 + .04 * jit(d, 9)), grip_score_l: 2.0 * (1 - .03 * f) * (1 + .04 * jit(d, 10)), pinch_score_r: 1.6 * (1 - .4 * f) * (1 + .04 * jit(d, 11)), pinch_score_l: 1.7 * (1 - .025 * f) * (1 + .04 * jit(d, 12)),   // phone camera scores: right side declines, left steady
      ...(d % 3 === 0 ? { vowel_vsa: .33 * (1 - .3 * f) * (1 + .05 * jit(d, 13)), vowel_vcr: .85 * (1 + .12 * f) * (1 + .02 * jit(d, 14)), jaw_speed: 3.2 * (1 - .18 * f) * (1 + .05 * jit(d, 15)), lip_range: .45 * (1 - .15 * f) * (1 + .05 * jit(d, 16)) } : {}),
      ...(d % 7 === 0 ? { speech_wpm: Math.round(162 - 21 * f + 2 * jit(d, 8)) } : {}),
      ddk_rate: 6.4 - 1.2 * f + .15 * jit(d, 5), ddk_cv: 11 + 3 * f + 1 * jit(d, 6), gait_cadence: 108 - 4 * f + 1.5 * jit(d, 7) };
    const { recs: r } = Measures.fromSession(patient, v, { t: Math.min(t, now - 36e5), source: "companion", session: `${patient}-c${d}`, now });
    recs.push(...r);
  }
  const visits = [[70, { grip_kg_r: 24, grip_kg_l: 33, fvc_sit_pct: 86, fvc_sup_pct: 76, pinch_kg_r: 5, pinch_kg_l: 8.2, snip_cmh2o: 64, walk10m_s: 11.5, alsfrs_r: 36 }],
                  [35, { grip_kg_r: 19, grip_kg_l: 33, fvc_sit_pct: 82, fvc_sup_pct: 70, pinch_kg_r: 4, pinch_kg_l: 8.1, snip_cmh2o: 58, walk10m_s: 12.8, alsfrs_r: 34 }],
                  [1, { grip_kg_r: 14, grip_kg_l: 32, fvc_sit_pct: 78, fvc_sup_pct: 64, pinch_kg_r: 3, pinch_kg_l: 8, snip_cmh2o: 52, walk10m_s: 14.2, alsfrs_r: 32, nfl_pgml: 88, ck: 470 }]];
  for (const [ago, v] of visits) recs.push(...Measures.fromSession(patient, v, { t: now - ago * DAY, source: "clinic", session: `${patient}-clinic${ago}`, now }).recs);
  return recs;
}
// A small synthetic cohort so the Patients page has something to compare: different time in the programme, different areas declining, one gone quiet.
// dec = fraction lost by the last reading (hand / speech / legs); fvc = clinic FVC sitting [first, last] when breathing is part of the story; gap = days since the last check-in.
const COHORT = [
  { code: "DEMO-01", days: 84, hand: .7, speech: .12, leg: .02, gap: 0, p: 1.4 },
  { code: "DEMO-02", days: 120, hand: .03, speech: .3, leg: .03, gap: 1, p: 1.2 },
  { code: "DEMO-03", days: 56, hand: .02, speech: .02, leg: .01, gap: 0, p: 1 },
  { code: "DEMO-04", days: 140, hand: .03, speech: .02, leg: .02, gap: 0, p: 1 },
  { code: "DEMO-05", days: 42, hand: .02, speech: .03, leg: .17, gap: 3, p: 1 },
  { code: "DEMO-06", days: 70, hand: .11, speech: .03, leg: .02, gap: 12, p: 1 },
  { code: "DEMO-07", days: 21, hand: .01, speech: .01, leg: .01, gap: 0, p: 1 },
  { code: "DEMO-08", days: 98, hand: .03, speech: .04, leg: .03, gap: 2, p: 1, fvc: [94, 87, 79] },
];
function cohortRecords(now = Date.now()) {
  const recs = [], jit = (d, k) => Math.sin(d * 12.9898 + k * 78.233) * .5;
  COHORT.forEach((c, pi) => {
    for (let d = 0; d < c.days; d++) {
      if ((d + pi) % 9 === 4) continue;
      const f = Math.pow(d / (c.days - 1), c.p), ago = c.gap + (c.days - 1 - d), t = Math.min(now - ago * DAY + 9 * 3600e3, now - 36e5), k = pi * 7, j = n => 1 + .04 * jit(d, k + n);
      const v = { grip_amp_r: 1.25 * (1 - c.hand * f) * j(1), grip_amp_l: 1.28 * (1 - c.hand * .12 * f) * j(2), foot_amp_r: 32 * (1 - c.leg * f) * j(3), foot_amp_l: 33 * (1 - c.leg * .9 * f) * j(4),
        ddk_rate: 6.4 * (1 - c.speech * f) * j(5), gait_cadence: 108 * (1 - c.leg * .35 * f) * j(6),
        ...(d % 3 === 0 ? { vowel_vsa: .33 * (1 - c.speech * 1.1 * f) * j(7) } : {}), ...(d % 7 === 0 ? { speech_wpm: Math.round(160 * (1 - c.speech * f) * j(8)) } : {}) };
      recs.push(...Measures.fromSession(c.code, v, { t, source: "companion", session: `${c.code}-c${d}`, now }).recs);
    }
    if (c.fvc) for (const [i, val] of c.fvc.entries()) recs.push(...Measures.fromSession(c.code, { fvc_sit_pct: val }, { t: now - [c.days, c.days / 2, c.gap + 1][i] * DAY, source: "clinic", session: `${c.code}-clinic${i}`, now }).recs);
  });
  return recs;
}
module.exports = { alexRecords, cohortRecords, COHORT };
