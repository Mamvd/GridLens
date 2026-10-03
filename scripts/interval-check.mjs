#!/usr/bin/env node
// interval-check.mjs — parseInterval/fmtInterval (src/data/race.ts).
// String forms ("+1 LAP", "Leader") are documented but never observed on the
// free tier (numbers-only scan 2023-2025) — defensive coverage only.
// Recipe: tsc race.ts → CJS (follows imports to api/openf1 + api/cache).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import { rmSync, mkdirSync } from "node:fs";

const OUT = "/tmp/intervalcheck";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("node_modules/.bin/tsc", [
  "src/data/race.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { stdio: "inherit" });

const require = createRequire(import.meta.url);
const { parseInterval, fmtInterval } = require(`${OUT}/data/race.js`);

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

// --- parseInterval ---
check("number → time", () => {
  assert.deepEqual(parseInterval(5.25), { type: "time", seconds: 5.25 });
});
check("negative number → time", () => {
  assert.deepEqual(parseInterval(-1.5), { type: "time", seconds: -1.5 });
});
check("numeric string → time", () => {
  assert.deepEqual(parseInterval("-1.5"), { type: "time", seconds: -1.5 });
});
check('"+1 LAP" → lapped(1)', () => {
  assert.deepEqual(parseInterval("+1 LAP"), { type: "lapped", laps: 1 });
});
check('"+2 LAPS" → lapped(2)', () => {
  assert.deepEqual(parseInterval("+2 LAPS"), { type: "lapped", laps: 2 });
});
check('"Leader" → leader', () => {
  assert.deepEqual(parseInterval("Leader"), { type: "leader" });
});
check('"leader" → leader (case-insensitive)', () => {
  assert.deepEqual(parseInterval("leader"), { type: "leader" });
});
check("null/undefined/empty → none", () => {
  assert.deepEqual(parseInterval(null), { type: "none" });
  assert.deepEqual(parseInterval(undefined), { type: "none" });
  assert.deepEqual(parseInterval(""), { type: "none" });
  assert.deepEqual(parseInterval("   "), { type: "none" });
});
check('garbage / "+x LAP" → none (never fabricate)', () => {
  assert.deepEqual(parseInterval("garbage"), { type: "none" });
  assert.deepEqual(parseInterval("+x LAP"), { type: "none" });
});

// --- fmtInterval ---
check('time(75.1234) → "1:15.123"', () => {
  assert.equal(fmtInterval({ type: "time", seconds: 75.1234 }), "1:15.123");
});
check('time(-3.2) → "-0:03.200"', () => {
  assert.equal(fmtInterval({ type: "time", seconds: -3.2 }), "-0:03.200");
});
check('lapped(1) → "+1 LAP"', () => {
  assert.equal(fmtInterval({ type: "lapped", laps: 1 }), "+1 LAP");
});
check('lapped(2) → "+2 LAPS"', () => {
  assert.equal(fmtInterval({ type: "lapped", laps: 2 }), "+2 LAPS");
});
check('leader → "Leader"', () => {
  assert.equal(fmtInterval({ type: "leader" }), "Leader");
});
check('none → "—"', () => {
  assert.equal(fmtInterval({ type: "none" }), "—");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
