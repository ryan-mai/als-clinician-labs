"""
ALS Early-Flag Triage  (hackathon prototype)
--------------------------------------------
A <5 minute symptom + risk-factor screen for clinicians seeing a patient with
neurological symptoms. It suggests whether the patient should be considered for
earlier ALS work-up. Optionally chains into the biomarker module (als_screener.py).

Design principles
  * AGE-BLIND: age is never asked, stored, or used. Neither "too old" nor "too young"
    can lower the result.
  * NEVER DOWNGRADE: atypical features (e.g. sensory loss) are shown as notes that point
    to other diagnoses to rule out. They do not lower the ALS-pattern tier.
  * TRANSPARENT: every tier comes from simple rules you can read and explain.

Keep als_screener.py in the same folder.   Run:  python als_triage.py
"""

import als_screener as bio

# ----------------------------------------------------------------------------
# QUESTIONS
# group: LMN = lower motor neuron signs, UMN = upper motor neuron signs
# region: body region used to count how widely the motor problem is spread
# ----------------------------------------------------------------------------
SYMPTOMS = [
    dict(key="fasc", label="Muscle twitching (fasciculations)", group="LMN", region=None,
         q="Muscle twitching in an arm, leg, shoulder or tongue?"),
    dict(key="cramp", label="Frequent cramps", group="LMN", region=None,
         q="Frequent muscle cramps without a clear cause?"),
    dict(key="arm_weak", label="Arm/hand weakness", group="LMN", region="arms",
         q="Progressive weakness in an arm or hand (dropping things, buttons, keys, jar lids)?"),
    dict(key="wasting", label="Muscle wasting", group="LMN", region="arms",
         q="Visible muscle wasting (e.g. base of thumb / thenar, web between thumb and index finger)?"),
    dict(key="leg_weak", label="Leg weakness / foot drop", group="LMN", region="legs",
         q="Progressive leg weakness, foot drop or tripping?"),
    dict(key="neck_weak", label="Neck weakness", group="LMN", region="trunk",
         q="Trouble holding the head up (neck weakness)?"),
    dict(key="spastic", label="Spasticity / stiffness", group="UMN", region=None,
         q="Tight, stiff muscles (spasticity)?"),
    dict(key="reflex", label="Brisk reflexes / Hoffmann / Babinski (exam)", group="UMN", region=None,
         q="EXAM FINDING: brisk reflexes, Hoffmann or Babinski sign?"),
    dict(key="speech", label="Slurred/nasal speech", group="bulbar", region="bulbar",
         q="Slurred or nasal speech?"),
    dict(key="swallow", label="Chewing/swallowing difficulty", group="bulbar", region="bulbar",
         q="Difficulty chewing or swallowing, or choking on liquids?"),
    dict(key="tongue", label="Tongue weakness / drooling", group="bulbar", region="bulbar",
         q="Tongue weakness or wasting, or excess drooling?"),
    dict(key="dyspnea", label="Breathlessness (exertion or lying flat)", group="resp", region="trunk",
         q="Shortness of breath on exertion or when lying flat?"),
    dict(key="hypovent", label="Morning headache / poor sleep / daytime sleepiness", group="resp", region="trunk",
         q="Morning headaches, poor sleep or daytime sleepiness?"),
    dict(key="pba", label="Uncontrollable laughing/crying", group="other", region=None,
         q="Sudden, uncontrollable laughing or crying?"),
    dict(key="wtloss", label="Unintentional weight loss", group="other", region=None,
         q="Unintentional weight loss?"),
    dict(key="cog", label="Behaviour / personality / language change", group="other", region=None,
         q="New changes in behaviour, personality or language?"),
]

PATTERN = [
    dict(key="progressive", q="Steadily worsening over weeks to months (not fluctuating)?"),
    dict(key="asymmetric", q="Started in one limb or on one side?"),
    dict(key="spread", q="Spread to a NEW body region since it started?"),
]

# Atypical features: point to other diagnoses, never lower the ALS tier
RED_FLAGS = [
    dict(key="sensory", q="Numbness, tingling or sensory loss?",
         note="Sensory symptoms are atypical for ALS. Consider neuropathy, radiculopathy or myelopathy (keep ALS on the list)."),
    dict(key="sphincter", q="Early bladder or bowel dysfunction?",
         note="Early sphincter problems are atypical for ALS. Consider spinal cord or other CNS causes."),
    dict(key="fluctuating", q="Weakness worse at end of day, drooping eyelids or double vision?",
         note="Fluctuating weakness or eye signs suggest myasthenia gravis or similar. Consider antibody testing."),
]

# Age and sex are deliberately NOT here. Most of these have modest or mixed evidence;
# family history is the strongest.
RISKS = [
    dict(key="family", q="Family history of ALS or frontotemporal dementia (or known ALS gene variant in family)?",
         strong=True),
    dict(key="military", q="Military service?", strong=False),
    dict(key="head", q="Significant head injury, repeated concussions or contact sport?", strong=False),
    dict(key="smoking", q="Current or former smoker?", strong=False),
    dict(key="exposure", q="Occupational/environmental exposure (pesticides, lead, solvents)?", strong=False),
]

TIERS = {
    0: "NO ALS-TYPE PATTERN REPORTED",
    1: "LOW - isolated findings",
    2: "MODERATE - consider early work-up",
    3: "HIGH - recommend prompt specialist referral",
}

FOLLOW_UP_WEEKS = "4-6"   # placeholder: have a clinician confirm


# ----------------------------------------------------------------------------
# INPUT
# ----------------------------------------------------------------------------
def yn(question):
    return input(f"  {question} [y/N] ").strip().lower().startswith("y")


def section(title):
    print(f"\n--- {title} ---  (y = yes, Enter = no)")


def ask_months():
    while True:
        raw = input("  Months since the FIRST symptom (Enter to skip): ").strip()
        if raw == "":
            return None
        try:
            return float(raw)
        except ValueError:
            print("   Please enter a number or press Enter.")


def collect():
    ans = {}
    section("Urgent check")
    ans["sudden"] = yn("Did symptoms start suddenly (minutes to hours), stroke-like?")
    if ans["sudden"]:
        return ans

    section("Course")
    ans["months"] = ask_months()
    for p in PATTERN:
        ans[p["key"]] = yn(p["q"])

    section("Symptoms and exam findings")
    for s in SYMPTOMS:
        ans[s["key"]] = yn(s["q"])

    section("Atypical features")
    for r in RED_FLAGS:
        ans[r["key"]] = yn(r["q"])

    section("Risk factors")
    for r in RISKS:
        ans[r["key"]] = yn(r["q"])
    return ans


# ----------------------------------------------------------------------------
# LOGIC
# ----------------------------------------------------------------------------
def triage(ans):
    """Returns (tier, reasons). Rule-based, loosely inspired by the lower/upper motor
    neuron + body-region idea in the El Escorial criteria. Not a diagnostic criteria set."""
    present = [s for s in SYMPTOMS if ans[s["key"]]]
    lmn = [s for s in present if s["group"] == "LMN"]
    umn = [s for s in present if s["group"] == "UMN"]
    bulbar = [s for s in present if s["group"] == "bulbar"]
    regions = {s["region"] for s in present if s["region"]}

    reasons = []
    if lmn:
        reasons.append("Lower motor neuron signs: " + ", ".join(s["label"] for s in lmn))
    if umn:
        reasons.append("Upper motor neuron signs: " + ", ".join(s["label"] for s in umn))
    if bulbar:
        reasons.append("Bulbar signs: " + ", ".join(s["label"] for s in bulbar))
    if regions:
        reasons.append("Body regions involved: " + ", ".join(sorted(regions)))
    if ans["progressive"]:
        reasons.append("Progressive course")
    if ans["asymmetric"]:
        reasons.append("Focal / one-sided onset (typical of ALS)")
    if ans["spread"]:
        reasons.append("Spread to a new region")
    if lmn and umn:
        reasons.append("BOTH upper and lower motor neuron signs present")

    n = len(present)
    if n == 0:
        tier = 0
    elif ans["progressive"] and ((lmn and umn) or len(regions) >= 2 or ans["spread"]):
        tier = 3
    elif (ans["progressive"] and (lmn or umn or bulbar)) or n >= 3 or (ans["asymmetric"] and lmn):
        tier = 2
    else:
        tier = 1

    # Strongest risk factor can bump the tier up one level (never down)
    if ans["family"] and n >= 1 and tier < 3:
        tier += 1
        reasons.append("Family history bumped the tier up one level")

    return tier, reasons


def next_steps(tier, ans):
    steps = []
    if tier >= 3:
        steps += ["Prompt neurology referral (ideally a neuromuscular / ALS clinic)",
                  "EMG / nerve conduction studies",
                  "Blood work: neurofilament light chain, creatine kinase"]
    elif tier == 2:
        steps += ["Consider EMG / nerve conduction studies and neurology review",
                  "Blood work: neurofilament light chain, creatine kinase",
                  f"Short-interval re-check (e.g. {FOLLOW_UP_WEEKS} weeks); refer sooner if worsening or spreading"]
    elif tier == 1:
        steps += [f"Document findings and re-evaluate in ~{FOLLOW_UP_WEEKS} weeks, or sooner if progressing or spreading"]

    if tier >= 2:
        if ans["speech"] or ans["swallow"] or ans["tongue"]:
            steps.append("Speech and swallowing evaluation (bulbar symptoms)")
        if ans["dyspnea"] or ans["hypovent"]:
            steps.append("Spirometry (FVC) sitting AND lying flat; consider sleep/respiratory review")
        if ans["family"]:
            steps.append("Genetic counselling and ALS gene panel (C9orf72, SOD1, TARDBP, FUS)")
    return steps


# ----------------------------------------------------------------------------
# REPORT
# ----------------------------------------------------------------------------
def report(ans):
    print("\n" + "=" * 70)
    print("  TRIAGE RESULT")
    print("=" * 70)

    if ans["sudden"]:
        print("\nSudden, stroke-like onset is not a typical ALS pattern and may be an emergency.")
        print("Arrange urgent emergency evaluation. This tool is not designed for that situation.\n")
        return None

    tier, reasons = triage(ans)
    print(f"\nALS-pattern flag: {TIERS[tier]}")

    if reasons:
        print("\nWhy:")
        for r in reasons:
            print(f"  - {r}")

    flags = [r for r in RED_FLAGS if ans[r["key"]]]
    if flags:
        print("\nAtypical features (these do NOT lower the flag, but add other things to rule out):")
        for r in flags:
            print(f"  ! {r['note']}")

    risks = [r for r in RISKS if ans[r["key"]]]
    print("\nRisk factors reported:")
    if risks:
        for r in risks:
            tag = "strongest known risk factor" if r["strong"] else "modest / mixed evidence"
            print(f"  - {r['q'].rstrip('?')}  ({tag})")
    else:
        print("  (none reported)")

    steps = next_steps(tier, ans)
    if steps:
        print("\nSuggested next steps:")
        for s in steps:
            print(f"  * {s}")

    if tier >= 2 and ans.get("months") and ans["months"] >= 6:
        print(f"\nTime-sensitive: symptoms have lasted {ans['months']:g} months with an ALS-type pattern. "
              "Avoid further delay.")

    print("\nNote: age was not asked or used. Please do not attribute these findings to age "
          "(old or young) without a work-up.")
    print("-" * 70)
    print("DISCLAIMER: Prototype decision-support aid. It does not diagnose ALS and cannot")
    print("replace clinical judgment or specialist evaluation.")
    print("=" * 70)
    return tier


def combined(tier, bio_data):
    als_like, control_like, _, _ = bio.analyze(bio_data)
    level, _ = bio.risk_level(len(als_like), len(control_like))
    print("\n" + "=" * 70)
    print("  COMBINED IMPRESSION")
    print("=" * 70)
    print(f"  Symptom flag:    {TIERS[tier]}")
    print(f"  Biomarker flag:  {level}")
    if tier >= 2 and len(als_like) >= bio.MIN_SIMILAR_TO_SUGGEST:
        print("\n  Symptoms AND biomarkers both point toward an ALS-like profile.")
        print("  Recommend expedited specialist review.")
    elif tier >= 2:
        print("\n  Symptoms suggest an ALS-type pattern; the biomarkers entered do not strongly confirm it.")
        print("  Symptoms alone still justify follow-up. Consider the biomarker tests left blank.")
    elif len(als_like) >= bio.MIN_SIMILAR_TO_SUGGEST:
        print("\n  Biomarkers look ALS-like despite a weak symptom pattern.")
        print("  Re-take the symptom history carefully and consider neurology input.")
    else:
        print("\n  Neither module shows a strong ALS-like pattern. Re-evaluate if anything changes.")
    print("=" * 70 + "\n")


def main():
    print("=" * 70)
    print("  Welcome, Doctor. ALS Early-Flag Triage  (about 3-5 minutes)")
    print("=" * 70)
    pid = input("\nPatient name or ID (optional): ").strip()
    if pid:
        print(f"Patient: {pid}")

    ans = collect()
    tier = report(ans)
    if tier is None:
        return

    if input("\nAdd lab / biomarker values now? [y/N] ").strip().lower().startswith("y"):
        bio_data = bio.collect_inputs()
        if any(v is not None for v in bio_data.values()):
            bio.print_report(bio_data)
            combined(tier, bio_data)
        else:
            print("No biomarker values entered.")


if __name__ == "__main__":
    main()
