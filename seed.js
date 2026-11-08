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
module.exports = { alexRecords };
