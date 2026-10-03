#!/usr/bin/env node
// meetings-state-check.mjs — asserts for src/lib/meetings-state.ts (#9).
// Pure transition function — no React. tsc-CJS recipe like the other checks.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execSync(
  "node_modules/.bin/tsc src/lib/meetings-state.ts --ignoreConfig --ignoreDeprecations 6.0 --module commonjs --target es2022 --esModuleInterop --skipLibCheck --rootDir src --outDir /tmp/meetingscheck",
  { cwd: ROOT, stdio: "pipe" },
);
const require = createRequire(import.meta.url);
const modPath = ["/tmp/meetingscheck/lib/meetings-state.js", "/tmp/meetingscheck/meetings-state.js"].find(existsSync);
if (!modPath) throw new Error("compiled meetings-state.js not found under /tmp/meetingscheck");
const { resolveMeetingsState, initialMeetingsState } = require(modPath);
assert.equal(typeof resolveMeetingsState, "function", "resolveMeetingsState export missing");

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};

const m = { meeting_key: 1, meeting_name: "Test Grand Prix", date_start: "2026-03-01", year: 2026 };
const loading = initialMeetingsState;

check("1. success with 0 meetings → empty success (the ONLY 'No races found' case)", () => {
  const s = resolveMeetingsState(loading, { type: "success", year: 2026, meetings: [] });
  assert.equal(s.status, "success");
  assert.equal(s.year, 2026);
  assert.deepEqual(s.meetings, [], "empty meetings array preserved");
  assert.equal(s.stale, false);
  // JSX guard: success + length 0 → Season renders "No races found for {year}."
});

check("2. failure with stale data → stale render flag on, meetings preserved", () => {
  const s = resolveMeetingsState(loading, { type: "staleFallback", year: 2026, meetings: [m] });
  assert.equal(s.status, "success", "stale fallback renders as success, not error");
  assert.equal(s.stale, true, "stale flag on → out-of-date note shown");
  assert.equal(s.meetings.length, 1);
  // seasonMeetings' built-in path: success + stale:true — same shape
  const s2 = resolveMeetingsState(loading, { type: "success", year: 2026, meetings: [m], stale: true });
  assert.equal(s2.status, "success");
  assert.equal(s2.stale, true);
});

check("3. failure without stale → error state (meetings error card, not 'No races')", () => {
  const s = resolveMeetingsState(loading, { type: "error", year: 2026 });
  assert.equal(s.status, "error");
  assert.equal(s.year, 2026);
  // JSX guard: error → MeetingsErrorCard "Unable to reach OpenF1…", no raw error text
});

check("4. abort during load → state untouched", () => {
  const cases = [
    loading,
    { status: "success", year: 2026, meetings: [m], stale: false },
    { status: "error", year: 2026 },
  ];
  for (const prev of cases) {
    const next = resolveMeetingsState(prev, { type: "abort" });
    assert.equal(next, prev, "abort must return the same state reference");
  }
});

check("5. retry after error → re-enters loading", () => {
  const err = resolveMeetingsState(loading, { type: "error", year: 2026 });
  assert.equal(err.status, "error");
  const retrying = resolveMeetingsState(err, { type: "start", year: 2026 });
  assert.equal(retrying.status, "loading", "retry (start event) re-enters loading");
});

check("6. start on year change → loading regardless of prior state", () => {
  const prev = { status: "success", year: 2025, meetings: [m], stale: false };
  const s = resolveMeetingsState(prev, { type: "start", year: 2026 });
  assert.equal(s.status, "loading");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
