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
  loadRaceBase, loadLaps, loadIntervals, loadStints, loadPit, loadOvertakes, loadGrid,
  missingResources, TAB_RESOURCES, DETAIL_RESOURCES, missingDetail, detailFields,
  fmtSectorTime,
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
  grid: (sk) => loadGrid(sk, YEAR),
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

// --- #14: on-demand detail resources (grid/laps/overtakes/pit) ---

// (6) strategy tab request set unchanged — detail keys stay out of it
await check("strategy tab fetches only stints (grid/overtakes/laps/pit stay on-demand)", async () => {
  const sk = 71005;
  fetched.length = 0;
  assert.deepEqual(missingResources("strategy", () => false), ["stints"]);
  await runTab(sk, "strategy", new Set(["drivers", "results"]));
  assert.deepEqual(unique(), ["stints"], `unexpected: ${unique().join(",")}`);
  for (const absent of ["starting_grid", "overtakes", "laps", "pit", "intervals"]) {
    assert.ok(!fetched.includes(absent), `${absent} must NOT be fetched by the strategy tab`);
  }
  // DETAIL_RESOURCES is exactly the documented set
  assert.deepEqual([...DETAIL_RESOURCES].sort(), ["grid", "laps", "overtakes", "pit"]);
});

// (7) expand with missing detail → exactly those keys fetched
await check("detail expand fetches exactly the missing detail keys", async () => {
  const sk = 71006;
  const has = new Set(["drivers", "results", "stints"]); // strategy tab open
  fetched.length = 0;
  const missing = missingDetail((k) => has.has(k));
  assert.deepEqual([...missing].sort(), ["grid", "laps", "overtakes", "pit"]);
  for (const k of missing) await LOADER[k](sk);
  // "grid" key maps to the starting_grid API resource
  assert.deepEqual(unique().sort(), ["laps", "overtakes", "pit", "starting_grid"],
    `unexpected: ${unique().join(",")}`);
});

// (8) expand with everything already loaded → zero requests
await check("detail expand with everything loaded issues zero requests", async () => {
  const sk = 71006; // same session as (7) → memory cache warm
  fetched.length = 0;
  assert.deepEqual(missingDetail(() => true), [], "nothing missing when has() is always true");
  for (const k of DETAIL_RESOURCES) await LOADER[k](sk); // direct loader → cache hit
  assert.equal(fetched.length, 0, `refetched: ${fetched.join(",")}`);
});

// (9) detail field rendering: full / partial-pending / no-data
await check("detailFields: full data renders real values", () => {
  const full = {
    finishPosition: 1, points: 25, totalStops: 2, avgStopTime: 2.31,
    fastestLap: 92.421, bestSector: { sector: 2, value: 28.104, lap: 40 },
    overtakesMade: 4, overtakesLost: 1, gridPosition: 3,
  };
  const ready = { laps: "ready", pit: "ready", overtakes: "ready", grid: "ready" };
  const d = detailFields(full, ready);
  assert.equal(d.place, "P1 · +25 pts");
  assert.equal(d.grid.text, "Grid P3");
  assert.equal(d.grid.pending, false);
  assert.equal(d.finish, "Finish P1");
  assert.equal(d.fastestLap.text, "Fastest lap 1:32.421");
  assert.equal(d.bestSector.text, "Best S2 28.104");
  assert.equal(d.stops, "Pit stops 2");
  assert.equal(d.avgStop.text, "(avg 2.31s)");
  assert.equal(d.overtakes.text, "Overtakes +4/-1");
  assert.ok([d.grid, d.fastestLap, d.bestSector, d.avgStop, d.overtakes].every((f) => !f.pending));
});

await check("detailFields: pending resources mark only their fields pending", () => {
  const s = {
    finishPosition: 2, points: 18, totalStops: 1, avgStopTime: 2.5,
    fastestLap: 93, bestSector: { sector: 1, value: 30, lap: 5 },
    overtakesMade: 1, overtakesLost: 0, gridPosition: 5,
  };
  const d = detailFields(s, { laps: "pending", pit: "ready", overtakes: "pending", grid: "ready" });
  assert.equal(d.fastestLap.pending, true, "laps pending → fastestLap skeleton");
  assert.equal(d.bestSector.pending, true, "laps pending → bestSector skeleton");
  assert.equal(d.overtakes.pending, true);
  assert.equal(d.grid.pending, false);
  assert.equal(d.avgStop.pending, false);
  assert.equal(d.place, "P2 · +18 pts", "base fields never pending");
  assert.equal(d.grid.text, "Grid P5");
});

await check("detailFields: loaded-but-zero data → \"—\", never fabricated 0/none", () => {
  const none = {
    finishPosition: 8, points: null, totalStops: 0, avgStopTime: null,
    fastestLap: null, bestSector: null,
    overtakesMade: 0, overtakesLost: 0, gridPosition: null,
  };
  const ready = { laps: "ready", pit: "ready", overtakes: "ready", grid: "ready" };
  const d = detailFields(none, ready);
  assert.equal(d.place, "P8");
  assert.equal(d.grid.text, "Grid —");
  assert.equal(d.fastestLap.text, "Fastest lap —");
  assert.equal(d.bestSector.text, "Best —");
  assert.equal(d.avgStop.text, "(avg —)");
  assert.equal(d.overtakes.text, "Overtakes —");
  assert.equal(d.stops, "Pit stops 0"); // factual: stints loaded, 1 stint
  assert.ok([d.grid, d.fastestLap, d.bestSector, d.avgStop, d.overtakes].every((f) => !f.pending),
    "ready-empty must not read as pending");
});

await check("fmtSectorTime: bare seconds under 60, lap format above", () => {
  assert.equal(fmtSectorTime(28.104), "28.104");
  assert.equal(fmtSectorTime(92.421), "1:32.421");
  assert.equal(fmtSectorTime(null), "—");
  assert.equal(fmtSectorTime(undefined), "—");
  assert.equal(fmtSectorTime(NaN), "—");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
