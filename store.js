"use strict";
// Storage for measurement records. Two interchangeable backends behind one async interface:
//   createJsonStore(file)       a JSON file (or memory when file is null): zero setup, fine for the demo
//   createPgStore({...})        Postgres. On Tiger Data (Tiger Cloud, TimescaleDB) it uses
//                                 - a hypertable (time-partitioned chunks) for the readings,
//                                 - compression of older chunks,
//                                 - a continuous aggregate (weekly_metric) that serves the weekly trend charts and cohort screens.
//                               On plain Postgres it still works (no hypertable/compression/aggregate; weekly series use date_bin).
// Interface: kind, init(), add(recs), query({patient,metric,since}), forPatient(patient), count(), hasPatient(patient), weekly(patient, metrics), engine()
// A record is { patient, metric, value, t (ms epoch), source, session?, quality? }.
const fs = require("fs"), path = require("path");
const WEEK = 7 * 864e5, ORIGIN = Date.UTC(2000, 0, 3);          // same 7-day buckets as TimescaleDB time_bucket / date_bin with origin 2000-01-03
const BULK = /^SYN-P\d/;   // the 2000-patient benchmark cohort made by seedCohort: it feeds the Data engine page, not the care-team roster
const goodQuality = r => !(r.quality && r.quality.valid === false);

function weeklyFromRecords(recs, patient, metrics) {
  const out = {};
  for (const m of metrics) {
    const b = new Map();
    for (const r of recs) if (r.patient === patient && r.metric === m && goodQuality(r)) { const k = ORIGIN + Math.floor((r.t - ORIGIN) / WEEK) * WEEK, o = b.get(k) || { sum: 0, n: 0 }; o.sum += r.value; o.n++; b.set(k, o); }
    out[m] = [...b].sort((x, y) => x[0] - y[0]).map(([t, o]) => ({ t, avg: o.sum / o.n, n: o.n }));
  }
  return out;
}

function createJsonStore(file) {
  let recs = []; try { if (file && fs.existsSync(file)) recs = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("could not read store, starting empty:", e.message); }
  const save = () => { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(recs)); fs.renameSync(tmp, file); };
  return {
    kind: "json",
    async init() {},
    async add(rs) { recs.push(...rs); save(); },
    async query({ patient, metric, since = 0 }) { return recs.filter(r => r.patient === patient && (!metric || r.metric === metric) && r.t >= since).sort((a, b) => a.t - b.t); },
    async forPatient(patient) { return recs.filter(r => r.patient === patient); },
    async count() { return recs.length; },
    async hasPatient(patient) { return recs.some(r => r.patient === patient); },
    async patients(limit = 100) { const m = new Map(); for (const r of recs) { if (BULK.test(r.patient)) continue; const o = m.get(r.patient) || { patient: r.patient, n: 0, last: 0 }; o.n++; o.last = Math.max(o.last, r.t); m.set(r.patient, o); } return [...m.values()].sort((a, b) => b.last - a.last).slice(0, limit); },
    async weekly(patient, metrics) { return weeklyFromRecords(recs, patient, metrics); },
    async engine() { return { backend: "json", rows: recs.length, patients: new Set(recs.map(r => r.patient)).size, note: "Readings are stored in a local JSON file. Set DATABASE_URL to a Tiger Cloud connection string to use Tiger Data." }; },
  };
}

function createPgStore(opts = {}) {
  const pool = opts.pool || new (require("pg").Pool)({ connectionString: opts.connectionString, max: 5, connectionTimeoutMillis: 15000, ssl: opts.noVerify ? { rejectUnauthorized: false } : undefined });
  const caps = { timescale: false, hypertable: false, compression: false, cagg: false };
  const q = (text, params) => pool.query(text, params);
  const tryq = async (label, text, params) => { try { await pool.query(text, params); return true; } catch (e) { console.error(`tiger setup: ${label} skipped (${e.message})`); return false; } };
  const toRecs = rows => rows.map(r => ({ patient: r.patient, metric: r.metric, value: Number(r.value), t: Number(r.t), source: r.source, session: r.session || undefined, quality: r.quality || undefined }));
  const SEL = "SELECT patient, metric, value, (extract(epoch from t) * 1000)::bigint AS t, source, session, quality FROM measurements";
  const ms = t0 => Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;      // milliseconds, 2 decimals
  const timed = async (text, params) => { const t0 = process.hrtime.bigint(); const r = await pool.query(text, params); return { ms: ms(t0), rows: r.rows }; };
  const store = {
    kind: "tiger", caps, pool,
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS measurements (t timestamptz NOT NULL, patient text NOT NULL, metric text NOT NULL, value double precision NOT NULL, source text NOT NULL DEFAULT 'companion', session text, quality jsonb)`);
      try { caps.timescale = (await q("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).rowCount > 0; } catch (e) { caps.timescale = false; }
      if (!caps.timescale) caps.timescale = await tryq("timescaledb extension", "CREATE EXTENSION IF NOT EXISTS timescaledb") && (await q("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).rowCount > 0;
      if (caps.timescale) {
        caps.hypertable = await tryq("hypertable", `SELECT create_hypertable('measurements', 't', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE)`);
        // compression of older chunks, grouped by patient+metric (classic syntax first, then the newer "columnstore" syntax)
        caps.compression = await tryq("compression", `ALTER TABLE measurements SET (timescaledb.compress, timescaledb.compress_segmentby = 'patient, metric', timescaledb.compress_orderby = 't DESC')`)
          && await tryq("compression policy", `SELECT add_compression_policy('measurements', INTERVAL '14 days', if_not_exists => TRUE)`);
        if (!caps.compression) caps.compression = await tryq("columnstore", `ALTER TABLE measurements SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'patient, metric', timescaledb.orderby = 't DESC')`)
          && await tryq("columnstore policy", `CALL add_columnstore_policy('measurements', after => INTERVAL '14 days', if_not_exists => true)`);
      }
      await tryq("index", `CREATE INDEX IF NOT EXISTS measurements_patient_metric_t ON measurements (patient, metric, t DESC)`);
      if (caps.hypertable) {
        // weekly roll-up the charts and cohort screens read instead of scanning raw rows
        const made = await tryq("continuous aggregate", `CREATE MATERIALIZED VIEW IF NOT EXISTS weekly_metric WITH (timescaledb.continuous) AS
          SELECT time_bucket(INTERVAL '7 days', t) AS week, patient, metric, avg(value) AS v_avg, min(value) AS v_min, max(value) AS v_max, count(*) AS n, first(value, t) AS v_first, last(value, t) AS v_last
          FROM measurements WHERE quality IS NULL OR (quality ->> 'valid') IS DISTINCT FROM 'false' GROUP BY week, patient, metric WITH NO DATA`);
        if (made) {
          await tryq("real-time aggregation", `ALTER MATERIALIZED VIEW weekly_metric SET (timescaledb.materialized_only = false)`);   // newest readings show up before the next refresh
          await tryq("aggregate policy", `SELECT add_continuous_aggregate_policy('weekly_metric', start_offset => NULL, end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes', if_not_exists => TRUE)`);
          await tryq("aggregate refresh", `CALL refresh_continuous_aggregate('weekly_metric', NULL, NULL)`);
          caps.cagg = await tryq("aggregate check", `SELECT 1 FROM weekly_metric LIMIT 1`);
        }
      }
      return caps;
    },
    async add(rs) {
      for (let i = 0; i < rs.length; i += 1000) {
        const part = rs.slice(i, i + 1000), params = [];
        const vals = part.map((r, k) => { const b = k * 7; params.push(new Date(r.t).toISOString(), r.patient, r.metric, r.value, r.source || "companion", r.session || null, r.quality ? JSON.stringify(r.quality) : null); return `($${b + 1}::timestamptz, $${b + 2}, $${b + 3}, $${b + 4}::double precision, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`; });
        await q(`INSERT INTO measurements (t, patient, metric, value, source, session, quality) VALUES ${vals.join(", ")}`, params);
      }
    },
    async query({ patient, metric, since = 0 }) {
      const r = await q(`${SEL} WHERE patient = $1 AND ($2::text IS NULL OR metric = $2) AND t >= $3::timestamptz ORDER BY t`, [patient, metric || null, new Date(Math.max(0, since)).toISOString()]);
      return toRecs(r.rows);
    },
    async forPatient(patient) { return toRecs((await q(`${SEL} WHERE patient = $1 ORDER BY t`, [patient])).rows); },
    async count() {
      if (caps.timescale) { try { const a = Number((await q("SELECT approximate_row_count('measurements') AS n")).rows[0].n); if (a >= 100000) return a; } catch (e) {} }
      return Number((await q("SELECT count(*) AS n FROM measurements")).rows[0].n);
    },
    async hasPatient(patient) { return (await q("SELECT 1 FROM measurements WHERE patient = $1 LIMIT 1", [patient])).rowCount > 0; },
    async patients(limit = 100) { return (await q("SELECT patient, count(*)::int AS n, (extract(epoch from max(t)) * 1000)::bigint AS last FROM measurements WHERE patient !~ '^SYN-P[0-9]' GROUP BY patient ORDER BY max(t) DESC LIMIT $1", [limit])).rows.map(r => ({ patient: r.patient, n: r.n, last: Number(r.last) })); },
    async weekly(patient, metrics) {
      if (!caps.cagg) { const rows = (await store.forPatient(patient)).filter(r => metrics.includes(r.metric)); return weeklyFromRecords(rows, patient, metrics); }
      const r = await q(`SELECT metric, (extract(epoch from week) * 1000)::bigint AS t, v_avg AS avg, n FROM weekly_metric WHERE patient = $1 AND metric = ANY($2::text[]) ORDER BY metric, week`, [patient, metrics]);
      const out = Object.fromEntries(metrics.map(m => [m, []]));
      for (const x of r.rows) out[x.metric].push({ t: Number(x.t), avg: Number(x.avg), n: Number(x.n) });
      return out;
    },
    // statistics + a live benchmark for the Data engine page
    async engine(metric = "grip_amp_r") {
      const out = { backend: "tiger", capabilities: { ...caps }, rows: await store.count() };
      out.patients = Number((await q(caps.cagg ? "SELECT count(DISTINCT patient) AS n FROM weekly_metric" : "SELECT count(DISTINCT patient) AS n FROM measurements")).rows[0].n);
      if (caps.hypertable) {
        try { const c = (await q(`SELECT count(*) AS total, count(*) FILTER (WHERE is_compressed) AS compressed FROM timescaledb_information.chunks WHERE hypertable_name = 'measurements'`)).rows[0]; out.chunks = { total: Number(c.total), compressed: Number(c.compressed) }; } catch (e) {}
        try { out.sizeBytes = Number((await q("SELECT hypertable_size('measurements') AS b")).rows[0].b); } catch (e) {}
        for (const fn of ["hypertable_compression_stats", "hypertable_columnstore_stats"]) {
          try { const c = (await q(`SELECT * FROM ${fn}('measurements')`)).rows[0], b = Number(c.before_compression_total_bytes), a = Number(c.after_compression_total_bytes);
            if (b > 0 && a > 0) { out.compression = { beforeBytes: b, afterBytes: a, ratio: +(b / a).toFixed(1) }; break; } } catch (e) {}
        }
      }
      if (caps.cagg && out.rows > 0) {
        // time spent INSIDE the database (EXPLAIN ANALYZE), so the network trip to Tiger Cloud does not drown the comparison; falls back to wall-clock time if EXPLAIN is unavailable
        const inDb = async (text, params) => { try { const r = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params), pl = r.rows[0]["QUERY PLAN"]; return Math.round(Number((typeof pl === "string" ? JSON.parse(pl) : pl)[0]["Execution Time"]) * 100) / 100; } catch (e) { return null; } };
        const rawSql = `SELECT time_bucket(INTERVAL '7 days', t) AS week, metric, avg(value) AS v FROM measurements GROUP BY 1, 2 ORDER BY 1, 2`;
        const aggSql = `SELECT week, metric, sum(v_avg * n) / sum(n) AS v FROM weekly_metric GROUP BY 1, 2 ORDER BY 1, 2`;
        const warm = await timed(aggSql); await timed(rawSql);                        // warm both once, then measure
        let rawMs = await inDb(rawSql), aggMs = await inDb(aggSql), where = "inside the database";
        if (rawMs == null || aggMs == null) { rawMs = (await timed(rawSql)).ms; aggMs = (await timed(aggSql)).ms; where = "including the network trip"; }
        out.bench = { question: "Weekly average of every measure, across every patient", buckets: warm.rows.length, rawMs, aggMs, speedup: aggMs > 0 ? +(rawMs / aggMs).toFixed(1) : null, measured: where };
        const scrSql = `WITH f AS (SELECT DISTINCT ON (patient) patient, v_avg FROM weekly_metric WHERE metric = $1 ORDER BY patient, week ASC), l AS (SELECT DISTINCT ON (patient) patient, v_avg FROM weekly_metric WHERE metric = $1 ORDER BY patient, week DESC)
          SELECT count(*) AS patients, count(*) FILTER (WHERE l.v_avg < 0.85 * f.v_avg) AS declining FROM f JOIN l USING (patient)`;
        const scr = await timed(scrSql, [metric]), scrMs = await inDb(scrSql, [metric]);
        out.screen = { metric, patients: Number(scr.rows[0].patients), declining: Number(scr.rows[0].declining), ms: scrMs != null ? scrMs : scr.ms, rule: "latest weekly mean at least 15% below the first week" };
      }
      return out;
    },
    // demo cohort generated inside the database (fast, no network round trips). Synthetic; one in seven patients declines on the right-hand and speech measures.
    async seedCohort(n = 2000) {
      n = Math.max(1, Math.min(20000, Math.floor(+n) || 2000));
      await tryq("clear old cohort", `DELETE FROM measurements WHERE patient LIKE 'SYN-P%'`);
      const r = await q(`WITH p AS (SELECT g, 'SYN-P' || lpad(g::text, 5, '0') AS patient, (random() < 0.15) AS declining, 0.9 + random() * 0.2 AS base FROM generate_series(1, $1::int) g),
        d AS (SELECT generate_series(0, 69) AS day),
        m AS (SELECT * FROM (VALUES ('grip_amp_r', 1.25), ('grip_amp_l', 1.25), ('ddk_rate', 6.4), ('foot_amp_r', 32.0), ('foot_amp_l', 32.0), ('gait_cadence', 108.0)) AS v(metric, scale))
        INSERT INTO measurements (t, patient, metric, value, source, session)
        SELECT now() - make_interval(days => 69 - d.day) - interval '3 hours', p.patient, m.metric,
               m.scale * p.base * (1 - CASE WHEN p.declining AND m.metric IN ('grip_amp_r', 'ddk_rate', 'foot_amp_r') THEN 0.35 * d.day / 69.0 ELSE 0.02 * d.day / 69.0 END) * (1 + (random() - 0.5) * 0.08),
               'companion', p.patient || '-c' || d.day
        FROM p CROSS JOIN d CROSS JOIN m WHERE random() < 0.92`, [n]);
      await tryq("analyze", "ANALYZE measurements");
      if (caps.cagg) await tryq("aggregate refresh", `CALL refresh_continuous_aggregate('weekly_metric', NULL, NULL)`);
      if (caps.compression) {
        const ok = await tryq("compress chunks", `SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('measurements', older_than => INTERVAL '14 days') c`);
        if (!ok) await tryq("convert chunks", `SELECT convert_to_columnstore(c, if_not_columnstore => true) FROM show_chunks('measurements', older_than => INTERVAL '14 days') c`);
      }
      return { patients: n, inserted: r.rowCount };
    },
    async close() { await pool.end(); },
  };
  return store;
}

function makeStore(env, root) {
  if (env.DATABASE_URL && env.LOCAL_ONLY !== "1") return createPgStore({ connectionString: env.DATABASE_URL, noVerify: env.DATABASE_SSL === "no-verify" });
  return createJsonStore(env.DATA_FILE || path.join(root, "data_store", "measurements.json"));
}
module.exports = { createJsonStore, createPgStore, makeStore, weeklyFromRecords };
