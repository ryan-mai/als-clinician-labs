"use strict";
// Camera-only grip and key-pinch proxies. Pure; node + browser.
// A camera cannot feel force. We track how far and how fast the hand closes (fist) or the thumb meets the index finger (pinch),
// combine range, speed and rate into one unitless "score" (saved per session), and only turn it into an ESTIMATED kg at view time
// by anchoring the person's first-week score to a clinic dynamometer reading.
(function (root) {
  const THUMB = 4, INDEX = 8, WRIST = 0, MCP = 9;
  const d = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  // pinch signal: thumb tip to index tip, in palm lengths. LOW = pinched (same polarity as Grip.closure, so Grip.analyze works unchanged)
  function pinch(lm, w, h) { const palm = d(lm[WRIST], lm[MCP], w, h); if (!(palm > 1e-6)) return null; return d(lm[THUMB], lm[INDEX], w, h) / palm; }
  const PINCH_OPTS = { minRange: 0.2, med: 1, mean: 1, smallMsg: "Pinch movement too small: open your thumb and finger wide, then pinch them together firmly" };
  // m = result of Grip.analyze (valid) -> unitless score (geometric blend: range matters most, then speed, then rate)
  function score(m) { if (!m || !(m.amp > 0) || !(m.speed > 0) || !(m.rate > 0)) return null; return Math.pow(m.amp, 0.5) * Math.pow(m.speed, 0.3) * Math.pow(m.rate, 0.2); }
  // series: [{t, v}] scores ascending; clinic: [{t, kg}] dynamometer readings.
  // Returns {anchorKg, anchorScore, est: [{t, kg}]} or null when it cannot be anchored (no clinic reading or no scores).
  function estimate(series, clinic) {
    if (!series.length || !clinic.length) return null; const DAY = 864e5, t0 = series[0].t;
    const base = series.filter(s => s.t - t0 < 7 * DAY).map(s => s.v).sort((a, b) => a - b), anchorScore = base[base.length >> 1], mid = t0 + 3.5 * DAY;
    const c = clinic.reduce((b, x) => (Math.abs(x.t - mid) < Math.abs(b.t - mid) ? x : b)); if (!(anchorScore > 0) || !(c.kg > 0)) return null;
    return { anchorKg: c.kg, anchorScore, est: series.map(s => ({ t: s.t, kg: +Math.min(c.kg * 1.5, c.kg * s.v / anchorScore).toFixed(1) })) };
  }
  // kind = "grip" | "pinch", side = "r" | "l" -> values keyed by Measures metric ids
  const toValues = (m, kind, side) => { const s = score(m); return s == null ? {} : { [`${kind}_score_${side}`]: +s.toFixed(3) }; };
  const api = { pinch, PINCH_OPTS, score, estimate, toValues };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KgEst = api;
})(typeof window !== "undefined" ? window : globalThis);
