// tests/e2e/fixtures.mjs — small deterministic OpenF1 payloads.
// Shapes match what src/api/openf1.ts validateRows accepts (identity keys,
// typed fields, nullable numbers). Year 2024 = completed season → cache
// policy persists, no TTL flakiness across scenarios (fresh context anyway).

export const YEAR = 2024;
export const MONACO_SLUG = "monaco-grand-prix";
export const BAHRAIN_SLUG = "bahrain-grand-prix";
export const MONACO_SK = 9001;
export const BAHRAIN_SK = 9002;
export const SPRINT_SK = 9101;
export const RACE_SKS = [BAHRAIN_SK, MONACO_SK];
export const ALL_SKS = [...RACE_SKS, SPRINT_SK];

const meeting = (over) => ({
  meeting_official_name: over.meeting_name,
  location: "", country_name: "", country_code: "", country_flag: "https://flagcdn.com/xx.svg",
  year: YEAR, gmt_offset: "00:00:00", circuit_key: 0, circuit_image: "",
  ...over,
});

export const MEETINGS = [
  meeting({
    meeting_key: 1145, meeting_name: "Bahrain Grand Prix", location: "Sakhir",
    country_name: "Bahrain", country_code: "BHR", circuit_short_name: "Sakhir",
    date_start: "2024-03-02T15:00:00Z", date_end: "2024-03-02T18:00:00Z", gmt_offset: "03:00:00",
  }),
  meeting({
    meeting_key: 1147, meeting_name: "Monaco Grand Prix", location: "Monte Carlo",
    country_name: "Monaco", country_code: "MCO", circuit_short_name: "Monte Carlo",
    date_start: "2024-05-26T13:00:00Z", date_end: "2024-05-26T16:00:00Z", gmt_offset: "02:00:00",
  }),
  // non-GP — seasonMeetings filters meeting_name.includes("Grand Prix")
  meeting({
    meeting_key: 9999, meeting_name: "Pre-Season Test", location: "Sakhir",
    country_name: "Bahrain", country_code: "BHR", circuit_short_name: "Sakhir",
    date_start: "2024-02-20T10:00:00Z", date_end: "2024-02-22T16:00:00Z",
  }),
];

export const SESSIONS = [
  { session_key: BAHRAIN_SK, meeting_key: 1145, session_name: "Race",
    date_start: "2024-03-02T15:00:00Z", date_end: "2024-03-02T18:00:00Z", gmt_offset: "03:00:00" },
  { session_key: MONACO_SK, meeting_key: 1147, session_name: "Race",
    date_start: "2024-05-26T13:00:00Z", date_end: "2024-05-26T16:00:00Z", gmt_offset: "02:00:00" },
  { session_key: SPRINT_SK, meeting_key: 1147, session_name: "Sprint",
    date_start: "2024-05-25T13:00:00Z", date_end: "2024-05-25T14:00:00Z", gmt_offset: "02:00:00" },
];

const SEED = [
  { driver_number: 1, first_name: "Max", last_name: "Verstappen", team_name: "Red Bull Racing", team_colour: "3671C6" },
  { driver_number: 11, first_name: "Sergio", last_name: "Perez", team_name: "Red Bull Racing", team_colour: "3671C6" },
  { driver_number: 16, first_name: "Charles", last_name: "Leclerc", team_name: "Ferrari", team_colour: "E8002D" },
  { driver_number: 55, first_name: "Carlos", last_name: "Sainz", team_name: "Ferrari", team_colour: "E8002D" },
  { driver_number: 4, first_name: "Lando", last_name: "Norris", team_name: "McLaren", team_colour: "FF8000" },
  { driver_number: 81, first_name: "Oscar", last_name: "Piastri", team_name: "McLaren", team_colour: "FF8000" },
];

export const DRIVERS = ALL_SKS.flatMap((sk) =>
  SEED.map((d) => ({
    meeting_key: SESSIONS.find((s) => s.session_key === sk).meeting_key,
    session_key: sk,
    ...d,
    full_name: `${d.first_name} ${d.last_name}`,
    broadcast_name: `${d.last_name.toUpperCase()} ${d.first_name[0]}`,
    name_acronym: `${d.first_name[0]}${d.last_name}`.toUpperCase(),
  })),
);

// [driver_number, position, points] per session — sums:
// VER 25+18+8=51 · LEC 18+25+5=48 · NOR 15+12+7=34 · PIA 12+10+6=28
// SAI 8+15+3=26 · PER 10+8+4=22
const RESULT_ROWS = {
  [MONACO_SK]: [[1, 1, 25], [16, 2, 18], [4, 3, 15], [81, 4, 12], [11, 5, 10], [55, 6, 8]],
  [BAHRAIN_SK]: [[16, 1, 25], [1, 2, 18], [55, 3, 15], [4, 4, 12], [81, 5, 10], [11, 6, 8]],
  [SPRINT_SK]: [[1, 1, 8], [4, 2, 7], [81, 3, 6], [16, 4, 5], [11, 5, 4], [55, 6, 3]],
};

export const SESSION_RESULTS = Object.entries(RESULT_ROWS).flatMap(([sk, rows]) =>
  rows.map(([driver_number, position, points]) => ({
    meeting_key: SESSIONS.find((s) => s.session_key === Number(sk)).meeting_key,
    session_key: Number(sk),
    driver_number, position, points,
    dnf: false, dns: false, dsq: false, gap_to_leader: null, duration: null,
  })),
);

// expected championship (computed from RESULT_ROWS above)
export const EXPECTED_CHAMPIONSHIP = [
  { name: "Max Verstappen", pts: 51, wins: 1, podiums: 2 },
  { name: "Charles Leclerc", pts: 48, wins: 1, podiums: 2 },
  { name: "Lando Norris", pts: 34, wins: 0, podiums: 1 },
  { name: "Oscar Piastri", pts: 28, wins: 0, podiums: 0 },
  { name: "Carlos Sainz", pts: 26, wins: 0, podiums: 1 },
  { name: "Sergio Perez", pts: 22, wins: 0, podiums: 0 },
];

const lap = (sk, driver_number, lap_number, duration, s1, s2, s3) => ({
  meeting_key: SESSIONS.find((s) => s.session_key === sk).meeting_key,
  session_key: sk, driver_number, lap_number,
  date_start: "2024-05-26T13:05:00Z",
  lap_duration: duration,
  is_valid_lap: null, is_pit_out_lap: null,
  duration_sector_1: s1, duration_sector_2: s2, duration_sector_3: s3,
  segments_sector_1: null, segments_sector_2: null, segments_sector_3: null,
  i1_speed: null, i2_speed: null, st_speed: null,
});

// Verstappen on Monaco: lap 1 warm-up (null), laps 2-4 timed — fastest 91.0 on lap 3
export const LAPS = [
  lap(MONACO_SK, 1, 1, null, null, null, null),
  lap(MONACO_SK, 1, 2, 92.5, 30.1, 31.2, 31.2),
  lap(MONACO_SK, 1, 3, 91.0, 29.5, 31.0, 30.5),
  lap(MONACO_SK, 1, 4, 91.8, 29.8, 31.1, 30.9),
  lap(MONACO_SK, 16, 2, 93.0, 30.4, 31.3, 31.3),
  lap(MONACO_SK, 4, 2, 92.2, 30.0, 31.1, 31.1),
];

// mixed interval types — free tier ships numbers; string forms are defensive
export const INTERVALS = [
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, date: "2024-05-26T13:10:00Z", interval: "Leader" },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, date: "2024-05-26T13:10:00Z", interval: 1.234 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 4, date: "2024-05-26T13:10:00Z", interval: 3.5 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 81, date: "2024-05-26T13:10:00Z", interval: "+1 LAP" },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, date: "2024-05-26T13:20:00Z", interval: 0.5 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, date: "2024-05-26T13:20:00Z", interval: 0.8 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 4, date: "2024-05-26T13:20:00Z", interval: null },
];

export const STINTS = [
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 20, tyre_age_at_start: 0, compound: "SOFT" },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, stint_number: 2, lap_start: 21, lap_end: 40, tyre_age_at_start: 0, compound: "HARD" },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, stint_number: 1, lap_start: 1, lap_end: 25, tyre_age_at_start: 0, compound: "MEDIUM" },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, stint_number: 2, lap_start: 26, lap_end: 40, tyre_age_at_start: 0, compound: "HARD" },
  { meeting_key: 1145, session_key: BAHRAIN_SK, driver_number: 16, stint_number: 1, lap_start: 1, lap_end: 30, tyre_age_at_start: 0, compound: "SOFT" },
  { meeting_key: 1145, session_key: BAHRAIN_SK, driver_number: 16, stint_number: 2, lap_start: 31, lap_end: 57, tyre_age_at_start: 0, compound: "HARD" },
];

export const PIT = [
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, lap_number: 21, stop_duration: 2.4, stop_speed: null },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, lap_number: 26, stop_duration: 2.8, stop_speed: null },
  { meeting_key: 1145, session_key: BAHRAIN_SK, driver_number: 16, lap_number: 31, stop_duration: 2.6, stop_speed: null },
];

export const OVERTAKES = [
  { meeting_key: 1147, session_key: MONACO_SK, date: "2024-05-26T13:12:00Z", overtaking_driver_number: 1, overtaken_driver_number: 16, position: 1 },
  { meeting_key: 1147, session_key: MONACO_SK, date: "2024-05-26T13:18:00Z", overtaking_driver_number: 4, overtaken_driver_number: 81, position: 3 },
];

export const STARTING_GRID = [
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 1, grid_position: 1 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 16, grid_position: 2 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 4, grid_position: 3 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 81, grid_position: 4 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 11, grid_position: 5 },
  { meeting_key: 1147, session_key: MONACO_SK, driver_number: 55, grid_position: 6 },
];

const bySks = (rows, sks) => (sks.length ? rows.filter((r) => sks.includes(r.session_key)) : rows);

// Resolve an OpenF1 URL against the fixtures.
// opts.failFirst: Map<resource, remaining 500s> — burns one failure then serves 200.
export const resolveFixture = (url, opts = {}) => {
  const u = new URL(url);
  const resource = u.pathname.split("/").filter(Boolean).pop();
  const sp = u.searchParams;
  const sks = sp.getAll("session_key").map(Number);
  const year = sp.get("year") ? Number(sp.get("year")) : null;
  const sessionName = sp.get("session_name");

  if (opts.failFirst?.has(resource) && opts.failFirst.get(resource) > 0) {
    opts.failFirst.set(resource, opts.failFirst.get(resource) - 1);
    return { status: 500, body: JSON.stringify({ error: "fixture forced failure" }) };
  }

  let rows;
  switch (resource) {
    case "meetings":
      rows = MEETINGS.filter((m) => year == null || m.year === year);
      break;
    case "sessions":
      rows = SESSIONS.filter((s) =>
        (sks.length === 0 || sks.includes(s.session_key)) &&
        (sessionName == null || s.session_name === sessionName) &&
        (year == null || s.date_start.startsWith(String(year))));
      break;
    case "session_result":
      rows = bySks(SESSION_RESULTS, sks);
      break;
    case "drivers":
      rows = bySks(DRIVERS, sks);
      break;
    case "laps":
      rows = bySks(LAPS, sks);
      break;
    case "intervals":
      rows = bySks(INTERVALS, sks);
      break;
    case "stints":
      rows = bySks(STINTS, sks);
      break;
    case "pit":
      rows = bySks(PIT, sks);
      break;
    case "overtakes":
      rows = bySks(OVERTAKES, sks);
      break;
    case "starting_grid":
      rows = bySks(STARTING_GRID, sks);
      break;
    default:
      rows = [];
  }
  return { status: 200, body: JSON.stringify(rows) };
};

// Install the route on a Playwright page/context. delayMs slows the FIRST
// response per resource (loading-state scenarios).
export const installFixtures = (target, opts = {}) => {
  const seen = new Map();
  return target.route("**/api.openf1.org/**", async (route) => {
    const url = route.request().url();
    const resource = new URL(url).pathname.split("/").filter(Boolean).pop();
    const n = (seen.get(resource) ?? 0) + 1;
    seen.set(resource, n);
    if (opts.delayFirstMs && n === 1) await new Promise((r) => setTimeout(r, opts.delayFirstMs));
    const { status, body } = resolveFixture(url, opts);
    await route.fulfill({ status, contentType: "application/json", body });
  });
};
