"use strict";
// Lip and jaw movement from MediaPipe FaceLandmarker points (478 landmarks). Pure; node + browser.
// Everything is divided by the distance between the outer eye corners, so it does not depend on how far the phone is held.
(function (root) {
  const IDX = { upper: 13, lower: 14, cornerL: 61, cornerR: 291, eyeL: 33, eyeR: 263, chin: 152, noseBase: 2 };
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const dist = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  // one frame -> {open, width, jaw} in eye-distance units, or null if the face is not usable
  function mouth(lm, w, h) {
    if (!lm || lm.length < 400) return null; const e = dist(lm[IDX.eyeL], lm[IDX.eyeR], w, h); if (!(e > 1e-6)) return null;
    return { open: dist(lm[IDX.upper], lm[IDX.lower], w, h) / e, width: dist(lm[IDX.cornerL], lm[IDX.cornerR], w, h) / e, jaw: dist(lm[IDX.chin], lm[IDX.noseBase], w, h) / e };
  }
  // frames: [{t (s), open, width, jaw}] with open == null when the face was lost. Returns ranges and the fastest sustained jaw movement.
  function summarize(frames) {
    const reasons = [], got = frames.filter(f => f.open != null), out = { valid: false, reasons, n: frames.length, tracked: frames.length ? got.length / frames.length : 0 };
    if (got.length < 15) { reasons.push("Face not tracked long enough"); return out; }
    if (out.tracked < 0.7) { reasons.push("Face was out of view too often"); return out; }
    const rng = k => pct(got.map(f => f[k]), .95) - pct(got.map(f => f[k]), .05);
    out.openRange = rng("open"); out.widthRange = rng("width"); out.jawRange = rng("jaw");
    const sp = []; for (let i = 2; i < got.length; i++) { const dt = got[i].t - got[i - 2].t; if (dt > 0 && dt < 0.2) sp.push(Math.abs(got[i].jaw - got[i - 2].jaw) / dt); }
    out.jawSpeed = sp.length ? pct(sp, .9) : 0;
    if (out.jawRange < 0.01) reasons.push("Almost no jaw movement seen");
    out.valid = reasons.length === 0; return out;
  }
  // widthRange: lip spreading (ee) versus rounding (oo), in eye-distance units
  const toValues = (s, widthRange) => { const o = {}; if (widthRange != null && isFinite(widthRange)) o.lip_range = +widthRange.toFixed(3); if (s && s.valid) o.jaw_speed = +s.jawSpeed.toFixed(3); return o; };
  const api = { IDX, mouth, summarize, toValues };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LipJaw = api;
})(typeof window !== "undefined" ? window : globalThis);
