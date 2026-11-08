/* Phone walking-test features. Input: [{t (s), x, y, z}] accelerometer samples (m/s^2, gravity included) -> stride timing.
 * Browser/Node. Phone gait is NOT the same measurement as the foot-switch reference (demo/gait_reference.json). */
(function (root) {
  "use strict";
  const FS = 50;
  const median = a => { const s = Array.from(a).sort((p, q) => p - q), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
  function resample(samples) {          // magnitude, linear interpolation to FS Hz
    const t0 = samples[0].t, T = samples[samples.length - 1].t - t0, n = Math.floor(T * FS), out = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / FS; while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[j + 1], w = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      const m = s => Math.hypot(s.x, s.y, s.z); out[i] = m(a) * (1 - w) + m(b) * w;
    }
    return out;
  }
  function smooth(x, k) { const y = new Float64Array(x.length), c = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) c[i + 1] = c[i] + x[i];
    for (let i = 0; i < x.length; i++) { const a = Math.max(0, i - k), b = Math.min(x.length, i + k + 1); y[i] = (c[b] - c[a]) / (b - a); } return y; }
  function bandpass(x) { const lo = smooth(x, 2), base = smooth(x, 25); return lo.map((v, i) => v - base[i]); }   // ~ remove gravity/drift (<1 Hz), smooth >8 Hz
  function analyze(samples) {
    const bad = [];
    if (!samples || samples.length < 100) return { ok: false, bad: ["too few motion samples"] };
    const x = resample(samples), dur = x.length / FS;
    if (dur < 20) return { ok: false, bad: ["recording shorter than 20 s"] };
    const y = bandpass(x), a = y.slice(FS * 5, y.length - FS * 5);        // drop first/last 5 s
    const sd = Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    if (sd < 0.3) return { ok: false, bad: ["almost no movement detected: walk with the phone in a pocket or at your waist"] };
    let r0 = 0; for (let i = 0; i < a.length; i++) r0 += a[i] * a[i];
    let ac = 0; for (let lag = Math.round(0.4 * FS); lag <= Math.round(2.2 * FS); lag++) { let c = 0; for (let i = 0; i + lag < a.length; i++) c += a[i] * a[i + lag]; ac = Math.max(ac, c / r0); }
    if (ac < 0.3) return { ok: false, bad: ["no regular walking rhythm detected (periodicity " + ac.toFixed(2) + ")"] };
    const thr = 0.5 * sd, minGap = Math.round(0.3 * FS), peaks = [];
    for (let i = 1; i < a.length - 1; i++) if (a[i] > thr && a[i] >= a[i - 1] && a[i] > a[i + 1]) {
      if (peaks.length && i - peaks[peaks.length - 1] < minGap) { if (a[i] > a[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i; } else peaks.push(i);
    }
    const steps = []; for (let i = 1; i < peaks.length; i++) steps.push((peaks[i] - peaks[i - 1]) / FS);
    const stride = []; for (let i = 0; i + 1 < steps.length; i++) stride.push(steps[i] + steps[i + 1]);   // overlapping pairs
    const m = median(stride), mad = median(stride.map(v => Math.abs(v - m))) * 1.4826 || 0.02, keep = stride.filter(v => Math.abs(v - m) < 3 * Math.max(mad, 0.02));
    const mean = keep.reduce((s, v) => s + v, 0) / (keep.length || 1);
    const cv = 100 * Math.sqrt(keep.reduce((s, v) => s + (v - mean) ** 2, 0) / (keep.length || 1)) / mean;
    const cadence = 120 / mean, cadMed = 60 / median(steps), warn = [];   // cadence from mean stride; median step interval is biased when pocket steps alternate short/long
    if (Math.abs(cadMed - cadence) / cadence > 0.08) warn.push(`step intervals alternate unevenly (median-step cadence ${cadMed.toFixed(0)} vs stride-based ${cadence.toFixed(0)} steps/min), common with the phone in a pocket; cadence uses the stride-based value`);
    if (keep.length < 30) bad.push(`only ${keep.length} usable strides (need 30): walk steadily for the full minute`);
    if (!(cadence >= 60 && cadence <= 150)) bad.push(`cadence ${isFinite(cadence) ? cadence.toFixed(0) : "?"} steps/min is not plausible walking`);
    return { ok: bad.length === 0, bad, warn, stride_time_s: mean, stride_cv_pct: cv, cadence, n_strides: keep.length, n_steps: steps.length };
  }
  const api = { FS, analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GaitFeatures = api;
})(typeof self !== "undefined" ? self : globalThis);
