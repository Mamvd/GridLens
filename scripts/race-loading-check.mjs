#!/usr/bin/env node
// race-loading-check.mjs — lazy per-tab race loading (issue #7).
// Drives the same composition Race.tsx uses: loadRaceBase + missingResources
// + per-resource loaders, against a mocked fetch. Asserts request counts.
// Recipe: tsc race.ts → CJS (follows imports to api/openf1 + api/cache).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import { rmSync, mkdirSync } from "node:fs";

const OUT = "/tmp/raceloading";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("node_modules/.bin/tsc", [
  "src/data/race.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { stdio: "inherit" });

// localStorage stub (cache.ts two-tier — LS tier inert-but-safe in node)
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const require = createRequire(import.meta.url);
const {
  loadRaceBase, loadLaps, loadIntervals, loadStints, loadPit, loadOvertakes,
  missingResources, TAB_RESOURCES,
} = require(`${OUT}/data/race.js`);

// mock fetch — logs every resource requested; injectable failures
const fetched = [];
let failResource = null;
globalThis.fetch = async (url) => {
  const resource = new URL(String(url)).pathname.split("/").pop();
  fetched.push(resource);
  await new Promise((r) => setTimeout(r, 5));
  if (resource === failResource) {
    return { ok: false, status: 500, json: async () => [], text: async () => "boom" };
  }
  return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
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

const YEAR = 2024;
const LOADER = {
  laps: (sk) => loadLaps(sk, YEAR),
  intervals: (sk) => loadIntervals(sk, YEAR),
  stints: (sk) => loadStints(sk, YEAR),
  pit: (sk) => loadPit(sk, YEAR),
  overtakes: (sk) => loadOvertakes(sk, YEAR),
};
const unique = () => [...new Set(fetched)];

// view-equivalent driver: has() = resources already loaded (same predicate
// Race.tsx effect 2 passes to missingResources)
const runTab = async (sk, tab, has) => {
  for (const key of missingResources(tab, (k) => has.has(k))) {
    await LOADER[key](sk);
    has.add(key);
  }
};

// (1) default open = base + pace extras → exactly {drivers, results, laps}
await check("default tab requests exactly drivers+results+laps (3), never intervals/stints/pit/overtakes", async () => {
  const sk = 71001;
  fetched.length = 0;
  assert.deepEqual(missingResources("pace", () => false), ["laps"], "pace needs laps");
  const base = await loadRaceBase(sk, YEAR);
  assert.ok(Array.isArray(base.drivers) && Array.isArray(base.results));
  const has = new Set(["drivers", "results"]);
  await runTab(sk, "pace", has);
  assert.deepEqual(unique().sort(), ["drivers", "laps", "session_result"]);
  for (const absent of ["intervals", "stints", "pit", "overtakes", "starting_grid"]) {
    assert.ok(!fetched.includes(absent), `${absent} must NOT be fetched on default open`);
  }
});

// (2) switch to gaps → intervals only, nothing else new
await check("switching to gaps fetches only intervals", async () => {
  const sk = 71001;
  const has = new Set(["drivers", "results", "laps"]);
  fetched.length = 0;
  assert.deepEqual(missingResources("gaps", (k) => has.has(k)), ["intervals"]);
  await runTab(sk, "gaps", has);
  assert.deepEqual(unique(), ["intervals"], `unexpected new fetches: ${unique().join(",")}`);
});

// (3) revisit a loaded tab → no refetch (skip + cache hit)
await check("revisiting a loaded tab issues zero requests", async () => {
  const sk = 71001;
  const has = new Set(["drivers", "results", "laps", "intervals"]);
  fetched.length = 0;
  assert.deepEqual(missingResources("pace", (k) => has.has(k)), [], "already loaded → nothing missing");
  await runTab(sk, "pace", has);
  // even a direct loader call must cache-hit
  const again = await loadLaps(sk, YEAR);
  assert.equal(again.stale, false);
  assert.equal(fetched.length, 0, `revisit refetched: ${fetched.join(",")}`);
});

// (4) one resource failing leaves the others intact (per-tab isolation)
await check("failing intervals does not block base/laps/stints; retry recovers", async () => {
  const sk = 71004;
  fetched.length = 0;
  failResource = "intervals";
  const base = await loadRaceBase(sk, YEAR);
  assert.ok(Array.isArray(base.results), "base must survive intervals failure");
  const laps = await loadLaps(sk, YEAR);
  assert.equal(laps.stale, false, "laps must load normally");
  await assert.rejects(() => loadIntervals(sk, YEAR), /OpenF1 500 on intervals/, "intervals must reject");
  const stints = await loadStints(sk, YEAR);
  assert.equal(stints.stale, false, "stints must load after intervals failed");
  failResource = null; // Retry button path — resource comes back
  const iv = await loadIntervals(sk, YEAR);
  assert.equal(iv.stale, false, "retry after failure must succeed");
  assert.ok(unique().includes("intervals"), "failed attempt counted");
});

// sanity: the shared map itself
await check("TAB_RESOURCES map matches spec", () => {
  assert.deepEqual(TAB_RESOURCES.pace, ["laps"]);
  assert.deepEqual(TAB_RESOURCES.gaps, ["intervals"]);
  assert.deepEqual(TAB_RESOURCES.strategy, ["stints"]);
  assert.deepEqual(TAB_RESOURCES.pit, ["stints", "pit", "overtakes"]);
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
