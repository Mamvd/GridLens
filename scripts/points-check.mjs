#!/usr/bin/env node
// scripts/points-check.mjs — assert-based season points regression checks (stdlib only).
// Compiles src/data/season.ts, mocks fetch, runs 3 scenarios. PASS/FAIL per scenario; exit 1 on fail.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. compile season.ts → /tmp/seasoncheck (CJS; follows imports to api/openf1 + api/cache)
execSync(
  "node_modules/.bin/tsc src/data/season.ts --ignoreConfig --ignoreDeprecations 6.0 --module commonjs --target es2022 --esModuleInterop --skipLibCheck --outDir /tmp/seasoncheck",
  { cwd: ROOT, stdio: "pipe" },
);
const require = createRequire(import.meta.url);
const seasonPath = ["/tmp/seasoncheck/data/season.js", "/tmp/seasoncheck/season.js"].find(existsSync);
if (!seasonPath) throw new Error("compiled season.js not found under /tmp/seasoncheck");
const { seasonBundle } = require(seasonPath);
assert.equal(typeof seasonBundle, "function", "seasonBundle export missing");

// 2. mock fetch router — openf1.ts limiter (pLimit 4) + 500ms spacing still run.
// session_result filters by repeated session_key= params → sprint-with-no-rows = unfinished weekend.
let FIXTURE = null;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const resource = u.pathname.split("/").pop();
  const qp = u.searchParams;
  const sks = qp.getAll("session_key").map(Number);
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
  }
  return { ok: true, status: 200, json: async () => rows, text: async () => "[]" };
};

// ---- fixture helpers (shapes verified against live OpenF1) ----
const RACE_PTS = [[1, 1, 25], [11, 2, 18], [4, 3, 15], [44, 4, 12]];
// sprint top-8 schedule 8/7/6/5/4/3/2/1 — assigned to our 4 drivers
const SPRINT_PTS = [[4, 1, 8], [1, 2, 7], [11, 3, 6], [44, 4, 5]];
const rows = (sk, mk, entries) =>
  entries.map(([d, p, pts]) => ({ session_key: sk, meeting_key: mk, driver_number: d, position: p, points: pts, dnf: false, dns: false, dsq: false }));
const driversOf = (sk) => [
  { session_key: sk, driver_number: 1, first_name: "Max", last_name: "Verstappen", team_name: "Red Bull Racing" },
  { session_key: sk, driver_number: 11, first_name: "Sergio", last_name: "Perez", team_name: "Red Bull Racing" },
  { session_key: sk, driver_number: 4, first_name: "Lando", last_name: "Norris", team_name: "McLaren" },
  { session_key: sk, driver_number: 44, first_name: "Lewis", last_name: "Hamilton", team_name: "Ferrari" },
];
const meeting = (key, year) => ({ meeting_key: key, meeting_name: "Test Grand Prix", date_start: `${year}-03-02`, year });
const byName = (arr) => Object.fromEntries(arr.map((x) => [x.driverName ?? x.team, x.points]));
const RACE_ONLY_DRIVERS = { "Max Verstappen": 25, "Sergio Perez": 18, "Lando Norris": 15, "Lewis Hamilton": 12 };
const RACE_ONLY_TEAMS = { "Red Bull Racing": 43, McLaren: 15, Ferrari: 12 };
const SPRINT_DRIVERS = { "Max Verstappen": 32, "Sergio Perez": 24, "Lando Norris": 23, "Lewis Hamilton": 17 };
const SPRINT_TEAMS = { "Red Bull Racing": 56, McLaren: 23, Ferrari: 17 };

// ---- scenarios ----
const outcomes = [];
const scenario = async (name, fn) => {
  try { await fn(); outcomes.push([name, "PASS", ""]); }
  catch (e) { outcomes.push([name, "FAIL", e.message]); }
};

await scenario("a. race-only season: driver totals == race points; constructors sum drivers", async () => {
  FIXTURE = {
    sessions: [{ session_key: 1001, meeting_key: 101, session_name: "Race", year: 2091 }],
    session_result: rows(1001, 101, RACE_PTS),
    drivers: driversOf(1001), pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2091, [meeting(101, 2091)]);
  assert.deepEqual(byName(stats.championship), RACE_ONLY_DRIVERS, "driver totals");
  assert.deepEqual(byName(stats.teamChampionship), RACE_ONLY_TEAMS, "team totals");
  for (const [team, exp] of Object.entries(RACE_ONLY_TEAMS)) {
    const sum = stats.championship.filter((d) => d.team === team).reduce((s, d) => s + d.points, 0);
    assert.equal(sum, exp, `constructors sum for ${team}`);
  }
});

await scenario("b. sprint weekend: driver total == race + sprint; team credit; progression combined", async () => {
  FIXTURE = {
    sessions: [
      { session_key: 2001, meeting_key: 201, session_name: "Race", year: 2092 },
      { session_key: 2002, meeting_key: 201, session_name: "Sprint", year: 2092 },
    ],
    session_result: [...rows(2001, 201, RACE_PTS), ...rows(2002, 201, SPRINT_PTS)],
    drivers: driversOf(2001), pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2092, [meeting(201, 2092)]);
  assert.deepEqual(byName(stats.championship), SPRINT_DRIVERS, "driver totals == race + sprint");
  assert.deepEqual(byName(stats.teamChampionship), SPRINT_TEAMS, "constructor totals");
  for (const [team, exp] of Object.entries(SPRINT_TEAMS)) {
    const sum = stats.championship.filter((d) => d.team === team).reduce((s, d) => s + d.points, 0);
    assert.equal(sum, exp, `constructors sum for ${team}`);
  }
  const entry = stats.progression.find((p) => p.meetingKey === 201);
  assert.ok(entry, "progression entry for meeting 201");
  // fix pushes sprint as separate racePoints entries — sum per driver for combined
  const rp = {};
  for (const r of entry.racePoints) rp[r.name] = (rp[r.name] ?? 0) + r.points;
  assert.deepEqual(rp, SPRINT_DRIVERS, "progression racePoints == race + sprint combined");
});

await scenario("c. unfinished sprint: session exists, zero result rows → no throw, race-only totals, no NaN", async () => {
  FIXTURE = {
    sessions: [
      { session_key: 3001, meeting_key: 301, session_name: "Race", year: 2093 },
      { session_key: 3002, meeting_key: 301, session_name: "Sprint", year: 2093 },
    ],
    session_result: rows(3001, 301, RACE_PTS), // sprint 3002: zero rows
    drivers: driversOf(3001), pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2093, [meeting(301, 2093)]);
  assert.deepEqual(byName(stats.championship), RACE_ONLY_DRIVERS, "driver totals unchanged");
  assert.deepEqual(byName(stats.teamChampionship), RACE_ONLY_TEAMS, "team totals unchanged");
  for (const d of stats.championship) assert.ok(Number.isFinite(d.points), `NaN driver points: ${d.driverName}`);
  for (const t of stats.teamChampionship) assert.ok(Number.isFinite(t.points), `NaN team points: ${t.team}`);
  for (const p of stats.progression) for (const r of p.racePoints) assert.ok(Number.isFinite(r.points), `NaN progression points: ${r.name}`);
});

for (const [name, status, msg] of outcomes) console.log(`${status}  ${name}${msg ? ` — ${msg}` : ""}`);
if (outcomes.some(([, s]) => s === "FAIL")) process.exit(1);
