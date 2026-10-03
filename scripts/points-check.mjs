#!/usr/bin/env node
// scripts/points-check.mjs — assert-based season points regression checks (stdlib only).
// Compiles src/data/season.ts, mocks fetch, runs 6 scenarios. PASS/FAIL per scenario; exit 1 on fail.
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
const driver = (sk, num, first, last, team) => ({ session_key: sk, driver_number: num, first_name: first, last_name: last, team_name: team });
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

// 2025 real case encoded below: Ricciardo (#30) RBR→Racing Bulls, Tsunoda reverse.
await scenario("d. mid-season team swap: constructor credits per-session teams; display = final", async () => {
  FIXTURE = {
    sessions: [
      { session_key: 4001, meeting_key: 401, session_name: "Race", year: 2094, date_start: "2094-03-01" },
      { session_key: 4002, meeting_key: 402, session_name: "Race", year: 2094, date_start: "2094-04-05" },
    ],
    session_result: [
      ...rows(4001, 401, [[30, 3, 10]]), // early race on team A
      ...rows(4002, 402, [[30, 5, 5]]),  // later race on team B
    ],
    drivers: [
      driver(4001, 30, "Daniel", "Ricciardo", "Red Bull Racing"),
      driver(4002, 30, "Daniel", "Ricciardo", "Racing Bulls"),
    ],
    pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2094, [meeting(401, 2094), meeting(402, 2094)]);
  assert.deepEqual(byName(stats.teamChampionship), {
    "Red Bull Racing": 10,
    "Racing Bulls": 5,
  }, "constructor: A=10, B=5 — NOT A=15 frozen first-seen");
  const d = stats.championship.find((x) => x.driverName === "Daniel Ricciardo");
  assert.ok(d, "driver row present");
  assert.equal(d.points, 15, "driver total spans both teams");
  assert.equal(d.team, "Racing Bulls", "display team = last-seen (final)");
});

await scenario("e. sprint vs race team split: sprint pts → team A, race pts → team B", async () => {
  FIXTURE = {
    sessions: [
      { session_key: 5001, meeting_key: 501, session_name: "Sprint", year: 2095, date_start: "2095-06-01" },
      { session_key: 5002, meeting_key: 501, session_name: "Race", year: 2095, date_start: "2095-06-02" },
    ],
    session_result: [
      ...rows(5001, 501, [[22, 1, 8]]),  // sprint P1 on team A
      ...rows(5002, 501, [[22, 3, 12]]), // race P3 on team B
    ],
    drivers: [
      driver(5001, 22, "Yuki", "Tsunoda", "Red Bull Racing"),
      driver(5002, 22, "Yuki", "Tsunoda", "Racing Bulls"),
    ],
    pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2095, [meeting(501, 2095)]);
  assert.deepEqual(byName(stats.teamChampionship), {
    "Red Bull Racing": 8,
    "Racing Bulls": 12,
  }, "sprint 8 → team-at-sprint (A); race 12 → team-at-race (B)");
  const d = stats.championship.find((x) => x.driverName === "Yuki Tsunoda");
  assert.ok(d, "driver row present");
  assert.equal(d.points, 20, "driver total = sprint + race");
  assert.equal(d.team, "Racing Bulls", "display team = race team (last-seen)");
});

await scenario("f. one-off substitute: single race's points go to that one-off team", async () => {
  FIXTURE = {
    sessions: [
      { session_key: 6001, meeting_key: 601, session_name: "Race", year: 2096, date_start: "2096-03-01" },
      { session_key: 6002, meeting_key: 602, session_name: "Race", year: 2096, date_start: "2096-03-22" },
    ],
    session_result: [
      ...rows(6001, 601, [[4, 1, 25]]),
      ...rows(6002, 602, [[4, 2, 18], [99, 5, 6]]), // stand-in #99 one race only
    ],
    drivers: [
      driver(6001, 4, "Lando", "Norris", "McLaren"),
      driver(6002, 4, "Lando", "Norris", "McLaren"),
      driver(6002, 99, "Felipe", "Drugovich", "Aston Martin"),
    ],
    pit: [], stints: [],
  };
  const { stats } = await seasonBundle(2096, [meeting(601, 2096), meeting(602, 2096)]);
  assert.deepEqual(byName(stats.teamChampionship), {
    McLaren: 43,
    "Aston Martin": 6,
  }, "one-off team gets only its single race's 6 pts");
  const stand = stats.championship.find((x) => x.driverName === "Felipe Drugovich");
  assert.ok(stand, "stand-in driver row present");
  assert.equal(stand.points, 6);
  assert.equal(stand.team, "Aston Martin");
});

for (const [name, status, msg] of outcomes) console.log(`${status}  ${name}${msg ? ` — ${msg}` : ""}`);
if (outcomes.some(([, s]) => s === "FAIL")) process.exit(1);
