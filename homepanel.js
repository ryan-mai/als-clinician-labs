"use strict";
// Doctor-report panel: baseline and progression from the patient's phone check-ins (session.html).
// HomePanel.render(el, patientCode). Needs measures.js and kgest.js. Reads /api/measurements; shows a note when the API is not running.
(function (root) {
  const CSS = `
  .hp h3{font-size:18px;margin:0 0 2px} .hp .hl{font-size:14px;margin:6px 0 10px}
  .hp table{width:100%;border-collapse:collapse;font-size:14px} .hp th{font:500 11px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--mute);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
  .hp td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle} .hp td.n,.hp th.n{text-align:right;font-variant-numeric:tabular-nums}
  .hp .sub2{display:block;font-size:12px;color:var(--mute)} .hp .sp{width:120px} .hp svg{width:120px;height:28px;display:block}
  .hp .grp td{padding-top:14px;font:500 11px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--mute);border-bottom:0}
  .hp .est{font:500 11px var(--f-mono);border:1px solid var(--line);border-radius:99px;padding:1px 7px;color:var(--mute);margin-left:4px;white-space:nowrap}
  @media print{.hp{display:none}}
  @media(max-width:700px){.hp .sp,.hp .hide-s{display:none}}`;
  const GROUPS = [
    ["Speech", [["speech_wpm", "Speaking rate", "words/min", 0, "Reference: control 150-190, ALS 119-168"], ["vowel_vsa", "Vowel space area", "kHz²", 2, "Smaller = less distinct vowels"], ["vowel_vcr", "Vowel centralization", "ratio", 2, "Higher = more centralized"], ["lip_range", "Lip spread (ee to oo)", "eye widths", 2], ["jaw_speed", "Jaw movement speed", "eye widths/s", 1]]],
    ["Hands (camera score, not force)", [["grip_score_r", "Fist, right", "score", 2, "grip"], ["grip_score_l", "Fist, left", "score", 2, "grip"], ["pinch_score_r", "Key pinch, right", "score", 2, "pinch"], ["pinch_score_l", "Key pinch, left", "score", 2, "pinch"]]],
    ["Walking (phone motion sensor)", [["gait_cadence", "Cadence", "steps/min", 0], ["gait_stride_cv", "Stride variability", "%", 1]]],
  ];
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, dp) => (v == null || !isFinite(v) ? "-" : (+v).toFixed(dp));
  const day = t => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  function spark(vals, col) {
    if (vals.length < 2) return ""; const w = 120, h = 28, lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 3 - (v - lo) / sp * (h - 6)).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }
  async function render(el, patient) {
    if (!document.getElementById("hp-css")) { const s = document.createElement("style"); s.id = "hp-css"; s.textContent = CSS; document.head.appendChild(s); }
    el.classList.add("hp"); let recs;
    try { const r = await fetch("/api/measurements?patient=" + encodeURIComponent(patient)); if (!r.ok) throw 0; recs = await r.json(); if (!Array.isArray(recs)) throw 0; }
    catch (e) { el.innerHTML = `<h3>Home baseline and progression</h3><p class="note">Phone check-ins appear here once the server is running (<code>node server.js</code>) and the patient has done a check-in at <b>session.html</b>.</p>`; return; }
    const M = root.Measures, sm = M.summary(recs, patient), act = sm.activity, body = [];
    if (!act.sessions) { el.innerHTML = `<h3>Home baseline and progression</h3><p class="note">No phone check-ins yet for ${esc(patient)}. Their first check-in sets the baseline.</p>`; return; }
    let any = false;
    for (const [title, rows] of GROUPS) {
      const out = [];
      for (const [id, label, unit, dp, extra] of rows) {
        const s = M.series(recs, patient, id).filter(x => x.source === "companion"); if (!s.length) continue; const m = sm.metrics[id], def = M.METRICS[id];
        const kind = extra === "grip" || extra === "pinch" ? extra : null, note = kind ? "" : extra || "";
        let latestSub = "", est = null;
        if (kind) {
          const side = id.slice(-1), clinic = recs.filter(x => x.metric === `${kind}_kg_${side}` && x.source === "clinic").map(x => ({ t: x.t, kg: x.value })).sort((a, b) => a.t - b.t);
          est = root.KgEst.estimate(s.map(x => ({ t: x.t, v: x.v })), clinic);
          if (est) latestSub = `<span class="est">≈ ${est.est[est.est.length - 1].kg} kg est.</span>`; if (clinic.length) latestSub += `<span class="sub2">clinic ${clinic[clinic.length - 1].kg} kg (${day(clinic[clinic.length - 1].t)})</span>`;
        }
        const pct = m && isFinite(m.pctOfBaseline) ? Math.round(m.pctOfBaseline) : null, st = m ? m.status : "none";
        const pill = st === "bad" ? `<span class="pill bad">declining</span>` : st === "warn" ? `<span class="pill warn">watch</span>` : st === "ok" ? `<span class="pill ok">steady</span>` : `<span class="pill">${s.length < 3 ? "baseline" : "n/a"}</span>`;
        const col = st === "bad" ? "var(--bad)" : st === "warn" ? "var(--warn)" : "var(--sage-d)", sl = m && m.slopePctPerWeek != null ? `<span class="sub2">${m.slopePctPerWeek > 0 ? "+" : ""}${m.slopePctPerWeek.toFixed(1)}% / week</span>` : "";
        out.push(`<tr><td>${esc(label)}<span class="sub2">${esc(unit)}${note ? " · " + esc(note) : ""}</span></td><td class="n">${fmt(m ? m.baseline : s[0].v, dp)}</td><td class="n">${fmt(s[s.length - 1].v, dp)}${latestSub ? "<span style='display:block'>" + latestSub + "</span>" : ""}</td><td class="n">${pct == null ? "-" : pct + "%"}${sl}</td><td class="sp">${spark(s.slice(-40).map(x => x.v), col)}</td><td>${pill}</td><td class="n hide-s">${s.length}</td></tr>`);
      }
      if (out.length) { any = true; body.push(`<tr class="grp"><td colspan="7">${esc(title)}</td></tr>` + out.join("")); }
    }
    const asym = []; for (const k of ["grip_score", "pinch_score"]) { const r = sm.metrics[k + "_r"], l = sm.metrics[k + "_l"]; if (r && l && l.latest > 0 && l.baseline > 0) asym.push(`${k === "grip_score" ? "Right fist" : "Right pinch"} is ${Math.round(100 * r.latest / l.latest)}% of left (${Math.round(100 * r.baseline / l.baseline)}% at baseline)`); }
    const first = recs.filter(r => r.source === "companion").reduce((a, r) => Math.min(a, r.t), Infinity), last = recs.filter(r => r.source === "companion").reduce((a, r) => Math.max(a, r.t), 0);
    el.innerHTML = `<h3>Home baseline and progression</h3><p class="hl">${act.sessions} phone check-ins from ${day(first)} to ${day(last)} · ${act.streak}-day streak. Baseline = median of the first week; changes are against the patient's own baseline.${asym.length ? " <b>" + esc(asym.join("; ")) + ".</b>" : ""}</p>` +
      (any ? `<table><thead><tr><th>Measure</th><th class="n">Baseline</th><th class="n">Latest</th><th class="n">% of baseline</th><th class="sp">Trend</th><th></th><th class="n hide-s">Check-ins</th></tr></thead><tbody>${body.join("")}</tbody></table>` : `<p class="note">No readings yet.</p>`) +
      `<p class="note" style="margin-top:10px">Camera scores track how far and how fast the hand moves; they are not force. "≈ kg est." anchors the patient's first-week score to the clinic dynamometer reading nearest that week, and is unvalidated. Vowel and jaw measures are acoustic and video proxies. NfL, CK, genetics, spinal tap and biopsy remain clinic measurements.</p>`;
  }
  root.HomePanel = { render };
})(typeof window !== "undefined" ? window : globalThis);
