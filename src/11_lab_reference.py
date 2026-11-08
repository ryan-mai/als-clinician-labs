"""Build lab-biomarker reference data for the clinician labs tab.
NfL: empirical, from Kim et al. plasma cohorts (Olink NPQ, log2 units; NOT pg/mL).
Routine labs: generic adult lab ranges (NOT ALS-validated); ALS direction is qualitative.
Synthetic patients: NfL drawn from the cohort fit, other labs invented. Not real people.
Writes lab_reference.json, synthetic_patients.json, supabase/seed.sql."""
import json, numpy as np, pandas as pd
from scipy import stats
rng = np.random.default_rng(7)
P = "data/kim/"
d = pd.concat([pd.read_csv(P + f"{c}_cohort_traits.csv").merge(pd.read_csv(P + f"{c}_cohort_cns_npq.csv")[["targetName", "NEFL"]], on="targetName").assign(cohort=c)
               for c in ("development", "validation")], ignore_index=True)
ctl, als = d[d.ALS_status == 0], d[d.ALS_status == 1]
sl, ic, *_ = stats.linregress(ctl.AgeSample, ctl.NEFL)
res = ctl.NEFL - (ic + sl * ctl.AgeSample); sd = float(res.std(ddof=2))
ares = als.NEFL - (ic + sl * als.AgeSample)
rho = stats.spearmanr(als.dropna(subset=["ALSFRS-R"]).NEFL, als.dropna(subset=["ALSFRS-R"])["ALSFRS-R"])
from sklearn.metrics import roc_auc_score
auc = roc_auc_score(d.ALS_status, d.NEFL - sl * d.AgeSample)
nefl = dict(units="log2 NPQ (Olink, relative; not pg/mL)", n_control=len(ctl), n_als=len(als), ctl_intercept=ic, ctl_age_slope=sl, ctl_resid_sd=sd,
            als_resid_mean=float(ares.mean()), als_resid_sd=float(ares.std()), age_adj_auc=float(auc), rho_alsfrs=float(rho.statistic), rho_p=float(rho.pvalue),
            ctl_resid_sorted=[round(x, 3) for x in sorted(res)], als_resid_sorted=[round(x, 3) for x in sorted(ares)])
# generic adult ranges (typical lab values); direction = qualitative literature trend in ALS
labs = [
 dict(id="creatinine", name="Creatinine", unit="mg/dL", lo=0.6, hi=1.3, als="Lower / falling = less muscle mass, worse outlook", note="Depends on kidney function"),
 dict(id="ck", name="Creatine kinase (CK)", unit="U/L", lo=30, hi=200, als="Often mildly raised", note="Very nonspecific"),
 dict(id="albumin", name="Albumin", unit="g/dL", lo=3.5, hi=5.0, als="Higher tends to go with longer survival", note="Group-level finding"),
 dict(id="uric_acid", name="Uric acid", unit="mg/dL", lo=3.5, hi=7.2, als="Higher tends to go with longer survival", note="Group-level finding"),
 dict(id="bicarbonate", name="Bicarbonate", unit="mmol/L", lo=22, hi=29, als="Rising can suggest CO2 retention (weak breathing)", note="Late sign; check FVC"),
 dict(id="crp", name="CRP", unit="mg/L", lo=0, hi=5, als="Higher linked to faster decline in some cohorts", note="Nonspecific"),
 # --- camera movement tests (patient page): per side, no validated reference range -> track within patient and compare sides
]
for kind, title, unit_amp, unit_speed, rate_u in (("grip", "Fist open-close", "palm lengths", "palm lengths/s", "closures/s"), ("foot", "Toe-lift", "degrees", "degrees/s", "lifts/s")):
    for side, sname in (("r", "right"), ("l", "left")):
        for m, nm, u, als in (("rate", "rate", rate_u, "Slower can reflect weakness or slowness"),
                              ("amp", "range", unit_amp, "Smaller range can reflect weakness or stiffness"),
                              ("speed", "speed", unit_speed, "Slower can reflect weakness"),
                              ("decrement", "decline over test", "% first vs last third", "A bigger drop suggests fatigue")):
            labs.append(dict(id=f"{kind}_{m}_{side}", name=f"{title} {nm}, {sname} (camera)", unit=u, lo=None, hi=None, als=als,
                             note="Camera movement proxy, not force; no reference range" + ("; needs 6+ repetitions" if m == "decrement" else "")))
# --- measurements from the BioHacks 2026 case file for Alex Chen (fictional). Reference text is the case file's own.
labs += [
 dict(id="nfl_pgml", name="Serum NfL", unit="pg/mL", lo=None, hi=None, als="Raised in ALS; cutoff rises with age", note="Case file: below 15 pg/mL at age 47. Age-specific cutoff needed, so not flagged here"),
 dict(id="grip_kg_r", name="Grip, dynamometer, right", unit="kg", lo=None, hi=None, als="Reduced on the weak side", note="Case file typical about 48 kg"),
 dict(id="grip_kg_l", name="Grip, dynamometer, left", unit="kg", lo=None, hi=None, als="Reduced on the weak side", note="Case file typical about 48 kg"),
 dict(id="walk10m_s", name="10-metre walk", unit="s", lo=0, hi=8, als="Slower with leg weakness", note="Case file typical under 8 s"),
 dict(id="fvc_sit_pct", name="FVC sitting", unit="% predicted", lo=80, hi=150, als="Falls as breathing muscles weaken", note="Case file reference above 80"),
 dict(id="fvc_supine_pct", name="FVC lying flat", unit="% predicted", lo=None, hi=None, als="A fall of more than 10 points vs sitting suggests diaphragm weakness", note="Compare with sitting value"),
 dict(id="snip_cmh2o", name="Sniff nasal inspiratory pressure", unit="cmH2O", lo=70, hi=250, als="Falls with diaphragm weakness", note="Case file reference above 70"),
]
ref = dict(nefl=nefl, labs=labs, source_note="NfL from Kim et al. plasma cohorts (Synapse). Routine ranges are generic adult ranges, not derived from ALS data. Research demo; not diagnostic.")
json.dump(ref, open("lab_reference.json", "w"), separators=(",", ":"))
# synthetic patients
pts = []
for i in range(30):
    isals = rng.random() < .75; age = int(np.clip(rng.normal(62, 9), 35, 85)); sex = rng.choice(["F", "M"])
    resid = rng.normal(nefl["als_resid_mean"], nefl["als_resid_sd"]) if isals else rng.normal(0, sd)
    frs = int(np.clip(rng.normal(38, 7), 12, 48)) if isals else None
    cr = round(float(np.clip(rng.normal(0.85 if isals else 0.95, .2), .4, 1.8)), 2)
    pts.append(dict(code=f"SYN-{i+1:03d}", age=age, sex=sex, synthetic=True, label="ALS-like" if isals else "control-like", alsfrs_r=frs,
        labs=dict(nefl=round(ic + sl * age + resid, 3), creatinine=cr, ck=int(np.clip(rng.lognormal(5.2 if isals else 4.7, .5), 30, 1500)),
                  albumin=round(float(rng.normal(4.1, .3)), 1), uric_acid=round(float(rng.normal(5.0 if isals else 5.5, 1.1)), 1),
                  bicarbonate=round(float(rng.normal(27 if isals else 25.5, 2)), 1), crp=round(float(rng.lognormal(.6, .9)), 1))))
# Alex Chen: fictional case from the BioHacks 2026 hacker package (values from his file, 12-22 June / 22 Sept 2026 measurements)
pts.append(dict(code="ALEX-CASE", age=47, sex="M", synthetic=True, label="case file (fictional)", alsfrs_r=32,
    labs=dict(ck=470, nfl_pgml=88, grip_kg_r=14, grip_kg_l=32, walk10m_s=14.2, fvc_sit_pct=76, fvc_supine_pct=61, snip_cmh2o=52)))
json.dump(pts, open("synthetic_patients.json", "w"), separators=(",", ":"))
q = lambda s: "'" + str(s).replace("'", "''") + "'"
with open("supabase/seed.sql", "w") as f:
    f.write("-- Synthetic demo patients (not real people). Run after schema.sql.\n")
    for p in pts:
        f.write(f"insert into patients(code,age,sex,synthetic,label,alsfrs_r) values({q(p['code'])},{p['age']},{q(p['sex'])},true,{q(p['label'])},{p['alsfrs_r'] if p['alsfrs_r'] else 'null'}) on conflict(code) do nothing;\n")
        for k, v in p["labs"].items():
            f.write(f"insert into lab_results(patient_id,analyte,value) select id,{q(k)},{v} from patients where code={q(p['code'])};\n")
print(f"NfL: slope {sl:.3f}/yr, resid SD {sd:.2f}, ALS mean resid {ares.mean():+.2f}, age-adj AUC {auc:.2f}, rho(ALSFRS-R) {rho.statistic:+.2f} p={rho.pvalue:.1e}")
