"use strict";
// Vowel acoustics from a sustained-vowel recording (mono samples in [-1,1]). Pure; node + browser.
//  formants(): LPC (autocorrelation + Levinson) -> polynomial roots -> candidate formants for one frame.
//  analyzeVowel(): finds the voiced stretch, takes its steady middle, returns median F1/F2 and a validity verdict.
//  vowelSpace(): from /i/ /a/ /u/ -> triangle area (kHz^2) and centralization ratio (higher = more centralized = less distinct vowels).
// Acoustic proxies for articulation; phone microphones are noisy, so compare a person only with their own earlier results.
(function (root) {
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const med = a => pct(a, .5);
  function decimate(x, sr, target = 11025) {            // box-average down to about `target` Hz
    const k = Math.max(1, Math.round(sr / target)); if (k === 1) return { x, sr };
    const n = Math.floor(x.length / k), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < k; j++) s += x[i * k + j]; y[i] = s / k; }
    return { x: y, sr: sr / k };
  }
  function lpc(x, order) {                                // Levinson-Durbin; returns a[0..order], a[0]=1
    const n = x.length, r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) { let s = 0; for (let i = 0; i + k < n; i++) s += x[i] * x[i + k]; r[k] = s; }
    r[0] = r[0] * 1.0001 + 1e-9;                          // white-noise correction
    const a = new Float64Array(order + 1); a[0] = 1; let e = r[0];
    for (let i = 1; i <= order; i++) {
      let acc = r[i]; for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / e, tmp = a.slice(); for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j]; a[i] = k; e *= 1 - k * k; if (e <= 0) break;
    }
    return a;
  }
  function roots(a) {                                     // Durand-Kerner on z^p + a1 z^(p-1) + ... + ap
    const p = a.length - 1, re = [], im = [];
    for (let i = 0; i < p; i++) { const ang = 2 * Math.PI * i / p + 0.4, r = 0.9; re.push(r * Math.cos(ang)); im.push(r * Math.sin(ang)); }
    for (let it = 0; it < 200; it++) {
      let md = 0;
      for (let i = 0; i < p; i++) {
        let pr = 1, pi = 0; for (let k = 1; k <= p; k++) { const nr = pr * re[i] - pi * im[i] + a[k], ni = pr * im[i] + pi * re[i]; pr = nr; pi = ni; }
        let dr = 1, di = 0; for (let j = 0; j < p; j++) if (j !== i) { const ar = re[i] - re[j], ai = im[i] - im[j], nr = dr * ar - di * ai, ni = dr * ai + di * ar; dr = nr; di = ni; }
        const den = dr * dr + di * di + 1e-300, qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den; re[i] -= qr; im[i] -= qi; md = Math.max(md, Math.hypot(qr, qi));
      }
      if (md < 1e-10) break;
    }
    return re.map((r, i) => [r, im[i]]);
  }
  // one frame (already at the working sample rate) -> sorted [{f, bw}] candidate formants, or []
  function formants(frame, sr, order = 12) {
    const n = frame.length, w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = (frame[i] - (i ? 0.97 * frame[i - 1] : 0)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1)));
    const a = lpc(w, order), out = [];
    for (const [r, i] of roots(a)) { if (i <= 0.001) continue; const f = Math.atan2(i, r) * sr / (2 * Math.PI), bw = -Math.log(Math.hypot(r, i)) * sr / Math.PI; if (f > 150 && f < sr / 2 - 200 && bw < 450) out.push({ f, bw }); }
    return out.sort((p, q) => p.f - q.f);
  }
  // sustained vowel -> {valid, reasons, f1, f2, f3, dur, voicedFrac, spread}
  function analyzeVowel(x, sr, opts = {}) {
    const reasons = [], out = { valid: false, reasons, dur: x.length / sr };
    if (out.dur < 1.2) { reasons.push("Recording too short: hold the sound for 2 to 3 seconds"); return out; }
    const d = decimate(x, sr), y = d.x, fs = d.sr, fl = Math.round(0.03 * fs), hop = Math.round(0.01 * fs), nf = Math.floor((y.length - fl) / hop);
    if (nf < 40) { reasons.push("Recording too short"); return out; }
    const rms = new Float64Array(nf); for (let k = 0; k < nf; k++) { let s = 0; for (let i = 0; i < fl; i++) s += y[k * hop + i] ** 2; rms[k] = Math.sqrt(s / fl); }
    const db = Array.from(rms, v => 20 * Math.log10(v + 1e-9)), floor = pct(db, .03), top = pct(db, .95), snr = top - floor; out.snrDb = snr;
    if (snr < 15) { reasons.push(`Too quiet or too noisy (voice stood out by ${snr.toFixed(0)} dB, needs 15 or more): hold the sound louder, closer to the phone`); return out; }
    const thr = floor + 0.5 * snr, on = db.map(v => v > thr); let best = [0, -1], s0 = -1;   // longest voiced run, allowing 60 ms holes
    for (let k = 0, lastOn = -1; k <= nf; k++) { const o = k < nf && on[k]; if (o) { if (s0 < 0) s0 = k; lastOn = k; } else if (s0 >= 0 && (k === nf || k - lastOn > 6)) { if (lastOn - s0 > best[1] - best[0]) best = [s0, lastOn]; s0 = -1; } }
    const run = best[1] - best[0] + 1; out.voicedFrac = run / nf;
    if (run < 80) { reasons.push("Sound held for under 0.8 s: hold it steadier and longer"); return out; }
    const a = best[0] + Math.floor(run * 0.25), b = best[1] - Math.floor(run * 0.25), F1 = [], F2 = [], F3 = [];
    for (let k = a; k <= b; k++) {
      const fr = y.subarray(k * hop, k * hop + fl), fm = formants(fr, fs, opts.order || 12).filter(q => q.f >= 200 && q.f <= 4200 && q.bw < 350);   // sorted by frequency: first = F1, second = F2, third = F3
      if (fm.length < 2 || fm[0].f > 1000 || fm[1].f > 3200) continue; F1.push(fm[0].f); F2.push(fm[1].f); if (fm[2]) F3.push(fm[2].f);
    }
    if (F1.length < 15) { reasons.push("Could not find stable vowel resonances: try again in a quieter room"); return out; }
    out.f1 = med(F1); out.f2 = med(F2); out.f3 = F3.length ? med(F3) : null;
    out.spread = Math.max(med(F1.map(v => Math.abs(v - out.f1))) / out.f1, med(F2.map(v => Math.abs(v - out.f2))) / out.f2);
    if (out.spread > 0.12) reasons.push("The sound wandered too much to measure: keep the same vowel steady");
    out.valid = reasons.length === 0; return out;
  }
  // v = {i:{f1,f2}, a:{...}, u:{...}} -> {vsa (kHz^2), vcr}
  function vowelSpace(v) {
    const I = v.i, A = v.a, U = v.u; if (!I || !A || !U) return null;
    const area = 0.5 * Math.abs(I.f1 * (A.f2 - U.f2) + A.f1 * (U.f2 - I.f2) + U.f1 * (I.f2 - A.f2)) / 1e6;
    return { vsa: area, vcr: (U.f2 + A.f2 + I.f1 + U.f1) / (I.f2 + A.f1) };
  }
  const toValues = s => ({ vowel_vsa: +s.vsa.toFixed(3), vowel_vcr: +s.vcr.toFixed(3) });
  const api = { formants, analyzeVowel, vowelSpace, toValues, lpc, decimate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Vowel = api;
})(typeof window !== "undefined" ? window : globalThis);
