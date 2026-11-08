"use strict";
// Fills Tiger Data with a SYNTHETIC cohort (generated inside the database) so the Data engine page has something big to query.
// Run: npm run db:seed            (2,000 patients, roughly 770,000 readings)     or: node src/seed_cohort.js 5000
const path = require("path");
const { loadEnvFile } = require("../server.js"), { createPgStore } = require("../store.js");
loadEnvFile(path.join(__dirname, "..", ".env"));
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set. Add your Tiger Cloud connection string to clinician_labs/.env first."); process.exit(1); }
const n = +process.argv[2] || 2000, store = createPgStore({ connectionString: process.env.DATABASE_URL, noVerify: process.env.DATABASE_SSL === "no-verify" });
(async () => {
  await store.init(); console.log(`Generating ${n} synthetic patients inside the database...`);
  const t0 = Date.now(), r = await store.seedCohort(n);
  console.log(`Inserted ${r.inserted} readings for ${r.patients} patients in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  const e = await store.engine();
  if (e.compression) console.log(`Compression: ${e.compression.ratio}x smaller`);
  if (e.bench) console.log(`Benchmark: raw ${e.bench.rawMs} ms vs continuous aggregate ${e.bench.aggMs} ms (${e.bench.speedup}x)`);
  if (e.screen) console.log(`Cohort screen: ${e.screen.declining} of ${e.screen.patients} patients declining (${e.screen.ms} ms)`);
  await store.close();
})().catch(err => { console.error("Seeding failed: " + err.message); process.exit(1); });
