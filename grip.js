"use strict";
// Repetitive-movement metrics from tracked landmarks. Pure functions (node-testable).
//  Hand: signal = mean fingertip-to-wrist distance / wrist-to-middle-knuckle (palm lengths); LOW = fist.
//  Foot: signal = ankle angle (degrees) between shank and foot; LOW = toes lifted (dorsiflexion).
// Both are movement proxies for weakness/fatigability, NOT force or a validated clinical measure.
(function (root) {
  const TIPS = [8, 12, 16, 20], WRIST = 0, MCP = 9;
  const LEG = { r: { knee: 26, ankle: 28, toe: 32 }, l: { knee: 25, ankle: 27, toe: 31 } };
  const d = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  function closure(lm, w, h) {          // hand: scale-free closure or null
    const palm = d(lm[WRIST], lm[MCP], w, h); if (!(palm > 1e-6)) return null;
    return TIPS.reduce((s, i) => s + d(lm[i], lm[WRIST], w, h), 0) / TIPS.length / palm;
  }
  function ankleAngle(lm, side, w, h) { // foot: degrees at the ankle, or null if landmarks unreliable
    const L = LEG[side], k = lm[L.knee], a = lm[L.ankle], t = lm[L.toe]; if (!k || !a || !t) return null;
    if ([k, a, t].some(p => p.visibility != null && p.visibility < 0.5)) return null;
    const v1 = [(k.x - a.x) * w, (k.y - a.y) * h], v2 = [(t.x - a.x) * w, (t.y - a.y) * h], n = Math.hypot(...v1) * Math.hypot(...v2); if (!(n > 1e-6)) return null;
    return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / n))) * 180 / Math.PI;
  }
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const med = a => pct(a, .5), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  // One Euro filter (adaptive low-pass): heavy smoothing when still, light when moving fast. Use per coordinate, times in seconds.
  function oneEuro(minCutoff = 1, beta = 0, dCutoff = 1) {
    let xp = null, dxp = 0, tp = null; const alpha = (te, fc) => { const r = 2 * Math.PI * fc * te; return r / (r + 1); };
    return (x, t) => {
      if (xp == null || !(t > tp)) { xp = x; tp = t; dxp = 0; return x; }
      const te = t - tp, dx = (x - xp) / te, ad = alpha(te, dCutoff), dxh = ad * dx + (1 - ad) * dxp, a = alpha(te, minCutoff + beta * Math.abs(dxh));
      xp = a * x + (1 - a) * xp; dxp = dxh; tp = t; return xp;
    };
  }
  // median window (removes single-frame jumps) then mean window; half-widths in frames
  function smooth(a, med, mean_) {
    const w = (x, h, f) => x.map((_, i) => f(x.slice(Math.max(0, i - h), i + h + 1)));
    return w(med > 0 ? w(a, med, v => { const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; }) : a, mean_, v => v.reduce((p, q) => p + q, 0) / v.length);
  }
  // frames: [{t: seconds, c: signal|null}]. opts.minRange = smallest believable movement in signal units; opts.med / opts.mean = smoothing half-widths (frames).
  function analyze(frames, opts = {}) {
    const minRange = opts.minRange ?? 0.35, smallMsg = opts.smallMsg || "Movement too small: open fully, then close into a tight fist";
    const reasons = [], n = frames.length, got = frames.filter(f => f.c != null && isFinite(f.c));
    const dur = n ? frames[n - 1].t - frames[0].t : 0, frac = n ? got.length / n : 0;
    const out = { valid: false, reasons, dur, handFrac: frac, nCycles: 0 };
    if (dur < 7) reasons.push("Recording too short");
    if (frac < 0.8) reasons.push("The body part was not tracked for enough of the recording");
    if (got.length < 20) { reasons.push("Too few tracked frames"); return out; }
    const t = got.map(f => f.t), c = smooth(got.map(f => f.c), opts.med ?? 0, opts.mean ?? 1);
    const lo = pct(c, .05), hi = pct(c, .95), range = hi - lo; out.range = range;
    if (range < minRange) { reasons.push(smallMsg); return out; }
    const closeT = lo + 0.35 * range, openT = lo + 0.65 * range;
    let state = "open", cycles = [], cur = null;
    for (let i = 0; i < c.length; i++) {
      if (state === "open" && c[i] < closeT) { state = "closed"; cur = { tClose: t[i], min: c[i], max: -Infinity, iClose: i }; }
      else if (state === "closed") { cur.min = Math.min(cur.min, c[i]); if (c[i] > openT) { state = "open"; cur.tOpen = t[i]; cycles.push(cur); cur = null; } }
    }
    let prev = 0; for (const cy of cycles) { let m = -Infinity; for (let i = prev; i <= cy.iClose; i++) m = Math.max(m, c[i]); cy.max = m; prev = cy.iClose; }
    out.nCycles = cycles.length;
    if (cycles.length < 4) { reasons.push("Fewer than 4 repetitions detected"); return out; }
    const amps = cycles.map(y => y.max - y.min), ints = cycles.slice(1).map((y, i) => y.tClose - cycles[i].tClose);
    const speeds = cycles.map(y => { let best = 0; for (let i = Math.max(1, y.iClose - 12); i <= y.iClose; i++) { const dt = t[i] - t[i - 1]; if (dt > 0) best = Math.max(best, (c[i - 1] - c[i]) / dt); } return best; });
    out.rate = (cycles.length - 1) / (cycles[cycles.length - 1].tClose - cycles[0].tClose);
    out.amp = med(amps); out.speed = med(speeds);
    out.cv = ints.length > 1 ? 100 * Math.sqrt(mean(ints.map(x => (x - mean(ints)) ** 2))) / mean(ints) : NaN;
    if (cycles.length >= 6) { const k = Math.floor(cycles.length / 3), a = mean(amps.slice(0, k)), b = mean(amps.slice(-k)); out.decrement = 100 * (b - a) / a; } else out.decrement = null;
    if (!(out.rate > 0.3 && out.rate < 6)) reasons.push("Implausible rate: " + out.rate.toFixed(2) + "/s");
    out.valid = reasons.length === 0; return out;
  }
  // analyte names saved to the record: kind = "grip" | "foot", side = "r" | "l"
  function toLabs(m, kind = "grip", side = "r") {
    const o = {}; o[`${kind}_rate_${side}`] = +m.rate.toFixed(2); o[`${kind}_amp_${side}`] = +m.amp.toFixed(kind === "foot" ? 1 : 2); o[`${kind}_speed_${side}`] = +m.speed.toFixed(kind === "foot" ? 1 : 2);
    if (m.decrement != null) o[`${kind}_decrement_${side}`] = +m.decrement.toFixed(1); return o;
  }
  root.Grip = { oneEuro, smooth, closure, ankleAngle, analyze, toLabs, TIPS, LEG };
  if (typeof module !== "undefined") module.exports = root.Grip;
})(typeof window !== "undefined" ? window : globalThis);
