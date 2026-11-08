"use strict";
// Builds everything the console displays for one patient. Live: /api/summary + /api/measurements. Fallback: static alex.js demo values.
(function (root) {
  const $get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
  const fmtDate = t => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const word = { bad: "Declining", warn: "Watch", ok: "Stable", none: "No trend yet" };
  const f1 = x => (Math.abs(x) >= 100 ? Math.round(x) : +x.toFixed(1));

  function fromSummary(sum, weekly, ai) {
    const m = sum.metrics, M = root.Measures.METRICS, g = id => m[id], last = id => (m[id] ? m[id].last : null), pct = id => (m[id] && isFinite(m[id].pctOfBaseline) ? Math.round(m[id].pctOfBaseline) : null);
    const need = ["grip_kg_r", "grip_kg_l", "ddk_rate", "fvc_sit_pct"]; if (need.some(id => !m[id])) throw new Error("not enough data for the console yet");
    const score = sum.motorScore ?? 0, weeks = Math.max(weekly.gripR.length, weekly.gripL.length, weekly.ddk.length);
    const statusWord = (id, bad = "Declining") => (m[id].status === "bad" ? bad : word[m[id].status]);
    const regionText = {};
    for (const r of root.Measures.REGIONS) {
      const ids = Object.keys(m).filter(id => M[id].region === r || (M[id].region === "legs" && (r === "footR" || r === "footL")));
      regionText[r] = ids.length ? ids.slice(0, 4).map(id => `${M[id].label} ${f1(m[id].last)} ${M[id].unit}${isFinite(m[id].pctOfBaseline) ? ` (${Math.round(m[id].pctOfBaseline)}% of baseline)` : ""}`).join("; ") + "." : "No measurements yet.";
    }
    const asym = Math.round(100 * m.grip_kg_r.last / m.grip_kg_l.last), act = sum.activity, adh = Math.min(100, Math.round(100 * act.daysActive / (weeks * 7)));
    const clinicT = Math.max(...["grip_kg_r", "fvc_sit_pct", "snip_cmh2o"].filter(id => m[id]).map(id => m[id].lastT));
    return {
      source: "live", weeks, series: weekly, score, tag: score >= 90 ? "Stable" : score >= 75 ? "Declining" : "Marked decline", asym, status: sum.regions, regionText, visit: fmtDate(clinicT),
      pct: { gripR: pct("grip_amp_r") ?? pct("grip_kg_r"), gripL: pct("grip_amp_l") ?? pct("grip_kg_l"), ddk: pct("ddk_rate") },
      nums: [["Left grip", last("grip_kg_l"), "kg", statusWord("grip_kg_l")], ["SNIP", last("snip_cmh2o") ?? "-", "cmH2O", m.snip_cmh2o ? statusWord("snip_cmh2o") : "-"],
             ["CK", last("ck") ?? "-", "U/L", m.ck ? (last("ck") > 320 ? "High" : "Normal") : "-"], ["Reps done", adh, "%", adh >= 80 ? "Good" : "Low"]],
      rows: [["Grip &middot; right", last("grip_kg_r"), "kg", statusWord("grip_kg_r"), m.grip_kg_r.status === "bad"], ["Speech rate", +last("ddk_rate").toFixed(1), "syll/s", statusWord("ddk_rate", "Slowing"), m.ddk_rate.status === "bad"],
             ["FVC sitting", last("fvc_sit_pct"), "%", statusWord("fvc_sit_pct"), m.fvc_sit_pct.status === "bad"], ["Serum NfL", last("nfl_pgml") ?? "-", "pg/mL", m.nfl_pgml ? (last("nfl_pgml") > 20 ? "Elevated" : "Normal") : "-", m.nfl_pgml && last("nfl_pgml") > 20],
             ["10 m walk", last("walk10m_s") ?? "-", "s", m.walk10m_s ? statusWord("walk10m_s", "Slowing") : "-", m.walk10m_s && m.walk10m_s.status === "bad"]],
      chips: { grip: [["Right", last("grip_kg_r") + " kg"], ["Left", last("grip_kg_l") + " kg"], ["Status", statusWord("grip_kg_r")]],
               speech: [["Latest", f1(last("ddk_rate")) + " /s"], ["Baseline", f1(m.ddk_rate.baseline) + " /s"], ["Status", statusWord("ddk_rate", "Slowing")]] },
      rings: [["Upper limb", pct("grip_amp_r") ?? pct("grip_kg_r")], ["Bulbar", pct("ddk_rate")], ["Respiratory", pct("fvc_sit_pct")], ["Mobility", pct("walk10m_s") ?? pct("gait_cadence")]].map(r => [r[0], r[1] ?? 0]),
      ai: ai && ai.source === "gemini" ? { text: ai.neurologist_bullets.slice(0, 2).join(" ").slice(0, 170), by: "gemini" } : (() => {
        const worst = Object.entries(m).filter(([id, x]) => M[id].status && isFinite(x.pctOfBaseline)).sort((a, b) => a[1].pctOfBaseline - b[1].pctOfBaseline)[0], nBad = Object.values(m).filter(x => x.status === "bad").length;
        return { text: `Right grip is ${asym}% of left (${last("grip_kg_r")} vs ${last("grip_kg_l")} kg). ${worst ? M[worst[0]].label + " is lowest, at " + Math.round(worst[1].pctOfBaseline) + "% of baseline." : ""} ${nBad} measures declining.`.replace(/\s+/g, " "), by: "template" }; })(),
    };
  }
  function fromStatic() {
    const A = root.Alex.compute(), C = A.clinic;
    return { source: "demo", weeks: A.weeks, series: { gripR: A.series.gripR, gripL: A.series.gripL, ddk: A.series.ddk }, score: A.score, tag: A.score >= 90 ? "Stable" : A.score >= 75 ? "Declining" : "Marked decline", asym: A.asym, status: A.status, regionText: A.regionText, visit: A.visit, pct: A.pct,
      nums: [["Left grip", A.now.gripL, "kg", "Stable"], ["SNIP", C.snip, "cmH2O", "Low"], ["CK", C.ck, "U/L", "High"], ["Reps done", 86, "%", "Good"]],
      rows: [["Grip &middot; right", A.now.gripR, "kg", "Declining", true], ["Speech rate", +A.now.ddk.toFixed(1), "syll/s", "Slowing", false], ["FVC sitting", C.fvcSit, "%", "Watch", false], ["Serum NfL", C.nfl, "pg/mL", "Elevated", true], ["10 m walk", C.walk, "s", "Slow", false]],
      chips: { grip: [["Right", A.now.gripR + " kg"], ["Left", A.now.gripL + " kg"], ["Status", "Declining"]], speech: [["Latest", A.now.ddk.toFixed(1) + " /s"], ["Baseline", A.series.ddk[0].toFixed(1) + " /s"], ["Status", "Slowing"]] },
      rings: [["Upper limb", A.pct.gripR], ["Bulbar", A.pct.ddk], ["Respiratory", C.fvcSit], ["Mobility", Math.round(800 / C.walk)]],
      ai: { text: `Right grip is ${A.asym}% of left and has fallen to ${A.pct.gripR}% of week 1. Speech is slowing and NfL is raised.`, by: "demo" } };
  }
  async function load(patient, onAi) {
    try {
      const enc = encodeURIComponent(patient), sumP = $get(`/api/summary?patient=${enc}`);
      let weekly;
      try {   // one request for all three trend charts: weekly buckets, served by Tiger Data's continuous aggregate when it is in use
        const sr = await $get(`/api/series?patient=${enc}&metrics=grip_amp_r,grip_amp_l,ddk_rate`), vals = id => (sr.series[id] || []).map(x => x.avg).slice(-10);
        weekly = { gripR: vals("grip_amp_r"), gripL: vals("grip_amp_l"), ddk: vals("ddk_rate") };
      } catch (e) {   // older server without /api/series: build the weeks in the browser from the raw readings
        const q = id => $get(`/api/measurements?patient=${enc}&metric=${id}`), [r, l, d] = await Promise.all([q("grip_amp_r"), q("grip_amp_l"), q("ddk_rate")]);
        const wk = recs => root.Measures.weekly(root.Measures.series(recs, patient, recs.length ? recs[0].metric : "")).map(x => x.v).slice(-10);
        weekly = { gripR: wk(r), gripL: wk(l), ddk: wk(d) };
      }
      const sum = await sumP;
      if (!weekly.gripR.length || !weekly.ddk.length) throw new Error("no companion series yet");
      const view = fromSummary(sum, weekly, null);   // draw now; Gemini text arrives later via onAi
      if (onAi) fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patient }) }).then(r => r.ok ? r.json() : null)
        .then(ai => { if (ai && ai.source === "gemini") onAi({ text: ai.neurologist_bullets.slice(0, 2).join(" ").slice(0, 170), by: "gemini" }); }).catch(() => {});
      return view;
    } catch (e) { console.warn("console: using static demo data (" + e.message + ")"); return fromStatic(); }
  }
  root.ConsoleData = { load, fromSummary, fromStatic };
})(window);
