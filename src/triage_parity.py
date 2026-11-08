"""Runs the teammate's original als_triage.py on random answer sets and prints the results as JSON,
so src/test_triage.js can check that the JavaScript port (triage.js) gives identical tiers, reasons and next steps.

Usage: python -I src/triage_parity.py python/als_triage.py [count] [seed]
als_triage.py imports als_screener (the biomarker module, not part of this repo); only the symptom rules are exercised here, so a stub stands in for it.
"""
import importlib.util
import json
import random
import sys
import types

path = sys.argv[1]
count = int(sys.argv[2]) if len(sys.argv) > 2 else 600
seed = int(sys.argv[3]) if len(sys.argv) > 3 else 7

sys.modules["als_screener"] = types.ModuleType("als_screener")
spec = importlib.util.spec_from_file_location("als_triage", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

keys = [s["key"] for s in mod.SYMPTOMS] + [p["key"] for p in mod.PATTERN] + [r["key"] for r in mod.RED_FLAGS] + [r["key"] for r in mod.RISKS]
rng = random.Random(seed)
out = []
for i in range(count):
    p = rng.choice([0.05, 0.15, 0.3, 0.5])           # vary how many answers are "yes"
    ans = {k: rng.random() < p for k in keys}
    ans["sudden"] = False
    ans["months"] = rng.choice([None, 0, 2, 5.5, 6, 12, 30.25])
    tier, reasons = mod.triage(ans)
    out.append({"ans": ans, "tier": tier, "reasons": reasons, "steps": mod.next_steps(tier, ans),
                "time_sensitive": bool(tier >= 2 and ans.get("months") and ans["months"] >= 6)})
json.dump({"tiers": mod.TIERS, "follow_up": mod.FOLLOW_UP_WEEKS,
           "symptoms": [[s["key"], s["label"], s["group"], s["region"], s["q"]] for s in mod.SYMPTOMS],
           "pattern": [[p["key"], p["q"]] for p in mod.PATTERN],
           "red_flags": [[r["key"], r["q"], r["note"]] for r in mod.RED_FLAGS],
           "risks": [[r["key"], r["q"], r["strong"]] for r in mod.RISKS],
           "cases": out}, sys.stdout)
