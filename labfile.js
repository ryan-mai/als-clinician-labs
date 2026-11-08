"use strict";
// Reads a clinic results file (CSV, TSV, JSON, or plain text) into {metric_id: number}. Pure; node + browser. Needs measures.js and dictation.js.
// Accepted CSV shapes: name,value[,unit] rows  |  header row naming a "test/marker/name" column and a "value/result" column  |  one header row of marker names + one row of values.
(function (root) {
  const Measures = root.Measures || require("./measures.js"), Dictation = root.Dictation || require("./dictation.js");
  const norm = t => String(t).toLowerCase().replace(/[_()\-/:]+/g, " ").replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
  // extra names people actually write; the registry labels and ids are added below
  const EXTRA = {
    "nfl": "nfl_pgml", "serum nfl": "nfl_pgml", "neurofilament": "nfl_pgml", "neurofilament light": "nfl_pgml", "serum neurofilament light chain": "nfl_pgml", "neurofilament light chain": "nfl_pgml",
    "creatine kinase": "ck", "cpk": "ck", "ck": "ck",
    "troponin": "troponin_t_ngl", "troponin t": "troponin_t_ngl", "hs troponin t": "troponin_t_ngl", "high sensitivity troponin t": "troponin_t_ngl", "hs tnt": "troponin_t_ngl",
    "amylin": "amylin_pgml", "glutamate": "glutamate_um", "choline": "choline_umol", "basophil": "basophil_count", "basophils": "basophil_count", "basophil count": "basophil_count", "eosinophil": "eosinophil_count", "eosinophils": "eosinophil_count", "eosinophil count": "eosinophil_count",
    "snip": "snip_cmh2o", "sniff nasal inspiratory pressure": "snip_cmh2o", "respiratory pressure": "snip_cmh2o",
    "fvc": "fvc_sit_pct", "fvc sitting": "fvc_sit_pct", "fvc seated": "fvc_sit_pct", "fvc upright": "fvc_sit_pct", "fvc sitting up": "fvc_sit_pct",
    "fvc supine": "fvc_sup_pct", "fvc lying": "fvc_sup_pct", "fvc laying flat": "fvc_sup_pct", "fvc lying flat": "fvc_sup_pct",
    "walk": "walk10m_s", "10 m walk": "walk10m_s", "10m walk": "walk10m_s", "10 meter walk": "walk10m_s", "10 metre walk": "walk10m_s", "walking": "walk10m_s",
    "speaking rate": "speech_wpm", "words per minute": "speech_wpm", "wpm": "speech_wpm", "alsfrs": "alsfrs_r", "alsfrs r": "alsfrs_r",
    "grip right": "grip_kg_r", "right grip": "grip_kg_r", "grip left": "grip_kg_l", "left grip": "grip_kg_l", "grip strength right": "grip_kg_r", "grip strength left": "grip_kg_l", "right grip strength": "grip_kg_r", "left grip strength": "grip_kg_l",
    "pinch right": "pinch_kg_r", "right pinch": "pinch_kg_r", "pinch left": "pinch_kg_l", "left pinch": "pinch_kg_l", "key pinch right": "pinch_kg_r", "key pinch left": "pinch_kg_l", "right key pinch": "pinch_kg_r", "left key pinch": "pinch_kg_l",
  };
  const TABLE = new Map(Object.entries(EXTRA));
  for (const [id, m] of Object.entries(Measures.METRICS)) {
    TABLE.set(norm(id), id);
    const side = id.endsWith("_r") ? "right" : id.endsWith("_l") ? "left" : null, lab = norm(m.label);
    if (side) { TABLE.set(`${lab} ${side}`, id); TABLE.set(`${side} ${lab}`, id); } else TABLE.set(lab, id);
  }
  const idFor = name => TABLE.get(norm(name)) || null;
  const num = v => { if (typeof v === "number") return isFinite(v) ? v : null; const m = /-?\d+(?:[.,]\d+)?/.exec(String(v == null ? "" : v)); return m ? +m[0].replace(",", ".") : null; };
  function splitLine(line, d) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (c === d && !q) { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out.map(x => x.trim());
  }
  function put(res, name, value) {
    const id = idFor(name), v = num(value);
    if (!id) { if (String(name).trim()) res.skipped.push(String(name).trim()); return; }
    if (v == null) { res.notes.push(`${name}: no number found`); return; }
    res.values[id] = v;
  }
  function parseCsv(text) {
    const res = { values: {}, skipped: [], notes: [] }, lines = text.split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return res;
    const d = [",", "\t", ";"].map(c => [c, lines[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0], rows = lines.map(l => splitLine(l, d));
    const head = rows[0].map(norm), nameCol = head.findIndex(h => /^(test|marker|name|analyte|biomarker|measure|measurement|metric)$/.test(h)), valCol = head.findIndex(h => /^(value|result|results|reading)$/.test(h));
    if (nameCol >= 0 && valCol >= 0) { for (const r of rows.slice(1)) put(res, r[nameCol], r[valCol]); return res; }                         // long format with a header
    const mapped = rows[0].filter(c => idFor(c)).length;
    if (mapped >= 2 && mapped >= rows[0].length - 1 && rows.length >= 2) { rows[0].forEach((c, i) => put(res, c, rows[1][i])); return res; }                 // wide format: header names + one row of values
    for (const r of rows) if (r.length >= 2 && !(idFor(r[0]) === null && num(r[1]) === null && /^(test|marker|name|analyte|biomarker)$/.test(norm(r[0])))) put(res, r[0], r[1]);   // name,value rows
    return res;
  }
  function parseJson(text) {
    const res = { values: {}, skipped: [], notes: [] }; let j; try { j = JSON.parse(text); } catch (e) { res.notes.push("Not valid JSON"); return res; }
    if (j && j.values && typeof j.values === "object" && !Array.isArray(j.values)) j = j.values;
    if (Array.isArray(j)) for (const o of j) put(res, o.metric || o.name || o.test || o.marker || "", o.value ?? o.result);
    else if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) { if (v && typeof v === "object") put(res, k, v.value ?? v.result); else put(res, k, v); }
    return res;
  }
  function parseText(text) {
    const res = { values: {}, skipped: [], notes: [] };
    for (const line of text.split(/\r?\n/)) { const m = /^\s*([A-Za-z][A-Za-z0-9 ()\-_/.]*?)\s*[:=\t]\s*(-?\d+(?:[.,]\d+)?)/.exec(line); if (m) put(res, m[1], m[2]); }
    if (!Object.keys(res.values).length) { const d = Dictation.parse(text); Object.assign(res.values, d.values); res.notes.push(...d.notes); }
    return res;
  }
  // filename decides the first guess; falls back to sniffing the content
  function parse(text, filename = "") {
    const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1] || "", t = String(text).replace(/^﻿/, "").trim();
    const kind = ext === "json" || /^[\[{]/.test(t) ? "json" : ext === "csv" || ext === "tsv" ? "csv" : ext === "txt" || ext === "md" ? "text" : (t.split(/\r?\n/).filter(l => /[,\t;]/.test(l)).length >= 2 ? "csv" : "text");
    const r = kind === "json" ? parseJson(t) : kind === "csv" ? parseCsv(t) : parseText(t);
    r.skipped = [...new Set(r.skipped)]; r.kind = kind; return r;
  }
  const api = { parse, parseCsv, parseJson, parseText, idFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LabFile = api;
})(typeof window !== "undefined" ? window : globalThis);
