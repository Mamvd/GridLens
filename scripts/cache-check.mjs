#!/usr/bin/env node
// cache-check.mjs — asserts for src/api/cache.ts: policy, TTL revalidate,
// corrupt-entry recovery, in-flight dedupe, legacy-key purge.
// Recipe: tsc cache.ts → CJS, stub localStorage on globalThis, then require.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OUT = "/tmp/cachecheck";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("node_modules/.bin/tsc", [
  "src/api/cache.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { stdio: "inherit" });

// Map-backed localStorage stub — supports the methods cache.ts touches.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

// Seed legacy keys BEFORE require — module init must purge both families.
store.set("openf1:meetings?year=2023", JSON.stringify([{ old: true }]));
store.set("gridlens:openf1:drivers?session_key=1", JSON.stringify([{ old: true }]));

const require = createRequire(import.meta.url);
const {
  cached, cacheKey, getCachePolicy, classifySeason, LIVE_DATA_ENABLED,
  CURRENT_SEASON_TTL_MS, __resetCacheForTests,
} = require(`${OUT}/api/cache.js`);

let fetches = 0;
const mkFn = (tag) => async () => {
  fetches++;
  await new Promise((r) => setTimeout(r, 5));
  return [{ tag, n: fetches }];
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

const nowYear = new Date().getFullYear();

await check("legacy keys purged on init", () => {
  assert.equal(store.has("openf1:meetings?year=2023"), false, "old openf1:* key survived");
  assert.equal(store.has("gridlens:openf1:drivers?session_key=1"), false, "v1 gridlens:* key survived");
});

await check("policy: completed → persistent, ttl 0", () => {
  assert.equal(classifySeason(2023), "completed");
  const p = getCachePolicy(2023, "completed");
  assert.equal(p.persist, true);
  assert.equal(p.ttlMs, 0);
});

await check("policy: current year → in-progress, CURRENT_SEASON_TTL_MS", () => {
  assert.equal(classifySeason(nowYear), "in-progress");
  const p = getCachePolicy(nowYear, "in-progress");
  assert.equal(p.persist, true);
  assert.equal(p.ttlMs, CURRENT_SEASON_TTL_MS);
});

await check("policy: live → no persist, refetch every call", async () => {
  assert.equal(classifySeason(nowYear, true), "live");
  const p = getCachePolicy(nowYear, "live");
  assert.equal(p.persist, false);
  assert.equal(p.ttlMs, 0);
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const r1 = await cached("drivers", { session_key: 42 }, mkFn("live"), p);
  await cached("drivers", { session_key: 42 }, mkFn("live"), p);
  assert.equal(fetches, 2, "live policy must refetch every call");
  assert.equal(store.size, 0, "live policy must not write localStorage");
  assert.deepEqual(r1, { data: [{ tag: "live", n: 1 }], stale: false });
});

await check("TTL: young hit / stale refetch (in-progress)", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 101 };
  const policy = getCachePolicy(nowYear, "in-progress");
  const key = cacheKey("laps", ops);
  const first = await cached("laps", ops, mkFn("ttl"), policy);
  assert.equal(fetches, 1);
  assert.equal(first.stale, false, "fresh fetch must report stale:false");
  const hit = await cached("laps", ops, mkFn("ttl"), policy);
  assert.equal(fetches, 1, "young entry must hit cache");
  assert.equal(hit.stale, false, "fresh hit must report stale:false");
  // age LS entry past TTL, clear mem → must refetch
  __resetCacheForTests();
  const raw = JSON.parse(store.get(key));
  store.set(key, JSON.stringify({ ...raw, f: Date.now() - CURRENT_SEASON_TTL_MS - 1000 }));
  const refetched = await cached("laps", ops, mkFn("ttl"), policy);
  assert.equal(fetches, 2, "stale entry must refetch");
  assert.equal(refetched.stale, false, "successful revalidation must report stale:false");
});

await check("TTL: completed never expires even when ancient", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 202 };
  const key = cacheKey("pit", ops);
  const done = getCachePolicy(2023, "completed");
  await cached("pit", ops, mkFn("done"), done);
  assert.equal(fetches, 1);
  __resetCacheForTests();
  const raw = JSON.parse(store.get(key));
  store.set(key, JSON.stringify({ ...raw, f: Date.now() - 365 * 24 * 3600 * 1000 }));
  await cached("pit", ops, mkFn("done"), done);
  assert.equal(fetches, 1, "completed entries must not refetch on age");
});

await check("corrupt LS entry → refetch, no crash, garbage replaced", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 303 };
  const key = cacheKey("stints", ops);
  store.set(key, "{this is not json{{{");
  const policy = getCachePolicy(nowYear, "in-progress");
  const { data } = await cached("stints", ops, mkFn("corrupt"), policy);
  assert.equal(fetches, 1, "corrupt entry must miss cache");
  assert.equal(data[0].tag, "corrupt");
  const parsed = JSON.parse(store.get(key));
  assert.equal(typeof parsed.f, "number", "replacement must be {d,f} shape");
  assert.ok(Array.isArray(parsed.d));
});

await check("concurrent same-key calls → exactly 1 fetch", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 404 };
  const policy = getCachePolicy(nowYear, "in-progress");
  const [a, b] = await Promise.all([
    cached("drivers", ops, mkFn("c"), policy),
    cached("drivers", ops, mkFn("c"), policy),
  ]);
  assert.equal(fetches, 1, "in-flight dedupe must share one request");
  assert.equal(a.stale, false);
  assert.deepEqual(a, b);
});

await check("stale-if-error: primed entry + fn rejects → {data: stale, stale: true}", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 505 };
  const policy = getCachePolicy(nowYear, "in-progress");
  const key = cacheKey("laps", ops);
  await cached("laps", ops, mkFn("stale"), policy);
  assert.equal(fetches, 1);
  // age past TTL + drop mem (fresh pageload) → revalidation will be attempted
  __resetCacheForTests();
  const raw = JSON.parse(store.get(key));
  store.set(key, JSON.stringify({ ...raw, f: Date.now() - CURRENT_SEASON_TTL_MS - 1000 }));
  const failing = async () => { fetches++; throw new Error("network down"); };
  const res = await cached("laps", ops, failing, policy);
  assert.equal(fetches, 2, "must attempt revalidation before rescuing");
  assert.equal(res.stale, true, "failed revalidation with primed entry must be stale");
  assert.equal(res.data[0].tag, "stale", "must return the primed payload");
});

await check("stale-if-error: no entry + fn rejects → rejects", async () => {
  __resetCacheForTests();
  store.clear();
  const ops = { session_key: 606 };
  const policy = getCachePolicy(nowYear, "in-progress");
  await assert.rejects(
    () => cached("pit", ops, async () => { throw new Error("boom"); }, policy),
    /boom/,
    "no cached entry → error must propagate",
  );
});

await check("stale-if-error: AbortError never rescued even with primed entry", async () => {
  __resetCacheForTests();
  store.clear();
  fetches = 0;
  const ops = { session_key: 707 };
  const policy = getCachePolicy(nowYear, "in-progress");
  const key = cacheKey("stints", ops);
  await cached("stints", ops, mkFn("abort"), policy);
  __resetCacheForTests();
  const raw = JSON.parse(store.get(key));
  store.set(key, JSON.stringify({ ...raw, f: Date.now() - CURRENT_SEASON_TTL_MS - 1000 }));
  const aborted = async () => { throw new DOMException("Aborted", "AbortError"); };
  await assert.rejects(
    () => cached("stints", ops, aborted, policy),
    (e) => e.name === "AbortError",
    "AbortError must rethrow, not fall back to stale data",
  );
});

await check("LIVE_DATA_ENABLED=false gates live=true → in-progress persist, not live", async () => {
  assert.equal(LIVE_DATA_ENABLED, false, "flag must ship off");
  // compile race.ts graph (pulls api/openf1 + api/cache) to CJS
  const RACE_OUT = "/tmp/cachecheck-race";
  rmSync(RACE_OUT, { recursive: true, force: true });
  mkdirSync(RACE_OUT, { recursive: true });
  execFileSync("node_modules/.bin/tsc", [
    "src/data/race.ts",
    "--ignoreConfig", "--ignoreDeprecations", "6.0",
    "--module", "commonjs", "--target", "es2022",
    "--esModuleInterop", "--skipLibCheck",
    "--rootDir", "src", "--outDir", RACE_OUT,
  ], { cwd: ROOT, stdio: "inherit" });
  const { loadRaceBundle } = require(`${RACE_OUT}/data/race.js`);
  assert.equal(typeof loadRaceBundle, "function", "loadRaceBundle export missing");

  // mock global fetch — openf1 limiter (pLimit 4 + 500 ms spacing) still runs
  const fetchLog = [];
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  };
  const countDrivers = () => fetchLog.filter((u) => u.includes("/drivers?")).length;

  __resetCacheForTests();
  store.clear();
  const sk = 990001;
  const b1 = await loadRaceBundle(sk, nowYear, true); // live=true, flag off
  assert.ok(b1, "bundle loads");
  assert.equal(b1.sessionKey, sk);
  // in-progress path persists to localStorage; live path would leave LS empty
  const dKey = cacheKey("drivers", { session_key: sk });
  assert.ok(store.has(dKey), "live=true with flag off must take in-progress persist path");
  const n1 = countDrivers();
  assert.equal(n1, 1, "first call fetches drivers once");
  // second call: in-progress TTL → cache hit; live path would refetch every call
  await loadRaceBundle(sk, nowYear, true);
  const n2 = countDrivers();
  assert.equal(n2, 1, "second call must cache-hit — live refetch path not taken");
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
