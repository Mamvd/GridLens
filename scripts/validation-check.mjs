#!/usr/bin/env node
// validation-check.mjs — asserts for src/api/openf1.ts boundary validation.
// Recipe: tsc openf1.ts → CJS, stub fetch on globalThis, call getOpenF1.
// Scenarios: valid pass, missing identity rejected, non-array handled,
// malformed JSON rejected cleanly, NaN field rejected.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import { rmSync, mkdirSync } from "node:fs";

const OUT = "/tmp/validationcheck";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("node_modules/.bin/tsc", [
  "src/api/openf1.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { stdio: "inherit" });

const require = createRequire(import.meta.url);
const { getOpenF1, validateRows, OpenF1ValidationError } = require(`${OUT}/api/openf1.js`);

const mockFetch = (payload, { jsonThrows = false, ok = true, status = 200 } = {}) => {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => {
      if (jsonThrows) throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON");
      return payload;
    },
    text: async () => (jsonThrows ? "<html>not json</html>" : JSON.stringify(payload)),
  });
};

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

const isValidationError = (e, re) =>
  e instanceof OpenF1ValidationError && e.name === "OpenF1ValidationError" && re.test(e.message);

await check("valid meetings rows pass", async () => {
  mockFetch([
    { meeting_key: 1147, meeting_name: "Monaco Grand Prix", year: 2024 },
    { meeting_key: 1145, meeting_name: "Bahrain Grand Prix", year: 2024 },
  ]);
  const rows = await getOpenF1("meetings", { year: 2024 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].meeting_key, 1147);
});

await check("valid drivers rows pass (REQUIRED first/last present)", async () => {
  mockFetch([{ session_key: 1, driver_number: 44, first_name: "Lewis", last_name: "Hamilton", team_name: "Mercedes" }]);
  const rows = await getOpenF1("drivers", { session_key: 1 });
  assert.equal(rows[0].driver_number, 44);
});

await check("missing identity key rejected (drivers without driver_number)", async () => {
  mockFetch([{ session_key: 1, first_name: "Lewis", last_name: "Hamilton" }]);
  await assert.rejects(
    () => getOpenF1("drivers", { session_key: 1 }),
    (e) => isValidationError(e, /drivers: missing driver_number/),
  );
});

await check("missing meeting_key rejected (meetings)", async () => {
  mockFetch([{ meeting_name: "Monaco Grand Prix", year: 2024 }]);
  await assert.rejects(
    () => getOpenF1("meetings", { year: 2024 }),
    (e) => isValidationError(e, /meetings: missing meeting_key/),
  );
});

await check("non-array single object response wrapped and validated", async () => {
  mockFetch({ session_key: 9, meeting_key: 1, session_name: "Race" });
  const rows = await getOpenF1("sessions", { session_key: 9 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_key, 9);
});

await check("non-array garbage (string body) rejected", async () => {
  mockFetch("<!DOCTYPE html>");
  await assert.rejects(
    () => getOpenF1("sessions", { session_key: 9 }),
    (e) => isValidationError(e, /sessions: expected an object/),
  );
});

await check("malformed JSON body rejected cleanly (typed, no stack)", async () => {
  mockFetch(null, { jsonThrows: true });
  try {
    await getOpenF1("laps", { session_key: 1 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof OpenF1ValidationError, `expected OpenF1ValidationError, got ${e.name}`);
    assert.equal(e.name, "OpenF1ValidationError");
    assert.match(e.message, /OpenF1 malformed JSON on laps/);
    assert.ok(!/\n\s+at /.test(e.message), "message must not contain a stack");
    assert.ok(!e.message.includes("<html>"), "message must not dump the raw body");
  }
});

await check("NaN field rejected (laps.lap_duration)", async () => {
  mockFetch([{ session_key: 1, driver_number: 44, lap_number: 3, lap_duration: NaN }]);
  await assert.rejects(
    () => getOpenF1("laps", { session_key: 1 }),
    (e) => isValidationError(e, /laps: NaN field/),
  );
});

await check("NaN string field rejected", async () => {
  mockFetch([{ session_key: 1, driver_number: 44, compound: "NaN" }]);
  await assert.rejects(
    () => getOpenF1("stints", { session_key: 1 }),
    (e) => isValidationError(e, /stints: NaN field/),
  );
});

await check("intervals: missing interval key rejected; null value OK", async () => {
  mockFetch([{ session_key: 1, driver_number: 44, date: "2024-05-26" }]);
  await assert.rejects(
    () => getOpenF1("intervals", { session_key: 1 }),
    (e) => isValidationError(e, /intervals: missing interval/),
  );
  mockFetch([{ session_key: 1, driver_number: 44, date: "2024-05-26", interval: null }]);
  const rows = await getOpenF1("intervals", { session_key: 1 });
  assert.equal(rows[0].interval, null);
});

await check("session_result: missing position rejected", async () => {
  mockFetch([{ session_key: 1, driver_number: 44, points: 25 }]);
  await assert.rejects(
    () => getOpenF1("session_result", { session_key: 1 }),
    (e) => isValidationError(e, /session_result: missing position/),
  );
});

await check("validateRows: empty array passes; non-array resource arg fails", () => {
  assert.deepEqual(validateRows("meetings", []), []);
  assert.throws(
    () => validateRows("meetings", { meeting_key: 1 }),
    (e) => isValidationError(e, /expected an array/),
  );
});

await check("error message safe for String(e) / title attrs", async () => {
  mockFetch([{ meeting_name: "X" }]);
  try {
    await getOpenF1("meetings", {});
    assert.fail("should have thrown");
  } catch (e) {
    const s = String(e);
    assert.ok(s.includes("OpenF1"), s);
    assert.ok(!/node_modules/.test(s), s);
    assert.ok(!/\n\s+at /.test(s), s);
  }
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
