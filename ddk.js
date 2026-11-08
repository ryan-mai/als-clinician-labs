"use strict";
// Speech timing from a microphone recording (mono samples in [-1,1]). Pure; node + browser.
//  analyzeDDK: user repeats "pa-ta-ka" as fast and evenly as they can; we count syllable bursts in the loudness envelope.
//  analyzeMPT: user holds "ah" as long as possible; we measure the voiced duration.
// These are timing measures only, not intelligibility and not diagnostic.
(function (root) {
  const HOP = 0.01;                     // 10 ms frames
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length, med = a => pct(a, .5);
  function envelopeDb(x, sr) {          // RMS per 10 ms, in dB, lightly smoothed (30 ms)
    const f = Math.max(1, Math.round(sr * HOP)), n = Math.floor(x.length / f), db = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i * f; j < (i + 1) * f; j++) s += x[j] * x[j]; db[i] = 20 * Math.log10(Math.sqrt(s / f) + 1e-9); }
    return Array.from(db, (_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) { s += db[k]; c++; } return s / c; });
  }
  function clipFrac(x) { let c = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 0.99) c++; return c / x.length; }
  function analyzeDDK(x, sr, opts = {}) {
    const minDur = opts.minDur ?? 3, reasons = [], warn = [], dur = x.length / sr, out = { valid: false, reasons, warn, dur };
    if (dur < minDur) { reasons.push("Recording too short: keep going for at least " + minDur + " seconds"); return out; }
    const db = envelopeDb(x, sr), floor = pct(db, .1), top = pct(db, .95), snr = top - floor; out.snrDb = snr;
    if (snr < 12) { reasons.push(`Too quiet or too noisy to hear the syllables (voice stood out by ${snr.toFixed(0)} dB, needs 12 or more): speak up, move closer, or find a quieter room`); return out; }
    if (clipFrac(x) > 0.01) warn.push("Recording is clipping: move the mic further away");
    if (snr < 20) warn.push("Background noise is fairly high");
    const thr = floor + 0.4 * snr, W = 3, cand = [];
    for (let i = W; i < db.length - W; i++) { if (db[i] <= thr) continue; let isMax = true; for (let k = i - W; k <= i + W; k++) if (db[k] > db[i] || (db[k] === db[i] && k < i)) { isMax = false; break; } if (isMax) cand.push(i); }
    const peaks = [];                   // merge peaks not separated by a real dip (>= 4 dB)
    for (const p of cand) {
      if (!peaks.length) { peaks.push(p); continue; }
      const q = peaks[peaks.length - 1]; let valley = Infinity; for (let k = q; k <= p; k++) valley = Math.min(valley, db[k]);
      if (Math.min(db[p], db[q]) - valley < 4 || (p - q) * HOP < 0.07) { if (db[p] > db[q]) peaks[peaks.length - 1] = p; } else peaks.push(p);
    }
    out.nSyll = peaks.length;
    if (peaks.length < 8) { reasons.push("Fewer than 8 syllables detected: say pa-ta-ka again and again, clearly and without long gaps"); return out; }
    const t = peaks.map(p => p * HOP), ints = t.slice(1).map((v, i) => v - t[i]), span = t[t.length - 1] - t[0], m = med(ints);
    out.rate = (peaks.length - 1) / span; out.spanS = span;
    const mi = mean(ints); out.cv = 100 * Math.sqrt(mean(ints.map(v => (v - mi) ** 2))) / mi;
    out.pauses = ints.filter(v => v > 2.2 * m).length;
    const k = Math.floor(ints.length / 3);   // slowing within the recording: last third vs first third (positive = slower)
    out.slowing = k >= 3 ? 100 * (mean(ints.slice(-k)) - mean(ints.slice(0, k))) / mean(ints.slice(0, k)) : null;
    if (!(out.rate >= 1.5 && out.rate <= 11)) reasons.push("Implausible rate: " + out.rate.toFixed(1) + " syllables/s");
    out.valid = reasons.length === 0; return out;
  }
  function analyzeMPT(x, sr) {
    const reasons = [], db = envelopeDb(x, sr), floor = pct(db, .1), top = pct(db, .95), snr = top - floor, out = { valid: false, reasons, snrDb: snr, dur: x.length / sr };
    if (snr < 12) { reasons.push(`Too quiet to measure (voice stood out by ${snr.toFixed(0)} dB, needs 12 or more): say 'ahhh' louder, closer to the mic`); return out; }
    const thr = floor + 0.35 * snr, gap = Math.round(0.2 / HOP); let best = 0, start = -1, lastOn = -1;
    for (let i = 0; i <= db.length; i++) {
      const on = i < db.length && db[i] > thr;
      if (on) { if (start < 0) start = i; lastOn = i; }
      else if (start >= 0 && (i - lastOn > gap || i === db.length)) { best = Math.max(best, (lastOn - start + 1) * HOP); start = -1; }
    }
    out.mpt = best; if (best < 0.5) reasons.push("No sustained sound found"); out.valid = reasons.length === 0; return out;
  }
  // Reading rate: the person reads a KNOWN passage (words = its word count); words per minute over the speaking span, plus the share of the span spent in pauses.
  // Assumes they read every word; we time the audio, we do not transcribe it.
  const PASSAGE = "When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow.";
  const PASSAGE_WORDS = PASSAGE.trim().split(/\s+/).length;
  function analyzeReading(x, sr, words = PASSAGE_WORDS) {
    const reasons = [], warn = [], dur = x.length / sr, out = { valid: false, reasons, warn, dur };
    if (dur < 12) { reasons.push("Recording too short to measure a reading rate"); return out; }
    const db = envelopeDb(x, sr), floor = pct(db, .1), top = pct(db, .95), snr = top - floor; out.snrDb = snr;
    if (snr < 12) { reasons.push(`Too quiet or too noisy (voice stood out by ${snr.toFixed(0)} dB, needs 12 or more): read a little louder, closer to the mic`); return out; }
    if (clipFrac(x) > 0.01) warn.push("Recording is clipping: move the mic further away");
    const thr = floor + 0.3 * snr, on = db.map(v => v > thr), W = 100, dens = on.map((_, i) => { let c = 0, n = 0; for (let k = Math.max(0, i - W / 2); k < Math.min(on.length, i + W / 2); k++) { n++; if (on[k]) c++; } return c / n; });
    const idx = dens.map((d, i) => (d >= 0.3 ? i : -1)).filter(i => i >= 0); if (idx.length < 500) { reasons.push("Not enough continuous speech found"); return out; }
    const a = idx[0], b = idx[idx.length - 1], span = (b - a + 1) * HOP; out.spanS = span; out.wpm = words / (span / 60);
    let gaps = 0, run = 0; for (let i = a; i <= b; i++) { if (!on[i]) run++; else { if (run * HOP > 0.25) gaps += run; run = 0; } } out.pauseFrac = gaps * HOP / span; out.words = words;
    if (!(out.wpm >= 40 && out.wpm <= 300)) reasons.push("Implausible rate: " + out.wpm.toFixed(0) + " words/min. Did you read the whole passage?");
    if (span < 0.6 * words / 3) warn.push("That was very fast: make sure you read every word");
    out.valid = reasons.length === 0; return out;
  }
  const readingToValues = m => ({ speech_wpm: Math.round(m.wpm) });
  // -> values keyed by Measures metric ids
  const ddkToValues = m => ({ ddk_rate: +m.rate.toFixed(2), ddk_cv: +m.cv.toFixed(1), ddk_pauses: m.pauses });
  const mptToValues = m => ({ mpt_s: +m.mpt.toFixed(1) });
  const api = { analyzeDDK, analyzeMPT, analyzeReading, ddkToValues, mptToValues, readingToValues, PASSAGE, PASSAGE_WORDS, envelopeDb };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DDK = api;
})(typeof window !== "undefined" ? window : globalThis);
