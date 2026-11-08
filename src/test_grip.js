const G = require("../grip.js"); let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
// synthetic fist cycling: closure between 2.0 (open) and 1.0 (fist) at f Hz, 30 fps, amplitude decay per second
const sim = (f, secs, decay = 0, miss = 0, amp = 1.0, fps = 30) => { const fr = []; for (let i = 0; i < secs * fps; i++) { const t = i / fps, a = amp * Math.exp(-decay * t); fr.push({ t, c: Math.random() < miss ? null : 1.5 + 0.5 * a * Math.cos(2 * Math.PI * f * t) }); } return fr; };
let r = G.analyze(sim(1.0, 10));
ok(r.valid && Math.abs(r.rate - 1.0) < 0.1 && Math.abs(r.amp - 1.0) < 0.15 && Math.abs(r.decrement) < 10, "steady 1 Hz: " + JSON.stringify(r));
r = G.analyze(sim(1.5, 10)); ok(r.valid && Math.abs(r.rate - 1.5) < 0.15, "1.5 Hz rate " + r.rate);
r = G.analyze(sim(1.0, 10, 0.1)); ok(r.valid && r.decrement < -25 && r.decrement > -80, "decay gives negative decrement " + r.decrement);
ok(!G.analyze(sim(1.0, 10, 0, 0.5)).valid, "rejects hand missing 50%");
ok(!G.analyze(sim(1.0, 10, 0, 0, 0.2)).valid, "rejects tiny movement");
const fo = (f, secs, rng) => { const fr = []; for (let i = 0; i < secs * 30; i++) fr.push({ t: i / 30, c: 90 - rng / 2 + rng / 2 * Math.cos(2 * Math.PI * f * i / 30) }); return fr; };
let rf = G.analyze(fo(0.8, 12, 30), { minRange: 8 }); ok(rf.valid && Math.abs(rf.rate - 0.8) < 0.1 && Math.abs(rf.amp - 30) < 4, "foot 30 deg at 0.8/s " + JSON.stringify(rf));
ok(!G.analyze(fo(0.8, 12, 4), { minRange: 8 }).valid, "foot: rejects 4 deg movement");
const pl = (tx, ty) => { const a = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 })); a[26] = { x: .5, y: .3, visibility: 1 }; a[28] = { x: .5, y: .7, visibility: 1 }; a[32] = { x: tx, y: ty, visibility: 1 }; return a; };
ok(Math.abs(G.ankleAngle(pl(.7, .7), "r", 100, 100) - 90) < 1e-6 && G.ankleAngle(pl(.7, .55), "r", 100, 100) < 90 && G.ankleAngle(pl(.7, .85), "r", 100, 100) > 90, "ankle angle neutral/up/down");
const bl = pl(.7, .7); bl[32].visibility = .2; ok(G.ankleAngle(bl, "r", 100, 100) === null, "low visibility -> null");
ok(G.toLabs({ rate: 1, amp: 2, speed: 3, decrement: -4 }, "foot", "l").foot_decrement_l === -4, "toLabs naming");
ok(!G.analyze(sim(0.2, 10)).valid, "rejects <4 cycles");
ok(!G.analyze(sim(1.0, 4)).valid, "rejects short recording");
ok(!G.analyze([]).valid, "empty");
// closure from landmarks: open hand vs fist
const lm = tip => { const a = Array.from({ length: 21 }, () => ({ x: .5, y: .5 })); a[0] = { x: .5, y: .8 }; a[9] = { x: .5, y: .6 }; for (const i of G.TIPS) a[i] = { x: .5, y: tip }; return a; };
ok(Math.abs(G.closure(lm(0.2), 640, 480) - 3) < 1e-9 && G.closure(lm(0.7), 640, 480) < 1, "closure open>closed");
// noisy foot signal (SD 4 deg + 3% spikes): smoothed analysis must recover range and speed; raw must not (documents the jitter problem)
{ let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }, gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const fr = []; for (let i = 0; i < 360; i++) { const t = i / 30; let c = 75 + 15 * Math.cos(2 * Math.PI * 0.8 * t) + 4 * gs(); if (rnd() < 0.03) c += (rnd() < .5 ? -1 : 1) * (15 + 15 * rnd()); fr.push({ t, c }); }
  const raw = G.analyze(fr, { minRange: 8 }), sm = G.analyze(fr, { minRange: 8, med: 2, mean: 3 });
  ok(sm.valid && Math.abs(sm.rate - 0.8) < 0.1 && Math.abs(sm.amp - 30) < 4.5 && Math.abs(sm.speed - 75) < 15 && Math.abs(sm.decrement) < 10, "smoothed recovers: " + JSON.stringify(sm));
  ok(raw.speed > 100, "raw speed is inflated by jitter (" + raw.speed.toFixed(0) + ")");
  const f = G.oneEuro(1.2, 0.02), out = fr.map(x => f(x.c, x.t)), sd = a => { const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); };
  const d1 = a => a.slice(1).map((x, i) => x - a[i]); ok(sd(d1(out)) < sd(d1(fr.map(x => x.c))) * 0.5, "oneEuro halves frame-to-frame jitter");
  const st = G.oneEuro(1, 0); const fl = Array.from({ length: 30 }, (_, i) => st(5, i / 30)); ok(fl.every(v => v === 5), "oneEuro passes constants"); }
console.log(bad ? bad + " failures" : "grip tests passed");
