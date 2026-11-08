"use strict";
// ALS early-flag symptom triage. A line-for-line port of the teammate's als_triage.py (python/als_triage.py), so the same rules run in the browser and on the server.
// src/test_triage.js runs the Python original and this port on hundreds of random answer sets and fails if they ever differ.
// Design principles (unchanged from the Python): AGE-BLIND (age is never asked or used); NEVER DOWNGRADE (atypical features only add things to rule out);
// TRANSPARENT (every tier comes from simple rules). Prototype decision support, not a diagnosis.
(function (root) {
  const SYMPTOMS = [
    { key: "fasc", label: "Muscle twitching (fasciculations)", group: "LMN", region: null, q: "Muscle twitching in an arm, leg, shoulder or tongue?" },
    { key: "cramp", label: "Frequent cramps", group: "LMN", region: null, q: "Frequent muscle cramps without a clear cause?" },
    { key: "arm_weak", label: "Arm/hand weakness", group: "LMN", region: "arms", q: "Progressive weakness in an arm or hand (dropping things, buttons, keys, jar lids)?" },
    { key: "wasting", label: "Muscle wasting", group: "LMN", region: "arms", q: "Visible muscle wasting (e.g. base of thumb / thenar, web between thumb and index finger)?" },
    { key: "leg_weak", label: "Leg weakness / foot drop", group: "LMN", region: "legs", q: "Progressive leg weakness, foot drop or tripping?" },
    { key: "neck_weak", label: "Neck weakness", group: "LMN", region: "trunk", q: "Trouble holding the head up (neck weakness)?" },
    { key: "spastic", label: "Spasticity / stiffness", group: "UMN", region: null, q: "Tight, stiff muscles (spasticity)?" },
    { key: "reflex", label: "Brisk reflexes / Hoffmann / Babinski (exam)", group: "UMN", region: null, q: "EXAM FINDING: brisk reflexes, Hoffmann or Babinski sign?" },
    { key: "speech", label: "Slurred/nasal speech", group: "bulbar", region: "bulbar", q: "Slurred or nasal speech?" },
    { key: "swallow", label: "Chewing/swallowing difficulty", group: "bulbar", region: "bulbar", q: "Difficulty chewing or swallowing, or choking on liquids?" },
    { key: "tongue", label: "Tongue weakness / drooling", group: "bulbar", region: "bulbar", q: "Tongue weakness or wasting, or excess drooling?" },
    { key: "dyspnea", label: "Breathlessness (exertion or lying flat)", group: "resp", region: "trunk", q: "Shortness of breath on exertion or when lying flat?" },
    { key: "hypovent", label: "Morning headache / poor sleep / daytime sleepiness", group: "resp", region: "trunk", q: "Morning headaches, poor sleep or daytime sleepiness?" },
    { key: "pba", label: "Uncontrollable laughing/crying", group: "other", region: null, q: "Sudden, uncontrollable laughing or crying?" },
    { key: "wtloss", label: "Unintentional weight loss", group: "other", region: null, q: "Unintentional weight loss?" },
    { key: "cog", label: "Behaviour / personality / language change", group: "other", region: null, q: "New changes in behaviour, personality or language?" },
  ];
  const PATTERN = [
    { key: "progressive", q: "Steadily worsening over weeks to months (not fluctuating)?" },
    { key: "asymmetric", q: "Started in one limb or on one side?" },
    { key: "spread", q: "Spread to a NEW body region since it started?" },
  ];
  // Atypical features: point to other diagnoses, never lower the ALS tier
  const RED_FLAGS = [
    { key: "sensory", q: "Numbness, tingling or sensory loss?", note: "Sensory symptoms are atypical for ALS. Consider neuropathy, radiculopathy or myelopathy (keep ALS on the list)." },
    { key: "sphincter", q: "Early bladder or bowel dysfunction?", note: "Early sphincter problems are atypical for ALS. Consider spinal cord or other CNS causes." },
    { key: "fluctuating", q: "Weakness worse at end of day, drooping eyelids or double vision?", note: "Fluctuating weakness or eye signs suggest myasthenia gravis or similar. Consider antibody testing." },
  ];
  // Age and sex are deliberately NOT here. Family history is the strongest known risk factor.
  const RISKS = [
    { key: "family", q: "Family history of ALS or frontotemporal dementia (or known ALS gene variant in family)?", strong: true },
    { key: "military", q: "Military service?", strong: false },
    { key: "head", q: "Significant head injury, repeated concussions or contact sport?", strong: false },
    { key: "smoking", q: "Current or former smoker?", strong: false },
    { key: "exposure", q: "Occupational/environmental exposure (pesticides, lead, solvents)?", strong: false },
  ];
  const TIERS = { 0: "NO ALS-TYPE PATTERN REPORTED", 1: "LOW - isolated findings", 2: "MODERATE - consider early work-up", 3: "HIGH - recommend prompt specialist referral" };
  const FOLLOW_UP_WEEKS = "4-6";   // placeholder from the Python: have a clinician confirm
  const A = (ans, k) => !!(ans && ans[k]);

  function triage(ans) {
    const present = SYMPTOMS.filter(s => A(ans, s.key));
    const lmn = present.filter(s => s.group === "LMN"), umn = present.filter(s => s.group === "UMN"), bulbar = present.filter(s => s.group === "bulbar");
    const regions = new Set(present.filter(s => s.region).map(s => s.region)), reasons = [];
    if (lmn.length) reasons.push("Lower motor neuron signs: " + lmn.map(s => s.label).join(", "));
    if (umn.length) reasons.push("Upper motor neuron signs: " + umn.map(s => s.label).join(", "));
    if (bulbar.length) reasons.push("Bulbar signs: " + bulbar.map(s => s.label).join(", "));
    if (regions.size) reasons.push("Body regions involved: " + [...regions].sort().join(", "));
    if (A(ans, "progressive")) reasons.push("Progressive course");
    if (A(ans, "asymmetric")) reasons.push("Focal / one-sided onset (typical of ALS)");
    if (A(ans, "spread")) reasons.push("Spread to a new region");
    if (lmn.length && umn.length) reasons.push("BOTH upper and lower motor neuron signs present");
    const n = present.length; let tier;
    if (n === 0) tier = 0;
    else if (A(ans, "progressive") && ((lmn.length && umn.length) || regions.size >= 2 || A(ans, "spread"))) tier = 3;
    else if ((A(ans, "progressive") && (lmn.length || umn.length || bulbar.length)) || n >= 3 || (A(ans, "asymmetric") && lmn.length)) tier = 2;
    else tier = 1;
    if (A(ans, "family") && n >= 1 && tier < 3) { tier += 1; reasons.push("Family history bumped the tier up one level"); }   // never down
    return { tier, reasons };
  }
  function nextSteps(tier, ans) {
    const steps = [];
    if (tier >= 3) steps.push("Prompt neurology referral (ideally a neuromuscular / ALS clinic)", "EMG / nerve conduction studies", "Blood work: neurofilament light chain, creatine kinase");
    else if (tier === 2) steps.push("Consider EMG / nerve conduction studies and neurology review", "Blood work: neurofilament light chain, creatine kinase", `Short-interval re-check (e.g. ${FOLLOW_UP_WEEKS} weeks); refer sooner if worsening or spreading`);
    else if (tier === 1) steps.push(`Document findings and re-evaluate in ~${FOLLOW_UP_WEEKS} weeks, or sooner if progressing or spreading`);
    if (tier >= 2) {
      if (A(ans, "speech") || A(ans, "swallow") || A(ans, "tongue")) steps.push("Speech and swallowing evaluation (bulbar symptoms)");
      if (A(ans, "dyspnea") || A(ans, "hypovent")) steps.push("Spirometry (FVC) sitting AND lying flat; consider sleep/respiratory review");
      if (A(ans, "family")) steps.push("Genetic counselling and ALS gene panel (C9orf72, SOD1, TARDBP, FUS)");
    }
    return steps;
  }
  // Everything the Python report() prints, as data. months: number of months since the first symptom (or null).
  function evaluate(ans) {
    if (A(ans, "sudden")) return { emergency: true, message: "Sudden, stroke-like onset is not a typical ALS pattern and may be an emergency. Arrange urgent emergency evaluation. This tool is not designed for that situation." };
    const { tier, reasons } = triage(ans), months = ans && ans.months != null && ans.months !== "" ? Number(ans.months) : null;
    return {
      emergency: false, tier, tierLabel: TIERS[tier], reasons,
      atypical: RED_FLAGS.filter(r => A(ans, r.key)).map(r => r.note),
      risks: RISKS.filter(r => A(ans, r.key)).map(r => ({ text: r.q.replace(/\?$/, ""), tag: r.strong ? "strongest known risk factor" : "modest / mixed evidence" })),
      steps: nextSteps(tier, ans),
      timeSensitive: tier >= 2 && months && months >= 6 ? `Symptoms have lasted ${+months.toFixed(2)} months with an ALS-type pattern. Avoid further delay.` : null,
      notes: ["Age was not asked or used. Please do not attribute these findings to age (old or young) without a work-up.", "Prototype decision-support aid. It does not diagnose ALS and cannot replace clinical judgment or specialist evaluation."],
    };
  }
  const api = { SYMPTOMS, PATTERN, RED_FLAGS, RISKS, TIERS, FOLLOW_UP_WEEKS, triage, nextSteps, evaluate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Triage = api;
})(typeof window !== "undefined" ? window : globalThis);
