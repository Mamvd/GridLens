#!/usr/bin/env node
// future-check.mjs — raceIsUnrun guard + year floor (availableYears).
// Recipe: tsc race.ts + years.ts → CJS (race.ts follows imports to api/openf1 + api/cache).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import { rmSync, mkdirSync } from "node:fs";

const OUT = "/tmp/futurecheck";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("node_modules/.bin/tsc", [
  "src/data/race.ts", "src/lib/years.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { stdio: "inherit" });

const require = createRequire(import.meta.url);
const { raceIsUnrun } = require(`${OUT}/data/race.js`);
const { MIN_DATA_YEAR, availableYears } = require(`${OUT}/lib/years.js`);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

const HOUR = 3600 * 1000;

check("future date_start → raceIsUnrun true", () => {
  const now = Date.now();
  assert.equal(raceIsUnrun({ date_start: new Date(now + HOUR).toISOString() }, now), true);
});

check("past date_start → raceIsUnrun false", () => {
  const now = Date.now();
  assert.equal(raceIsUnrun({ date_start: new Date(now - HOUR).toISOString() }, now), false);
});

check("boundary date_start == nowMs → false (counts as run)", () => {
  const now = Date.now();
  assert.equal(raceIsUnrun({ date_start: new Date(now).toISOString() }, now), false);
});

check("default nowMs arg works (no second argument)", () => {
  assert.equal(raceIsUnrun({ date_start: new Date(Date.now() + HOUR).toISOString() }), true);
  assert.equal(raceIsUnrun({ date_start: new Date(Date.now() - HOUR).toISOString() }), false);
});

check("MIN_DATA_YEAR >= 2023 (OpenF1 floor)", () => {
  assert.ok(MIN_DATA_YEAR >= 2023, `MIN_DATA_YEAR=${MIN_DATA_YEAR} < 2023`);
});

check("availableYears(): non-empty, no year below MIN_DATA_YEAR", () => {
  const ys = availableYears();
  assert.ok(ys.length > 0, "empty year list");
  for (const y of ys) assert.ok(y >= MIN_DATA_YEAR, `${y} < ${MIN_DATA_YEAR}`);
});

check("availableYears(min): min parameter actually filters", () => {
  const ys = availableYears(2025);
  assert.ok(ys.length > 0, "empty year list for min=2025");
  for (const y of ys) assert.ok(y >= 2025, `${y} < 2025`);
  assert.ok(ys.length < availableYears().length, "min=2025 must drop earlier years");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
