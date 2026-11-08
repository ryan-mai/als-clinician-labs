"use strict";
// Storage tests: JSON backend endpoints, Postgres store (emulated with pg-mem = plain Postgres, no TimescaleDB), and the Tiger Data setup/statistics logic against a FAKE connection.
// The fake connection checks which statements are issued and how results are shaped; it cannot prove the SQL runs on a real Tiger service (run `npm run db:check` for that).
const { createApp } = require("../server.js"), { createPgStore } = require("../store.js");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; process.exitCode = 1; console.log("FAIL", m); } };
const get = async (srv, u) => { const r = await fetch("http://127.0.0.1:" + srv.address().port + u); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const post = async (srv, u, b) => { const r = await fetch("http://127.0.0.1:" + srv.address().port + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const listen = async srv => { await srv.ready; await new Promise(r => srv.listen(0, "127.0.0.1", r)); return srv; };

(async () => {
  // ---- JSON backend: /api/series and /api/engine ----
  let srv = await listen(createApp({ dataFile: null, env: {} }));            // seeds ALEX-CASE
  let a = await get(srv, "/api/series?patient=ALEX-CASE&metrics=grip_amp_r,ddk_rate");
  const g = a.j && a.j.series && a.j.series.grip_amp_r;
  ok(a.s === 200 && a.j.source === "json" && g.length >= 10 && g.length <= 12, "series buckets " + (g && g.length));
  ok(g && g[g.length - 1].avg < g[0].avg * 0.7 && g.every(x => x.n > 0 && x.t > 1e12), "series shows the right-grip decline");
  a = await get(srv, "/api/series?metrics=ck"); ok(a.s === 400, "series needs patient");
  a = await get(srv, "/api/series?patient=ALEX-CASE&metrics=nope"); ok(a.s === 400, "series rejects unknown metric");
  a = await get(srv, "/api/series?patient=ALEX-CASE&metrics=" + Array(13).fill("ck").join(",")); ok(a.s === 400, "series caps metric count");
  a = await get(srv, "/api/engine"); ok(a.s === 200 && a.j.backend === "json" && a.j.rows > 400 && a.j.patients === 1, "engine (json) " + JSON.stringify(a.j));
  a = await get(srv, "/api/health"); ok(a.j.store === "json", "health reports the store kind"); srv.close();

  // ---- Postgres store on pg-mem (plain Postgres: the fallback path) ----
  const { newDb } = require("pg-mem"), quiet = console.error; console.error = () => {};
  const db = newDb(), pg = createPgStore({ pool: new (db.adapters.createPg().Pool)() }), caps = await pg.init(); console.error = quiet;
  ok(!caps.hypertable && !caps.cagg && pg.kind === "tiger", "plain Postgres: no timescale features " + JSON.stringify(caps));
  const now = Date.now(), DAY = 864e5, recs = [];
  for (let d = 0; d < 20; d++) recs.push({ patient: "P1", metric: "grip_amp_r", value: 1.2 - d * 0.02, t: now - (20 - d) * DAY, source: "companion", session: "s" + d });
  recs.push({ patient: "P1", metric: "ck", value: 470, t: now - DAY, source: "lab", quality: { valid: false } }, { patient: "P2", metric: "ck", value: 100, t: now, source: "lab" });
  await pg.add(recs);
  ok(await pg.count() === 22 && await pg.hasPatient("P1") && !(await pg.hasPatient("NOPE")), "pg count/hasPatient");
  const q1 = await pg.query({ patient: "P1", metric: "grip_amp_r" });
  ok(q1.length === 20 && q1.every((r, i) => i === 0 || q1[i - 1].t <= r.t) && typeof q1[0].t === "number" && q1[0].source === "companion", "pg query ordered and typed");
  ok((await pg.query({ patient: "P1", since: now - 3 * DAY })).length === 4, "pg since filter");
  const fp = await pg.forPatient("P1"); ok(fp.length === 21 && fp.find(r => r.metric === "ck").quality.valid === false, "pg forPatient + quality round trip");
  const pw = await pg.weekly("P1", ["grip_amp_r", "ck"]);
  ok(pw.grip_amp_r.length >= 3 && pw.grip_amp_r.reduce((s, x) => s + x.n, 0) === 20 && pw.ck.length === 0, "pg weekly buckets exclude invalid-quality readings");
  const pe = await pg.engine(); ok(pe.backend === "tiger" && pe.rows === 22 && pe.patients === 2, "pg engine basics " + JSON.stringify(pe));
  // big inserts are split into batches (1000 rows each) and nothing is lost
  const many = Array.from({ length: 2500 }, (_, i) => ({ patient: "P3", metric: "ddk_rate", value: 5 + (i % 7) / 10, t: now - i * 60000, source: "companion" }));
  await pg.add(many); ok((await pg.forPatient("P3")).length === 2500, "pg batched insert keeps all 2500 rows");
  // the whole server running on that store
  srv = await listen(createApp({ store: pg, env: { SEED_DEMO: "0" } }));
  a = await post(srv, "/api/measurements", { patient: "P9", values: { grip_amp_r: 1.1, ddk_rate: 6 }, source: "companion" }); ok(a.s === 201 && a.j.saved === 2, "server saves into pg");
  a = await get(srv, "/api/summary?patient=P1"); ok(a.s === 200 && a.j.metrics.grip_amp_r && a.j.metrics.grip_amp_r.n === 20, "server summary reads from pg");
  a = await get(srv, "/api/series?patient=P1&metrics=grip_amp_r"); ok(a.s === 200 && a.j.series.grip_amp_r.length >= 3, "server series reads from pg");
  a = await get(srv, "/api/measurements?patient=P9&metric=ddk_rate"); ok(a.s === 200 && a.j.length === 1 && a.j[0].value === 6, "server query reads from pg"); srv.close();

  // ---- Tiger Data setup + statistics against a FAKE connection ----
  const mk = fail => ({ calls: [], async query(text) {
    const t = text.replace(/\s+/g, " ").trim(); this.calls.push(t); const has = s => t.includes(s);
    if (fail && has(fail)) throw new Error("simulated failure");
    if (has("EXPLAIN (ANALYZE")) return { rows: [{ "QUERY PLAN": [{ "Execution Time": has("FROM measurements") ? 90 : 30, "Planning Time": 1 }] }] };
    if (has("FROM pg_extension")) return { rowCount: 1, rows: [{}] };
    if (has("FROM weekly_metric WHERE patient")) return { rows: [{ metric: "grip_amp_r", t: "1700000000000", avg: "1.2", n: "5" }, { metric: "grip_amp_r", t: "1700604800000", avg: "1.1", n: "7" }] };
    if (has("approximate_row_count")) return { rows: [{ n: "770000" }] };
    if (has("count(DISTINCT patient) AS n FROM weekly_metric")) return { rows: [{ n: "2001" }] };
    if (has("timescaledb_information.chunks")) return { rows: [{ total: "12", compressed: "9" }] };
    if (has("hypertable_size")) return { rows: [{ b: "85000000" }] };
    if (has("hypertable_compression_stats")) return { rows: [{ before_compression_total_bytes: "600000000", after_compression_total_bytes: "60000000" }] };
    if (has("DISTINCT ON (patient)")) return { rows: [{ patients: "2001", declining: "290" }] };
    if (has("sum(v_avg * n)") || has("time_bucket(INTERVAL '7 days', t) AS week, avg(value)")) return { rows: Array(10).fill({ week: 1, v: 1 }) };
    return { rowCount: 0, rows: [] }; } });
  let fake = mk(), ts = createPgStore({ pool: fake }), tc = await ts.init();
  ok(tc.timescale && tc.hypertable && tc.compression && tc.cagg, "tiger setup reports all features " + JSON.stringify(tc));
  const sql = fake.calls.join("\n");
  for (const need of ["create_hypertable('measurements'", "timescaledb.compress_segmentby = 'patient, metric'", "add_compression_policy('measurements'", "WITH (timescaledb.continuous)", "time_bucket(INTERVAL '7 days', t) AS week", "first(value, t)", "materialized_only = false", "add_continuous_aggregate_policy('weekly_metric'", "refresh_continuous_aggregate('weekly_metric'"]) ok(sql.includes(need), "setup issues: " + need);
  const tw = await ts.weekly("P1", ["grip_amp_r", "ddk_rate"]); ok(tw.grip_amp_r.length === 2 && tw.grip_amp_r[0].avg === 1.2 && tw.ddk_rate.length === 0 && typeof tw.grip_amp_r[0].t === "number", "tiger weekly shapes continuous-aggregate rows");
  const te = await ts.engine(); ok(te.rows === 770000 && te.patients === 2001 && te.chunks.compressed === 9 && te.compression.ratio === 10 && te.sizeBytes === 85000000, "tiger engine stats " + JSON.stringify(te));
  ok(te.bench && te.bench.rawMs === 90 && te.bench.aggMs === 30 && te.bench.speedup === 3 && te.bench.measured === "inside the database", "tiger benchmark uses database execution time " + JSON.stringify(te.bench));
  ok(te.screen.declining === 290 && te.screen.patients === 2001 && te.screen.ms === 30, "tiger cohort screen " + JSON.stringify(te.screen));
  fake = mk("create_hypertable"); ts = createPgStore({ pool: fake }); const noHt = await ts.init();
  ok(noHt.timescale && !noHt.hypertable && !noHt.cagg && !fake.calls.join("\n").includes("WITH (timescaledb.continuous)"), "no hypertable -> no aggregate attempted " + JSON.stringify(noHt));
  fake = mk("WITH (timescaledb.continuous)"); ts = createPgStore({ pool: fake }); const noAgg = await ts.init(); ok(noAgg.hypertable && !noAgg.cagg, "aggregate failure degrades to raw queries");
  console.log(bad ? bad + " storage test(s) FAILED" : "storage tests passed");
})().catch(e => { process.exitCode = 1; console.log("FAIL storage tests crashed:", e.message); });
