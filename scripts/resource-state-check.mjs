#!/usr/bin/env node
// resource-state-check.mjs — lib/resource-state.ts (#10): phase matrix + empty-case guards.
// tsc-CJS recipe.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "/tmp/resource-state";
execFileSync("node_modules/.bin/tsc", [
  "src/lib/resource-state.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { cwd: ROOT, stdio: "pipe" });

const require = createRequire(import.meta.url);
const modPath = [`${OUT}/lib/resource-state.js`, `${OUT}/resource-state.js`].find(existsSync);
if (!modPath) throw new Error(`compiled resource-state.js not found under ${OUT}`);
const { resourcePhase } = require(modPath);
assert.equal(typeof resourcePhase, "function", "resourcePhase export missing");

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};

// four phases reachable
check("1. loading: slice not finished (flag set)", () => {
  assert.equal(resourcePhase([{ loading: true, data: [] }], 0), "loading");
});

check("2. loading: no payload yet even if flag clear (data undefined)", () => {
  assert.equal(resourcePhase([{ loading: false, data: undefined }], 0), "loading");
});

check("3. empty: finished, no error, 0 rows (Strategy/Pit loaded-but-zero case)", () => {
  // StrategyTab/PitTab bug: {loading:false, data:[]} used to show skeleton forever
  assert.equal(resourcePhase([{ loading: false, data: [] }], 0), "empty");
});

check("4. error: any needed slice errored", () => {
  assert.equal(resourcePhase([{ loading: false, data: [], error: "boom" }], 5), "error");
});

check("5. ready: finished, no error, rows > 0", () => {
  assert.equal(resourcePhase([{ loading: false, data: [{ x: 1 }] }], 1), "ready");
});

// precedence matrix
check("6. error beats loading", () => {
  assert.equal(
    resourcePhase(
      [{ loading: true, data: undefined }, { loading: false, data: undefined, error: "x" }],
      0,
    ),
    "error",
  );
});

check("7. loading beats empty (unfinished, count 0 → loading not empty)", () => {
  assert.equal(resourcePhase([{ loading: true, data: undefined }], 0), "loading");
});

check("8. error beats empty (finished-with-error, 0 rows → error)", () => {
  assert.equal(resourcePhase([{ loading: false, data: [], error: "x" }], 0), "error");
});

check("9. multi-slice: one unfinished → loading", () => {
  assert.equal(
    resourcePhase(
      [{ loading: false, data: [1] }, { loading: false, data: undefined }],
      3,
    ),
    "loading",
  );
});

check("10. multi-slice: all finished, 0 derived rows after filter → empty", () => {
  // rowCount is post-filter: resource has data but every row filtered away
  assert.equal(
    resourcePhase(
      [{ loading: false, data: [{ a: 1 }] }, { loading: false, data: [{}] }],
      0,
    ),
    "empty",
  );
});

check("11. empty array payload with count 0 → empty, not ready", () => {
  assert.equal(resourcePhase([{ loading: false, data: [] }], 0), "empty");
  // and the direct Strategy/Pit assertion from the spec:
  const phase = resourcePhase([{ loading: false, data: [] }], 0);
  assert.notEqual(phase, "loading", "loaded+0 rows must never read as loading");
  assert.equal(phase, "empty");
});

check("12. error field null/undefined does not trigger error", () => {
  assert.equal(resourcePhase([{ loading: false, data: [1], error: null }], 1), "ready");
  assert.equal(resourcePhase([{ loading: false, data: [1], error: undefined }], 1), "ready");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
