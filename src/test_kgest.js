"use strict";
const K = require("../kgest.js"), G = require("../grip.js"); let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const DAY = 864e5;
// pinch signal: thumb tip to index tip, in palm lengths
const hand = d => { const a = Array.from({ length: 21 }, () => ({ x: .5, y: .5 })); a[0] = { x: .5, y: .8 }; a[9] = { x: .5, y: .6 }; a[4] = { x: .5, y: .4 }; a[8] = { x: .5 + .2 * d, y: .4 }; return a; };   // palm = 0.2
ok(Math.abs(K.pinch(hand(0), 100, 100)) < 1e-9 && Math.abs(K.pinch(hand(1), 100, 100) - 1) < 1e-9, "pinch open vs closed");
const sim = (f, amp, secs = 10) => { const fr = []; for (let i = 0; i < secs * 30; i++) { const t = i / 30; fr.push({ t, c: 0.6 + 0.5 * amp * Math.cos(2 * Math.PI * f * t) }); } return fr; };
const strong = G.analyze(sim(1.2, 1.0), K.PINCH_OPTS), weak = G.analyze(sim(0.8, 0.5), K.PINCH_OPTS);
ok(strong.valid && weak.valid, "pinch cycles detected: " + JSON.stringify([strong.reasons, weak.reasons]));
const ss = K.score(strong), sw = K.score(weak); ok(ss > sw * 1.3, "stronger movement scores higher " + ss + " vs " + sw);
ok(K.score(null) === null && K.score({ amp: 0, speed: 1, rate: 1 }) === null, "score needs a valid analysis");
ok(!G.analyze(sim(1.2, 0.1), K.PINCH_OPTS).valid, "tiny pinch movement rejected");
ok(K.toValues(strong, "pinch", "l").pinch_score_l === +ss.toFixed(3) && Object.keys(K.toValues({ valid: false }, "grip", "r")).length === 0, "toValues naming");
// anchoring: first-week median score maps to the nearest clinic kg; a 50% drop in score -> 50% of the anchor kg
const t0 = Date.UTC(2026, 0, 1), series = [[0, 1.0], [2, 1.02], [4, .98], [20, .75], [40, .5]].map(([d, v]) => ({ t: t0 + d * DAY, v }));
const e = K.estimate(series, [{ t: t0 + 3 * DAY, kg: 14 }, { t: t0 + 60 * DAY, kg: 7 }]);
ok(e && e.anchorKg === 14 && Math.abs(e.anchorScore - 1) < 1e-9, "anchor picks clinic reading nearest baseline " + JSON.stringify(e && [e.anchorKg, e.anchorScore]));
ok(e && e.est[0].kg === 14 && e.est[3].kg === 10.5 && e.est[4].kg === 7, "estimate scales with score " + JSON.stringify(e && e.est.map(x => x.kg)));
ok(K.estimate(series, []) === null && K.estimate([], [{ t: 1, kg: 5 }]) === null, "no clinic reading or no scores -> null");
ok(K.estimate([{ t: t0, v: 5 }], [{ t: t0, kg: 10 }]).est[0].kg === 10, "single session");
ok(K.estimate([{ t: t0, v: 1 }, { t: t0 + 40 * DAY, v: 9 }], [{ t: t0, kg: 10 }]).est[1].kg <= 15, "estimate capped at 1.5x anchor");
console.log(bad ? bad + " failures" : "all kgest tests passed"); process.exit(bad ? 1 : 0);
