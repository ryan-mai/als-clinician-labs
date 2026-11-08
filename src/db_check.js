"use strict";
// Checks the Tiger Data connection from .env and shows which TimescaleDB features are active.  Run: npm run db:check
const path = require("path");
const { loadEnvFile } = require("../server.js"), { createPgStore } = require("../store.js");
loadEnvFile(path.join(__dirname, "..", ".env"));
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set. Add your Tiger Cloud connection string to clinician_labs/.env, then run this again."); process.exit(1); }
const store = createPgStore({ connectionString: process.env.DATABASE_URL, noVerify: process.env.DATABASE_SSL === "no-verify" });
(async () => {
  const yes = v => (v ? "yes" : "NO");
  const caps = await store.init();
  console.log(`Connected. Features: timescaledb ${yes(caps.timescale)}, hypertable ${yes(caps.hypertable)}, compression ${yes(caps.compression)}, continuous aggregate ${yes(caps.cagg)}`);
  const e = await store.engine();
  console.log(`Readings: ${e.rows}   Patients: ${e.patients}   Chunks: ${e.chunks ? `${e.chunks.compressed}/${e.chunks.total} compressed` : "n/a"}`);
  if (e.compression) console.log(`Compression: ${e.compression.ratio}x smaller (${(e.compression.beforeBytes / 1e6).toFixed(1)} MB -> ${(e.compression.afterBytes / 1e6).toFixed(1)} MB)`);
  if (e.bench) console.log(`Benchmark: raw table ${e.bench.rawMs} ms vs continuous aggregate ${e.bench.aggMs} ms (${e.bench.speedup}x)`);
  if (!caps.hypertable) console.log("Note: this database has no TimescaleDB, so it runs as plain Postgres. Use a Tiger Cloud service for the full feature set.");
  await store.close();
})().catch(err => { console.error("Could not connect: " + err.message + "\nCheck DATABASE_URL. If the error mentions a certificate, add DATABASE_SSL=no-verify to .env."); process.exit(1); });
