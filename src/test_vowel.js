"use strict";
const V = require("../vowel.js"), LJ = require("../lipjaw.js"); let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
// source-filter synthesis: impulse train at f0 through cascaded 2nd-order resonators at the given formants
function synth(forms, secs, sr = 44100, f0 = 120, noise = 0.002) {
  const n = Math.floor(secs * sr), x = new Float64Array(n); let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  const per = Math.round(sr / f0); for (let i = 0; i < n; i += per) x[i] = 1;
  let y = x; for (let p = 0; p < 2; p++) { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = 0.03 * y[i] + 0.97 * (i ? o[i - 1] : 0); y = o; }   // glottal tilt (about -12 dB/octave)
  for (const [f, bw] of forms) {
    const r = Math.exp(-Math.PI * bw / sr), c1 = 2 * r * Math.cos(2 * Math.PI * f / sr), c2 = -r * r, o = new Float64Array(n);
    for (let i = 0; i < n; i++) o[i] = y[i] + c1 * (i > 0 ? o[i - 1] : 0) + c2 * (i > 1 ? o[i - 2] : 0); y = o;
  }
  y = Float64Array.from(y, (v, i) => v - (i ? y[i - 1] : 0));   // lip radiation (+6 dB/octave)
  let mx = 0; for (const v of y) mx = Math.max(mx, Math.abs(v)); const pad = Math.round(0.5 * sr), env = i => (i < pad || i > n - pad ? 0 : Math.min(1, (i - pad) / (0.1 * sr), (n - pad - i) / (0.1 * sr)));   // 0.5 s of room noise either side, like the app records
  return Float32Array.from(y, (v, i) => 0.6 * v / mx * env(i) + noise * rnd());
}
const SETS = { i: [[300, 60], [2300, 100], [3000, 150], [3800, 200]], a: [[800, 80], [1300, 90], [2600, 150], [3600, 200]], u: [[320, 60], [900, 80], [2400, 150], [3400, 200]] };
const got = {};
for (const [k, forms] of Object.entries(SETS)) {
  const r = V.analyzeVowel(synth(forms, 3), 44100); got[k] = r;
  ok(r.valid, "vowel " + k + " valid: " + JSON.stringify(r.reasons));
  ok(r.valid && Math.abs(r.f1 - forms[0][0]) / forms[0][0] < 0.2 &&   /* low F1 sits between harmonics at f0=120 Hz, so it is only good to about 20% */ Math.abs(r.f2 - forms[1][0]) / forms[1][0] < 0.1, `vowel ${k} F1/F2 ${r.f1 && r.f1.toFixed(0)}/${r.f2 && r.f2.toFixed(0)} vs ${forms[0][0]}/${forms[1][0]}`);
}
const sp = V.vowelSpace(got);
ok(sp && sp.vsa > 0.25 && sp.vsa < 0.45 && sp.vcr > 0.7 && sp.vcr < 1.0, "healthy-like vowel space " + JSON.stringify(sp));
// centralized vowels (all formants pulled toward the middle) -> smaller area, higher VCR
const C = { i: [[420, 80], [1900, 100], [3000, 150], [3800, 200]], a: [[650, 80], [1450, 90], [2600, 150], [3600, 200]], u: [[420, 70], [1150, 80], [2400, 150], [3400, 200]] }, gc = {};
for (const [k, f] of Object.entries(C)) gc[k] = V.analyzeVowel(synth(f, 3), 44100);
const sc = V.vowelSpace(gc); ok(sc && sc.vsa < sp.vsa * 0.6 && sc.vcr > sp.vcr, "centralized: smaller area, higher VCR " + JSON.stringify(sc));
ok(!V.analyzeVowel(synth(SETS.a, 0.5), 44100).valid, "too short rejected");
ok(!V.analyzeVowel(Float32Array.from({ length: 44100 * 3 }, () => (Math.random() - 0.5) * 0.01), 44100).valid, "noise rejected");
ok(V.vowelSpace({ i: got.i, a: got.a }) === null, "needs all three vowels");
ok(V.toValues({ vsa: 0.31234, vcr: 0.91234 }).vowel_vsa === 0.312, "toValues rounding");
// lip / jaw
const face = (open, width, jaw) => { const a = Array.from({ length: 478 }, () => ({ x: .5, y: .5 })); a[33] = { x: .4, y: .4 }; a[263] = { x: .6, y: .4 }; a[13] = { x: .5, y: .6 - open / 10 }; a[14] = { x: .5, y: .6 + open / 10 }; a[61] = { x: .5 - width / 10, y: .6 }; a[291] = { x: .5 + width / 10, y: .6 }; a[2] = { x: .5, y: .5 }; a[152] = { x: .5, y: .5 + jaw / 5 }; return a; };
const m = LJ.mouth(face(0.5, 1, 1), 100, 100); ok(Math.abs(m.open - 0.5) < 1e-9 && Math.abs(m.width - 1) < 1e-9 && Math.abs(m.jaw - 1) < 1e-9, "mouth features " + JSON.stringify(m));
const fr = []; for (let i = 0; i < 90; i++) { const t = i / 30, j = 1 + 0.3 * Math.sin(2 * Math.PI * 2 * t); fr.push({ t, open: 0.2 + 0.1 * Math.sin(2 * Math.PI * 2 * t), width: 1, jaw: j }); }
const s = LJ.summarize(fr); ok(s.valid && Math.abs(s.jawRange - 0.54) < 0.1 && s.jawSpeed > 1 && s.jawSpeed < 5, "lip/jaw summary " + JSON.stringify(s));
ok(!LJ.summarize(fr.map((f, i) => (i % 2 ? { t: f.t, open: null } : f))).valid, "face lost half the time rejected");
ok(LJ.mouth(null, 100, 100) === null, "no face -> null");
console.log(bad ? bad + " failures" : "all vowel/lip tests passed"); process.exit(bad ? 1 : 0);
