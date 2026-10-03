#!/usr/bin/env node
// date-format-check.mjs — lib/dates.ts (#13): circuit-local race dates.
// tsc-CJS recipe. TZ forced to a non-UTC zone so a viewer-local leak fails.
process.env.TZ = "America/New_York";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "/tmp/dateformat";
execFileSync("node_modules/.bin/tsc", [
  "src/lib/dates.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { cwd: ROOT, stdio: "pipe" });

const require = createRequire(import.meta.url);
const modPath = [`${OUT}/lib/dates.js`, `${OUT}/dates.js`].find(existsSync);
if (!modPath) throw new Error(`compiled dates.js not found under ${OUT}`);
const { formatRaceDate, formatRaceDateRange, DATE_LOCALE } = require(modPath);
assert.equal(typeof formatRaceDate, "function", "formatRaceDate export missing");
assert.equal(typeof formatRaceDateRange, "function", "formatRaceDateRange export missing");

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};

check("1. normal date, zero offset → venue calendar date", () => {
  assert.equal(formatRaceDate("2026-07-05T14:00:00Z", "00:00:00"), "5 July 2026");
});

check("2. UTC boundary: 23:30Z + 08:00 shifts to next local day", () => {
  assert.equal(formatRaceDate("2026-07-05T23:30:00Z", "08:00:00"), "6 July 2026",
    "23:30 UTC + 8h = 07:30 next day at venue");
});

check("3. gmt_offset missing → UTC date (never viewer-local; TZ=America/New_York here)", () => {
  assert.equal(formatRaceDate("2026-07-05T23:30:00Z"), "5 July 2026",
    "viewer in UTC-4 must NOT see 5 July evening roll back to 5 Jul 19:30 or forward");
  assert.equal(formatRaceDate("2026-07-05T01:00:00Z"), "5 July 2026",
    "viewer in UTC-4 must NOT see 4 July 21:00");
});

check("4. invalid ISO → \"—\"", () => {
  assert.equal(formatRaceDate("not-a-date", "00:00:00"), "—");
  assert.equal(formatRaceDate("", "00:00:00"), "—");
});

check("5. missing value → \"—\"", () => {
  assert.equal(formatRaceDate(undefined), "—");
  assert.equal(formatRaceDate(null), "—");
});

check("6. unparseable offset → UTC date, no crash", () => {
  assert.equal(formatRaceDate("2026-07-05T14:00:00Z", "garbage"), "5 July 2026");
  assert.equal(formatRaceDate("2026-07-05T23:30:00Z", "08:00:00"), "6 July 2026", "valid HH:MM:SS parses");
});

check("7. range same month → \"5–7 July 2026\"", () => {
  assert.equal(formatRaceDateRange("2026-07-05T14:00:00Z", "2026-07-07T16:00:00Z", "00:00:00"), "5–7 July 2026");
});

check("8. range cross month → \"30 June–2 July 2026\"", () => {
  assert.equal(formatRaceDateRange("2026-06-30T14:00:00Z", "2026-07-02T16:00:00Z", "00:00:00"), "30 June–2 July 2026");
});

check("9. single-day range → one date", () => {
  assert.equal(formatRaceDateRange("2026-07-05T14:00:00Z", "2026-07-05T22:00:00Z", "00:00:00"), "5 July 2026");
});

check("10. either endpoint invalid/missing → \"-\"", () => {
  assert.equal(formatRaceDateRange("2026-07-05T14:00:00Z", "nope", "00:00:00"), "—");
  assert.equal(formatRaceDateRange(undefined, "2026-07-07T16:00:00Z", "00:00:00"), "—");
});

check("11. offset rewrites the range: UTC 30 June–2 July becomes venue 1–2 July", () => {
  // 30 Jun 18:00Z + 08:00 = 1 Jul 02:00 venue; without the shift this reads "30 June–2 July 2026"
  assert.equal(formatRaceDateRange("2026-06-30T18:00:00Z", "2026-07-02T10:00:00Z", "08:00:00"), "1–2 July 2026");
  assert.equal(formatRaceDateRange("2026-06-30T18:00:00Z", "2026-07-02T10:00:00Z"), "30 June–2 July 2026");
});

check("12. DATE_LOCALE pinned", () => {
  assert.equal(DATE_LOCALE, "en-GB");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
