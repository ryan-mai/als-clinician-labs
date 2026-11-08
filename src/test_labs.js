const L = require("../labs.js"), ref = require("../lab_reference.json"), pts = require("../synthetic_patients.json");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const n = ref.nefl, exp62 = n.ctl_intercept + n.ctl_age_slope * 62;
const lo = L.scoreNfl(ref, 62, exp62), hi = L.scoreNfl(ref, 62, exp62 + 3 * n.ctl_resid_sd);
ok(Math.abs(lo.z) < 1e-9 && lo.pctControls > 50 && lo.pctControls < 75 && !lo.flag, "expected value -> z0, ~65th pct (controls are right-skewed)");
ok(hi.z > 2.9 && hi.flag && hi.pctControls > 95, "3 SD above -> flagged");
ok(L.scoreRoutine(ref, "creatinine", 0.4).flag === "low" && L.scoreRoutine(ref, "ck", 500).flag === "high" && L.scoreRoutine(ref, "albumin", 4).flag === "in range", "routine flags");
const alsP = pts.filter(p => p.label === "ALS-like"), ctlP = pts.filter(p => p.label === "control-like");
const fl = a => a.filter(p => L.scorePatient(ref, p).find(r => r.analyte === "nefl").flag).length / a.length;
console.log(`NfL flagged: ALS-like ${(100 * fl(alsP)).toFixed(0)}% (n=${alsP.length}), control-like ${(100 * fl(ctlP)).toFixed(0)}% (n=${ctlP.length})`);
ok(L.scorePatient(ref, { age: 60, labs: {} }).length === 0, "empty labs");
console.log(bad ? bad + " failures" : "all labs tests passed");
// aggregate + csv
const ag = L.aggregate(ref, pts), nf = ag.rows.find(r => r.id === "nefl");
ok(ag.n_patients === 31 && nf.n === 30 && nf.byLabel["ALS-like"].median > nf.byLabel["control-like"].median, "aggregate nfl by label");
const pc = L.parseCsv("code,age,sex,nefl,creatinine\nSYN-900,61,F,14.2,0.7\n123456789,60,M,12,1\nSYN-901,xx,M,1,1\nSYN-902,50,M,,");
ok(pc.patients.length === 1 && pc.errors.length === 3, "csv validation: " + JSON.stringify(pc.errors));
ok(L.scoreRoutine(ref, "grip_rate_r", 1.2).flag === "no reference range", "grip has no reference range");
ok(L.parseCsv("code,age,grip_rate_r\nSYN-1,60,1.2").patients[0].labs.grip_rate_r === 1.2, "csv accepts grip");
ok(L.parseCsv(L.toCsv(pts)).patients.length === 31, "csv round trip");
// every reference analyte must be accepted by the CSV parser (keeps IDS in labs.js in sync with the reference)
const ids = ["nefl", ...ref.labs.map(l => l.id)], pcs = L.parseCsv("code,age," + ids.join(",") + "\nSYN-X,50," + ids.map(() => 1).join(","));
ok(pcs.patients.length === 1 && Object.keys(pcs.patients[0].labs).length === ids.length, "csv accepts all reference analytes: " + JSON.stringify(pcs.errors) + " " + (pcs.patients[0] ? Object.keys(pcs.patients[0].labs).length : 0) + "/" + ids.length);
// Alex case + helpers
const alex = pts.find(p => p.code === "ALEX-CASE"), asy = L.asymmetry(alex.labs);
ok(alex && Math.abs(asy.find(a => a.name.startsWith("Dynamometer")).ratio - 14 / 32) < 1e-9, "alex grip ratio");
ok(L.scoreRoutine(ref, "walk10m_s", 14.2).flag === "high" && L.scoreRoutine(ref, "fvc_sit_pct", 76).flag === "low" && L.scoreRoutine(ref, "snip_cmh2o", 52).flag === "low" && L.scoreRoutine(ref, "ck", 470).flag === "high", "alex flags");
ok(L.isCamera("foot_amp_r") && !L.isCamera("grip_kg_r"), "isCamera");
const hist = [{ t: "a", period: "morning", labs: { foot_amp_r: 12, foot_speed_r: 30 } }, { t: "b", period: "evening", labs: { foot_amp_r: 6, foot_speed_r: 15 } }];
const dn = L.diurnal(L.cameraRows(hist)); ok(dn.length === 1 && Math.abs(dn[0].ampChange + 50) < 1e-9, "diurnal -50%");
console.log(bad ? bad + " failures" : "aggregate/csv/case tests passed");
