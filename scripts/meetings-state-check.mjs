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
const { resolveMeetingsState, initialMeetingsState, isRestrictedOpenF1Error,
  describeFailure, shouldAutoRetry, retryDelayMs } = require(modPath);
assert.equal(typeof resolveMeetingsState, "function", "resolveMeetingsState export missing");
assert.equal(typeof isRestrictedOpenF1Error, "function", "isRestrictedOpenF1Error export missing");

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

check("7. classifier: live-session 401 message → true; AbortError / generic fetch → false", () => {
  const restricted = new Error(
    'OpenF1 401 on meetings: {"detail":"Live F1 session in progress. Global API access (including past sessions) is restricted to authenticated users until the session ends."}',
  );
  assert.equal(isRestrictedOpenF1Error(restricted), true, "401 body phrase must match");
  assert.equal(isRestrictedOpenF1Error(new DOMException("Aborted", "AbortError")), false, "AbortError never restricted");
  assert.equal(isRestrictedOpenF1Error(new Error("Failed to fetch")), false, "opaque network failure not restricted");
  assert.equal(isRestrictedOpenF1Error(new Error("OpenF1 429 on meetings: rate-limited")), false, "429 not restricted");
  assert.equal(isRestrictedOpenF1Error(undefined), false, "nullish input safe");
});

check("8. restricted flag preserved on error event; reset by start/success", () => {
  const err = resolveMeetingsState(loading, { type: "error", year: 2026, restricted: true });
  assert.equal(err.status, "error");
  assert.equal(err.restricted, true, "restricted passes through to state");
  const plain = resolveMeetingsState(loading, { type: "error", year: 2026, restricted: false });
  assert.equal(plain.restricted, false, "false preserved (not dropped)");
  // start/success carry no restricted → stale lockout flag never leaks forward
  const started = resolveMeetingsState(err, { type: "start", year: 2026 });
  assert.equal(started.status, "loading");
  assert.equal(started.restricted, undefined, "start resets restricted");
  const ok = resolveMeetingsState(err, { type: "success", year: 2026, meetings: [m] });
  assert.equal(ok.status, "success");
  assert.equal(ok.restricted, undefined, "success resets restricted");
  const staleOk = resolveMeetingsState(err, { type: "staleFallback", year: 2026, meetings: [m] });
  assert.equal(staleOk.restricted, undefined, "staleFallback resets restricted");
});

check("9. describeFailure: offline wins; restricted when body readable; unreachable otherwise", () => {
  const lockout = new Error('OpenF1 401 on meetings: {"detail":"Live F1 session in progress..."}');
  assert.equal(describeFailure(lockout, false), "offline", "offline wins even with restricted-looking message");
  assert.equal(describeFailure(lockout, true), "restricted");
  assert.equal(describeFailure(new TypeError("Failed to fetch"), true), "unreachable", "opaque browser failure");
  assert.equal(describeFailure(new Error("network down"), true), "unreachable");
  assert.equal(describeFailure(new Error('OpenF1 500 on meetings: boom'), true), "unreachable", "typed error still unreachable category");
});

check("10. shouldAutoRetry: opaque failures ≤2 retries; typed/abort never", () => {
  const opaque = new TypeError("Failed to fetch");
  assert.equal(shouldAutoRetry(opaque, 0), true, "attempt 0 retries");
  assert.equal(shouldAutoRetry(opaque, 1), true, "attempt 1 retries");
  assert.equal(shouldAutoRetry(opaque, 2), false, "bounded at 2");
  assert.equal(shouldAutoRetry(new Error("OpenF1 404 on meetings: not found"), 0), false, "typed 4xx no retry");
  assert.equal(shouldAutoRetry(new Error("OpenF1 429 on meetings: rate-limited"), 0), false, "429 has in-request backoff");
  assert.equal(shouldAutoRetry(new Error("OpenF1 500 on meetings: boom"), 1), false, "typed 5xx no retry");
  assert.equal(shouldAutoRetry(new DOMException("Aborted", "AbortError"), 0), false, "abort never retries");
});

check("11. retryDelayMs: exponential + jitter within bounds", () => {
  const bounds = [[0, 1200, 1600], [1, 2400, 2800], [2, 4800, 5200]];
  for (const [attempt, lo, hi] of bounds) {
    for (let i = 0; i < 50; i++) {
      const d = retryDelayMs(attempt);
      assert.ok(d >= lo && d < hi, `attempt ${attempt} delay ${d} outside [${lo}, ${hi})`);
    }
  }
});

check("12. kind passes through error event; reset by start/success", () => {
  const err = resolveMeetingsState(loading, { type: "error", year: 2026, kind: "offline" });
  assert.equal(err.status, "error");
  assert.equal(err.kind, "offline");
  assert.equal(resolveMeetingsState(err, { type: "start", year: 2026 }).kind, undefined, "start resets kind");
  const ok = resolveMeetingsState(err, { type: "success", year: 2026, meetings: [m] });
  assert.equal(ok.kind, undefined, "success resets kind");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
