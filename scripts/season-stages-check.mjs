#!/usr/bin/env node
// season-stages-check.mjs — progressive two-stage season load (issue #8).
// Recipe: tsc season.ts → CJS (follows imports to api/openf1 + api/cache),
// localStorage stub + mocked fetch with injectable failures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// localStorage stub BEFORE requiring the compiled module (cache.ts init purges legacy keys)
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const OUT = "/tmp/seasonstages";
execFileSync("node_modules/.bin/tsc", [
  "src/data/season.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { cwd: ROOT, stdio: "pipe" });

const require = createRequire(import.meta.url);
const seasonPath = [`${OUT}/data/season.js`, `${OUT}/season.js`].find(existsSync);
if (!seasonPath) throw new Error(`compiled season.js not found under ${OUT}`);
const { seasonCore, seasonExtras, seasonBundle } = require(seasonPath);
const { __resetCacheForTests, cacheKey, CURRENT_SEASON_TTL_MS } = require(`${OUT}/api/cache.js`);

assert.equal(typeof seasonCore, "function", "seasonCore export missing");
assert.equal(typeof seasonExtras, "function", "seasonExtras export missing");
assert.equal(typeof seasonBundle, "function", "seasonBundle export missing");

// ---- mock fetch: router + failure injection + call counter ----
let FIXTURE = null;
let failResource = null;
let fetches = 0;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const resource = u.pathname.split("/").pop();
  const qp = u.searchParams;
  const sks = qp.getAll("session_key").map(Number);
  fetches++;
  await new Promise((r) => setTimeout(r, 2));
  if (resource === failResource) {
    return { ok: false, status: 500, json: async () => [], text: async () => "boom" };
  }
  const f = FIXTURE;
  let rows = [];
  if (resource === "sessions") {
    const year = Number(qp.get("year"));
    const name = qp.get("session_name");
    rows = f.sessions.filter((s) => s.year === year && s.session_name === name);
  } else if (resource === "session_result") {
    rows = f.session_result.filter((r) => sks.includes(r.session_key));
  } else if (resource === "drivers") {
    rows = f.drivers.filter((d) => sks.includes(d.session_key));
  } else if (resource === "pit") {
    rows = f.pit.filter((p) => sks.includes(p.session_key));
  } else if (resource === "stints") {
    rows = f.stints.filter((s) => sks.includes(s.session_key));
  } else if (resource === "meetings") {
    rows = f.meetings ?? [];
  }
  return { ok: true, status: 200, json: async () => rows, text: async () => "[]" };
};

const rows = (sk, mk, entries) =>
  entries.map(([d, p, pts]) => ({
    session_key: sk, meeting_key: mk, driver_number: d, position: p, points: pts,
    dnf: false, dns: false, dsq: false,
  }));
const driversOf = (sk) => [
  { session_key: sk, driver_number: 1, first_name: "Max", last_name: "Verstappen", team_name: "Red Bull Racing" },
  { session_key: sk, driver_number: 4, first_name: "Lando", last_name: "Norris", team_name: "McLaren" },
];
const meeting = (key, year) => ({ meeting_key: key, meeting_name: "Test Grand Prix", date_start: `${year}-03-02`, year });

const reset = () => {
  __resetCacheForTests();
  store.clear();
  failResource = null;
  fetches = 0;
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

// (a) core succeeds + extras 500 → core computable, extras isolated, no cross-throw
await check("core resolves while extras 500s — core sections computable, extras rejects alone", async () => {
  reset();
  FIXTURE = {
    sessions: [{ session_key: 7001, meeting_key: 701, session_name: "Race", year: 2097 }],
    session_result: rows(7001, 701, [[1, 1, 25], [4, 2, 18]]),
    drivers: driversOf(7001),
    pit: [{ session_key: 7001, driver_number: 1, stop_duration: 2.4, stop_speed: 80 }],
    stints: [{ session_key: 7001, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 10, compound: "MEDIUM" }],
    meetings: [],
  };
  failResource = "pit";
  const [coreRes, extrasRes] = await Promise.allSettled([
    seasonCore(2097, [meeting(701, 2097)]),
    seasonExtras(2097),
  ]);
  assert.equal(coreRes.status, "fulfilled", `core must not reject: ${coreRes.reason}`);
  const core = coreRes.value;
  assert.equal(core.championship.length, 2, "championship rows");
  assert.equal(core.teamChampionship.length, 2, "team rows");
  assert.equal(core.progression.length, 1, "progression row");
  assert.equal(core.stale, false, "core fresh");
  assert.equal(extrasRes.status, "rejected", "extras must reject on pit 500");
  assert.match(String(extrasRes.reason), /OpenF1 500 on pit/, "rejects with resource error");
});

// (b) extras served stale → stale flag propagates
await check("extras pit revalidation fails over aged entry → stale:true + data rescued", async () => {
  reset();
  const YEAR = new Date().getFullYear(); // in-progress → TTL applies
  FIXTURE = {
    sessions: [{ session_key: 8001, meeting_key: 801, session_name: "Race", year: YEAR }],
    session_result: rows(8001, 801, [[1, 1, 25]]),
    drivers: driversOf(8001),
    pit: [{ session_key: 8001, driver_number: 1, stop_duration: 2.4, stop_speed: 80 }],
    stints: [{ session_key: 8001, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 10, compound: "SOFT" }],
    meetings: [],
  };
  const first = await seasonExtras(YEAR);
  assert.equal(first.stale, false, "initial extras must be fresh");
  // age ONLY the pit entry past TTL + drop mem (fresh pageload), then fail revalidation
  const pitKey = cacheKey("pit", { session_key: [8001] });
  const raw = JSON.parse(store.get(pitKey));
  store.set(pitKey, JSON.stringify({ ...raw, f: Date.now() - CURRENT_SEASON_TTL_MS - 1000 }));
  __resetCacheForTests();
  fetches = 0;
  failResource = "pit";
  const rescued = await seasonExtras(YEAR);
  assert.equal(rescued.stale, true, "stale must propagate from rescued pit entry");
  assert.equal(rescued.pitStats.length, 1, "pit data rescued from stale entry");
  assert.equal(rescued.strategyCount.length, 1, "stints still served fresh");
  assert.ok(fetches >= 1, "revalidation attempted before rescue");
});

// (c) both stages fresh from cache → 0 fetches
await check("returning user: both stages hit cache, zero network", async () => {
  reset();
  FIXTURE = {
    sessions: [{ session_key: 9001, meeting_key: 901, session_name: "Race", year: 2098 }],
    session_result: rows(9001, 901, [[1, 1, 25], [4, 2, 18]]),
    drivers: driversOf(9001),
    pit: [{ session_key: 9001, driver_number: 1, stop_duration: 2.4, stop_speed: 80 }],
    stints: [{ session_key: 9001, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 10, compound: "MEDIUM" }],
    meetings: [meeting(901, 2098)],
  };
  await seasonCore(2098, [meeting(901, 2098)]);
  await seasonExtras(2098);
  const afterFirst = fetches;
  assert.ok(afterFirst > 0, "cold run must fetch");
  fetches = 0;
  const [core2, extras2] = await Promise.all([
    seasonCore(2098, [meeting(901, 2098)]),
    seasonExtras(2098),
  ]);
  assert.equal(fetches, 0, `warm run refetched: ${fetches}`);
  assert.equal(core2.stale, false);
  assert.equal(extras2.stale, false);
});

// (d) seasonBundle still composes both stages (regression: same contract, same request count)
await check("seasonBundle composes core+extras: full stats shape, 6 requests, no meetings fetch", async () => {
  reset();
  FIXTURE = {
    sessions: [{ session_key: 9101, meeting_key: 911, session_name: "Race", year: 2099 }],
    session_result: rows(9101, 911, [[1, 1, 25], [4, 2, 18]]),
    drivers: driversOf(9101),
    pit: [{ session_key: 9101, driver_number: 1, stop_duration: 2.4, stop_speed: 80 }],
    stints: [{ session_key: 9101, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 10, compound: "MEDIUM" }],
    meetings: [],
  };
  const meetings = [meeting(911, 2099)];
  const out = await seasonBundle(2099, meetings);
  assert.equal(out.meetings, meetings, "meetings passthrough");
  assert.equal(out.stats.year, 2099, "stats.year");
  assert.equal(out.stats.championship.length, 2, "championship");
  assert.equal(out.stats.teamChampionship.length, 2, "teams");
  assert.equal(out.stats.progression.length, 1, "progression");
  assert.equal(out.stats.pitStats.length, 1, "pitStats");
  assert.equal(out.stats.strategyCount.length, 1, "strategyCount");
  assert.equal(typeof out.stale, "boolean", "stale flag");
  // same 6 requests as the pre-split bundle: race sessions, sprint sessions,
  // session_result, drivers, pit, stints (meetings passed in → not fetched)
  assert.equal(fetches, 6, `bundle request count: ${fetches}`);
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
