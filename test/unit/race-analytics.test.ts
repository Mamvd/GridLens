import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseInterval, fmtInterval, computeStrategies, detailFields, fmtLapTime, fmtSectorTime,
  driverLapsForSectors, TYRE_PILL_COLORS, widthBucketOf, fmtClock, gapSeries,
  type RaceBundle, type DetailPhase,
} from "../../src/data/race";
import { relativeLuminance } from "../../src/lib/chart-select";
import type { Driver, Lap, Interval, Stint, PitEvent, SessionResult, Overtake, StartingGrid } from "../../src/api/openf1";

// WCAG 2.x contrast for a #rrggbb pair (audit method: relativeLuminance).
const contrast = (fg: string, bg: string): number => {
  const rgb = (h: string): [number, number, number] => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [r1, g1, b1] = rgb(fg);
  const [r2, g2, b2] = rgb(bg);
  const a = relativeLuminance(r1, g1, b1);
  const b = relativeLuminance(r2, g2, b2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const drv = (n: number, first: string, last: string): Driver =>
  ({
    meeting_key: 1, session_key: 900, driver_number: n,
    first_name: first, last_name: last, full_name: `${first} ${last}`,
    broadcast_name: `${last.toUpperCase()} ${first[0]}`, name_acronym: `${first[0]}${last}`.toUpperCase(),
    team_name: "Test Team", team_colour: "e10000",
  }) as Driver;

const mkBundle = (over: Partial<RaceBundle> = {}): RaceBundle => {
  const d1 = drv(1, "Max", "Verstappen");
  const d2 = drv(16, "Charles", "Leclerc");
  const drivers = [d1, d2];
  return {
    sessionKey: 900,
    drivers,
    results: [
      { meeting_key: 1, session_key: 900, driver_number: 1, position: 1, points: 25, dnf: false, dns: false, dsq: false, gap_to_leader: null, duration: 5400 },
      { meeting_key: 1, session_key: 900, driver_number: 16, position: 2, points: 18, dnf: false, dns: false, dsq: false, gap_to_leader: 5.2, duration: 5405 },
    ] as SessionResult[],
    laps: [
      { session_key: 900, driver_number: 1, lap_number: 1, lap_duration: null, duration_sector_1: null, duration_sector_2: null, duration_sector_3: null },
      { session_key: 900, driver_number: 1, lap_number: 2, lap_duration: 92.5, duration_sector_1: 30.1, duration_sector_2: 31.2, duration_sector_3: 31.2 },
      { session_key: 900, driver_number: 1, lap_number: 3, lap_duration: 91.0, duration_sector_1: 29.5, duration_sector_2: 31.0, duration_sector_3: 30.5 },
      { session_key: 900, driver_number: 16, lap_number: 2, lap_duration: 93.0, duration_sector_1: 30.4, duration_sector_2: 31.3, duration_sector_3: 31.3 },
    ] as Lap[],
    intervals: [] as Interval[],
    stints: [
      { session_key: 900, driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 20, compound: "SOFT", tyre_age_at_start: 0 },
      { session_key: 900, driver_number: 1, stint_number: 2, lap_start: 21, lap_end: 40, compound: "HARD", tyre_age_at_start: 0 },
      { session_key: 900, driver_number: 16, stint_number: 1, lap_start: 1, lap_end: 25, compound: null, tyre_age_at_start: 0 },
    ] as Stint[],
    pitEvents: [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: 2.4, stop_speed: null },
      { session_key: 900, driver_number: 16, lap_number: 26, stop_duration: null, stop_speed: null },
    ] as PitEvent[],
    overtakes: [
      { session_key: 900, meeting_key: 1, date: "2024-05-26T13:05:00", overtaking_driver_number: 1, overtaken_driver_number: 16, position: 1 },
      { session_key: 900, meeting_key: 1, date: "2024-05-26T13:10:00", overtaking_driver_number: 16, overtaken_driver_number: 1, position: 2 },
    ] as Overtake[],
    grid: [
      { session_key: 900, driver_number: 1, grid_position: 1 },
      { session_key: 900, driver_number: 16, grid_position: 3 },
    ] as StartingGrid[],
    numberToDriver: new Map(drivers.map((d) => [d.driver_number, d])),
    stale: false,
    ...over,
  };
};

describe("parseInterval", () => {
  it("number → time", () => {
    expect(parseInterval(0.5)).toEqual({ type: "time", seconds: 0.5 });
  });
  it("null / undefined / empty → none", () => {
    expect(parseInterval(null)).toEqual({ type: "none" });
    expect(parseInterval(undefined)).toEqual({ type: "none" });
    expect(parseInterval("")).toEqual({ type: "none" });
  });
  it("Leader (case-insensitive) → leader", () => {
    expect(parseInterval("Leader")).toEqual({ type: "leader" });
    expect(parseInterval("leader")).toEqual({ type: "leader" });
  });
  it("+N LAP(s) → lapped", () => {
    expect(parseInterval("+1 LAP")).toEqual({ type: "lapped", laps: 1 });
    expect(parseInterval("+2 laps")).toEqual({ type: "lapped", laps: 2 });
    expect(parseInterval("+10 laps")).toEqual({ type: "lapped", laps: 10 });
  });
  it("numeric string → time", () => {
    expect(parseInterval("1.234")).toEqual({ type: "time", seconds: 1.234 });
  });
  it("garbage → none (never fabricated)", () => {
    expect(parseInterval("???")).toEqual({ type: "none" });
  });
});

describe("fmtInterval", () => {
  it("time formats as m:ss.mmm with sign", () => {
    expect(fmtInterval({ type: "time", seconds: 61.5 })).toBe("1:01.500");
    expect(fmtInterval({ type: "time", seconds: -2.25 })).toBe("-0:02.250");
  });
  it("lapped singular/plural", () => {
    expect(fmtInterval({ type: "lapped", laps: 1 })).toBe("+1 LAP");
    expect(fmtInterval({ type: "lapped", laps: 2 })).toBe("+2 LAPS");
  });
  it("leader / none", () => {
    expect(fmtInterval({ type: "leader" })).toBe("Leader");
    expect(fmtInterval({ type: "none" })).toBe("—");
  });
});

describe("fmtLapTime / fmtSectorTime", () => {
  it("lap time m:ss.mmm", () => {
    expect(fmtLapTime(92.1)).toBe("1:32.100");
    expect(fmtLapTime(null)).toBe("—");
    expect(fmtLapTime(Infinity)).toBe("—");
  });
  it("sectors bare seconds under 60s, lap-time fallback above", () => {
    expect(fmtSectorTime(30.123)).toBe("30.123");
    expect(fmtSectorTime(92.5)).toBe("1:32.500");
    expect(fmtSectorTime(null)).toBe("—");
  });
});

describe("computeStrategies", () => {
  it("stint→stops, compounds, fastest, best sector, pit avg, overtakes, grid", () => {
    const s = computeStrategies(mkBundle());
    expect(s).toHaveLength(2);
    const verstappen = s[0]; // position 1 sorts first
    expect(verstappen.finishPosition).toBe(1);
    expect(verstappen.points).toBe(25);
    expect(verstappen.totalStops).toBe(1); // 2 stints - 1
    expect(verstappen.compounds).toEqual(["SOFT", "HARD"]);
    expect(verstappen.stintLaps).toEqual([20, 20]);
    expect(verstappen.fastestLap).toBe(91.0); // null lap ignored
    expect(verstappen.bestSector).toEqual({ sector: 1, value: 29.5, lap: 3 });
    expect(verstappen.avgStopTime).toBe(2.4);
    expect(verstappen.overtakesMade).toBe(1);
    expect(verstappen.overtakesLost).toBe(1);
    expect(verstappen.gridPosition).toBe(1);
    expect(verstappen.driver.driver_number).toBe(1);
  });

  it("starting_grid live docs shape: `position` (no grid_position) resolves grid", () => {
    // openf1.org docs example rows carry `position`, not `grid_position` —
    // reading only grid_position rendered 'Grid —' for every driver live.
    const b = mkBundle({
      grid: [
        { session_key: 900, driver_number: 1, position: 4 },
        { session_key: 900, driver_number: 16, grid_position: 3, position: 3 },
      ] as StartingGrid[],
    });
    const s = computeStrategies(b);
    expect(s.find((x) => x.driver.driver_number === 1)!.gridPosition).toBe(4);
    expect(s.find((x) => x.driver.driver_number === 16)!.gridPosition).toBe(3); // alias unchanged
  });

  it("missing compound normalises to '?'; null stop_duration → avgStop null", () => {
    const leclerc = computeStrategies(mkBundle())[1];
    expect(leclerc.compounds).toEqual(["?"]);
    expect(leclerc.totalStops).toBe(0);
    expect(leclerc.avgStopTime).toBeNull();
    expect(leclerc.fastestLap).toBe(93.0);
    expect(leclerc.gridPosition).toBe(3);
  });

  it("DNF/no-finish sorts last; empty results → empty array", () => {
    const b = mkBundle();
    b.results = [
      { meeting_key: 1, session_key: 900, driver_number: 16, position: null as unknown as number, points: 0, dnf: true, dns: false, dsq: false, gap_to_leader: null, duration: null },
    ] as SessionResult[];
    const s = computeStrategies(b);
    expect(s[0].finishPosition).toBeNull();
    expect(s[0].points).toBe(0);
    expect(computeStrategies({ ...b, results: [] })).toEqual([]);
  });
});

describe("detailFields", () => {
  const s = () => computeStrategies(mkBundle())[0];
  const phases = (p: DetailPhase): { laps: DetailPhase; pit: DetailPhase; overtakes: DetailPhase; grid: DetailPhase } =>
    ({ laps: p, pit: p, overtakes: p, grid: p });

  it("pending → fields report pending with empty text", () => {
    const d = detailFields(s(), phases("pending"));
    expect(d.grid).toEqual({ pending: true, text: "" });
    expect(d.fastestLap).toEqual({ pending: true, text: "" });
    expect(d.avgStop).toEqual({ pending: true, text: "" });
    expect(d.overtakes).toEqual({ pending: true, text: "" });
  });

  it("ready → concrete texts (error-field rendering uses the same '—' path)", () => {
    const d = detailFields(s(), phases("ready"));
    expect(d.place).toBe("P1 · +25 pts");
    expect(d.grid).toEqual({ pending: false, text: "Grid P1" });
    expect(d.finish).toBe("Finish P1");
    expect(d.fastestLap.text).toContain("1:31.000");
    expect(d.bestSector.text).toContain("29.5");
    expect(d.stops).toBe("Pit stops 1");
    expect(d.avgStop.text).toContain("2.40s");
    expect(d.overtakes.text).toContain("+1/-1");
  });

  it("failed resource folds to ready → '—', never a fabricated value", () => {
    // Race.tsx maps res[k].error → phase "ready"; fields then render real data
    // or "—" when the payload is empty — same detailFields contract.
    const empty = { ...s(), gridPosition: null, avgStopTime: null, fastestLap: null, bestSector: null, overtakesMade: 0, overtakesLost: 0 };
    const d = detailFields(empty, phases("ready"));
    expect(d.grid.text).toBe("Grid —");
    expect(d.fastestLap.text).toContain("—");
    expect(d.bestSector.text).toBe("Best —");
    expect(d.avgStop.text).toContain("—");
    expect(d.overtakes.text).toBe("Overtakes —");
  });
});

// --- pit duration semantics: OpenF1 stop_duration = stationary tyre-change
// time; lane_duration = total pit-lane time; pit_duration = deprecated.
// The displayed metric must be stop_duration only, unavailable stays unavailable.
describe("pit duration semantics (stop_duration only)", () => {
  const phases = (p: DetailPhase): { laps: DetailPhase; pit: DetailPhase; overtakes: DetailPhase; grid: DetailPhase } =>
    ({ laps: p, pit: p, overtakes: p, grid: p });

  it("uses stop_duration, never lane_duration (stationary ≠ pit-lane total)", () => {
    const b = mkBundle();
    b.pitEvents = [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: 2.4, stop_speed: null, lane_duration: 8.0 },
    ] as RaceBundle["pitEvents"];
    const v = computeStrategies(b).find((s) => s.driver.driver_number === 1)!;
    expect(v.avgStopTime).toBe(2.4);
    expect(v.avgStopTime).not.toBe(8.0);
  });

  it("missing stop_duration → unavailable, never fabricated 0", () => {
    const b = mkBundle();
    b.pitEvents = [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: null, stop_speed: null, lane_duration: 8.0 },
    ] as RaceBundle["pitEvents"];
    const v = computeStrategies(b).find((s) => s.driver.driver_number === 1)!;
    expect(v.avgStopTime).toBeNull();
    const d = detailFields(v, phases("ready"));
    expect(d.avgStop.text).toContain("—");
    expect(d.avgStop.text).not.toContain("0.00");
  });

  it("stop_duration = 0 displays 0, not dropped or falsy-coerced", () => {
    const b = mkBundle();
    b.pitEvents = [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: 0, stop_speed: null },
    ] as RaceBundle["pitEvents"];
    const v = computeStrategies(b).find((s) => s.driver.driver_number === 1)!;
    expect(v.avgStopTime).toBe(0);
    const d = detailFields(v, phases("ready"));
    expect(d.avgStop.text).toContain("0.00s");
  });

  it("missing pit data (no pit rows) → unavailable", () => {
    const b = mkBundle();
    b.pitEvents = [];
    for (const s of computeStrategies(b)) expect(s.avgStopTime).toBeNull();
  });

  it("multiple pit stops → average of non-null stop_duration values", () => {
    const b = mkBundle();
    b.pitEvents = [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: 2.4, stop_speed: null },
      { session_key: 900, driver_number: 1, lap_number: 35, stop_duration: 2.8, stop_speed: null },
      { session_key: 900, driver_number: 1, lap_number: 48, stop_duration: null, stop_speed: null },
    ] as RaceBundle["pitEvents"];
    const v = computeStrategies(b).find((s) => s.driver.driver_number === 1)!;
    expect(v.avgStopTime).toBeCloseTo(2.6, 10); // (2.4 + 2.8) / 2 — null not counted
  });

  it("historical session: stop_duration unavailable → unavailable, never 0", () => {
    const b = mkBundle();
    b.pitEvents = [
      { session_key: 900, driver_number: 1, lap_number: 21, stop_duration: null, stop_speed: null },
      { session_key: 900, driver_number: 1, lap_number: 35, stop_duration: null, stop_speed: null },
    ] as RaceBundle["pitEvents"];
    const v = computeStrategies(b).find((s) => s.driver.driver_number === 1)!;
    expect(v.avgStopTime).toBeNull();
    const d = detailFields(v, phases("ready"));
    expect(d.avgStop.text).not.toContain("0.00");
  });

  it("detailFields label states stationary semantics (not pit-lane)", () => {
    const d = detailFields(computeStrategies(mkBundle())[0], phases("ready"));
    expect(d.avgStop.text).toContain("stationary");
    expect(d.avgStop.text).toContain("2.40s");
  });

  it("Race.tsx pit chart labels state stationary semantics", () => {
    // node env, no jsdom — assert the source labels directly (regression on copy)
    const src = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(src).toContain('title="Pit Stop Times (stationary');
    expect(src).toContain('name="Avg stationary (s)"');
    expect(src).toMatch(/srSummary="[^"]*stationary[^"]*"/);
  });

  it("Race.tsx overtake chart declares layout=\"vertical\" (missing → no bars)", () => {
    // node env, no jsdom — assert the source directly (regression on silent empty plot)
    const src = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/<BarChart data=\{overtakeRows[\s\S]{0,300}?layout="vertical"/);
  });
});

// --- A3: tyre-pill label contrast (WCAG AA: ≥4.5:1 for 12px text) ---
describe("tyre pill contrast (A3)", () => {
  const rgb = (hex: string): [number, number, number] => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const contrast = (fg: string, bg: string): number => {
    const a = relativeLuminance(...rgb(fg));
    const b = relativeLuminance(...rgb(bg));
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("SOFT / MEDIUM / HARD label pairs all clear 4.5:1", () => {
    for (const c of ["SOFT", "MEDIUM", "HARD"] as const) {
      const { bg, fg } = TYRE_PILL_COLORS[c];
      expect(contrast(fg, bg), `${c}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("hues stay tyre-faithful (soft=red-ish, medium=yellow, hard=grey)", () => {
    const [sr, sg, sb] = rgb(TYRE_PILL_COLORS.SOFT.bg);
    expect(sr).toBeGreaterThan(sg); expect(sr).toBeGreaterThan(sb);
    const [mr, mg, mb] = rgb(TYRE_PILL_COLORS.MEDIUM.bg);
    expect(mb).toBeLessThan(mr); expect(mb).toBeLessThan(mg);
    const [hr, hg, hb] = rgb(TYRE_PILL_COLORS.HARD.bg);
    expect(Math.max(hr, hg, hb) - Math.min(hr, hg, hb)).toBeLessThan(20);
    // labels are dark, not the light --foreground that measured 1.33:1
    expect(relativeLuminance(...rgb(TYRE_PILL_COLORS.MEDIUM.fg))).toBeLessThan(0.05);
  });
});

// --- PF-02: PaceTab must not rebuild its chart data every render ---
describe("PaceTab sector derivation is reference-stable (PF-02)", () => {
  it("identical (bundle, driver) → same array reference", () => {
    const b = mkBundle();
    const first = driverLapsForSectors(b, 1);
    expect(driverLapsForSectors(b, 1)).toBe(first);
    expect(first.map((l) => l.lap_number)).toEqual([2, 3]); // lap 1 (warm-up) skipped

    const other = driverLapsForSectors(b, 16);
    expect(other).not.toBe(first);
    expect(driverLapsForSectors(b, 16)).toBe(other);
  });

  it("Race.tsx derives laps through useMemo on [bundle, refDriver]", () => {
    // node env, no jsdom — assert the source (regression on inline rebuild → tween restart)
    const src = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(src).toMatch(
      /useMemo\(\s*\(\)\s*=>\s*\(refDriver != null \? driverLapsForSectors\(bundle, refDriver\) : \[\]\),\s*\[bundle, refDriver\],\s*\)/,
    );
  });
});

// --- PF-07: resize state bucketing — only the 768px breakpoint matters ---
describe("PF-07: resize width bucketing", () => {
  it("buckets strictly at 768px", () => {
    expect(widthBucketOf(0)).toBe("mobile");
    expect(widthBucketOf(375)).toBe("mobile");
    expect(widthBucketOf(767)).toBe("mobile");
    expect(widthBucketOf(768)).toBe("desktop");
    expect(widthBucketOf(2560)).toBe("desktop");
  });

  it("Race.tsx sets width state only on bucket change; chartHeight keys off the bucket", () => {
    // node env, no jsdom — assert the source (regression on raw innerWidth state)
    const src = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/setWidthBucket\(\(prev\) => \(prev === bucket \? prev : bucket\)\)/);
    expect(src).toMatch(/const chartHeight = widthBucket === "mobile" \? 260 : 320/);
    expect(src).not.toMatch(/setWidth\(window\.innerWidth\)/);
    expect(src).not.toMatch(/width < 768/);
  });
});

// --- Group 3 regressions (node env, no jsdom → source asserts) ---
const raceSrc = () => readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");

// UX-05: the Lap area (~95 s) shared the sector Y-axis (25–45 s) → flat
// sectors. Lap series must stay gone; auto domain tightens to the sectors.
describe("UX-05: sector chart has no Lap area", () => {
  const src = raceSrc();
  it("no <Area dataKey=\"total\"> anywhere", () => {
    expect(src).not.toMatch(/<Area dataKey="total"/);
  });
  it("srSummary describes sector-only lines", () => {
    expect(src).toMatch(/srSummary="Line chart of sector 1, sector 2 and sector 3/);
    expect(src).not.toMatch(/Area chart of total lap time/);
  });
  it("YAxis keeps domain=[auto,auto] (data-range, not 0-based default)", () => {
    // Recharts defaults to a 0-based axis: without auto↔auto the 29–32 s
    // sector deltas collapse against 0 again (regression: ticks 0s…32s).
    const paceBlock = src.slice(src.indexOf('title="Sector Times"'), src.indexOf("---- Gaps"));
    expect(paceBlock).toMatch(/domain=\{\["auto", "auto"\]\}/);
  });
});

// UX-06: overtakes chart had two <Bar> series, hover-only — Legend matches siblings.
describe("UX-06: overtakes chart has a Legend", () => {
  it("<Legend> inside the Overtakes Made BarChart", () => {
    const src = raceSrc();
    const block = src.slice(src.indexOf('title="Overtakes Made"'));
    const chartEnd = block.indexOf("</BarChart>");
    expect(chartEnd).toBeGreaterThan(0);
    expect(block.slice(0, chartEnd)).toMatch(/<Legend wrapperStyle=\{\{ fontSize: 11 \}\}/);
  });
});

// UX-07: "Fastest lap 1:31.000" read as session-fastest — must name the driver.
describe("UX-07: fastest-lap text names the selected driver", () => {
  const src = raceSrc();
  it("driver name precedes 'fastest lap'", () => {
    expect(src).toMatch(/\{nameOfDriver\(refDriverName\)\} fastest lap \{fmtLapTime\(fastestLap\)\}/);
  });
  it("no bare 'Fastest lap {fmtLapTime…}' copy in Pace", () => {
    expect(src).not.toMatch(/>Fastest lap \{fmtLapTime/);
  });
});

// UX-08: dead "muted small" classes + one-sided sign copy — both signs defined,
// Tailwind classes that actually exist in v4.
describe("UX-08: gaps explainer copy + classes", () => {
  const src = raceSrc();
  it("dead classes gone, real Tailwind classes present", () => {
    expect(src).not.toMatch(/className="muted small"/);
    expect(src).toMatch(/className="text-xs text-muted-foreground"/);
  });
  it("copy defines both signs of the interval", () => {
    expect(src).toMatch(/\+ = behind the car ahead/);
    expect(src).toMatch(/− = ahead of it/);
  });
});

// A1: sibling <label> has no htmlFor and the header label is hidden at 375px
// → aria-label on each Select trigger.
describe("A1: Select triggers expose accessible names", () => {
  const src = raceSrc();
  it("Driver (x2) + Compare driver triggers are labelled", () => {
    expect(src.match(/aria-label="Driver"/g)).toHaveLength(2);
    expect(src.match(/aria-label="Compare driver"/g)).toHaveLength(1);
    expect(src).toMatch(/<SelectTrigger[^>]*aria-label="Driver"/);
  });
  it("header Season select is labelled in App.tsx", () => {
    const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/<SelectTrigger[^>]*aria-label="Season"/);
  });
});

// A2: chart data reachable for SR — ChartCard renders an opt-in sr-only table.
describe("A2: sr-only chart tables", () => {
  it("ChartCard accepts srTable and renders it sr-only", () => {
    const card = readFileSync(new URL("../../src/components/charts/ChartCard.tsx", import.meta.url), "utf8");
    expect(card).toMatch(/srTable\?: React\.ReactNode/);
    expect(card).toMatch(/<Table className="sr-only" aria-label="Chart data table">/);
    expect(card).toMatch(/\{srTable\}/);
  });
  it("Race charts opt in (pace, gaps, pit x2)", () => {
    expect(raceSrc().match(/srTable=\{/g)).toHaveLength(4);
  });
  it("Season charts opt in (championship, constructors, strategies)", () => {
    const season = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");
    expect(season.match(/srTable=\{/g)).toHaveLength(3);
  });
});

// UX-02: Race driver/compare state persists in the query string.
describe("UX-02: Race URL state wiring", () => {
  const src = raceSrc();
  it("initial state + meeting reset derive from URL params", () => {
    expect(src).toMatch(/useSearchParams\(\)/);
    expect(src).toMatch(/useState<number \| null>\(\(\) => parseDriverParam\(searchParams\.get\("driver"\)\)\)/);
    expect(src).toMatch(/setRefDriver\(parseDriverParam\(searchParamsRef\.current\.get\("driver"\)\)\)/);
  });
  it("writes with replace; tab navigation carries the query", () => {
    expect(src).toMatch(/setSearchParams\(next, \{ replace: true \}\)/);
    expect(src).toMatch(/navigate\(search \? `\$\{to\}\?\$\{search\}` : to\)/);
  });
  it("invalid params fall back via parseDriverParam guards", () => {
    expect(src).toMatch(/Number\.isInteger\(n\) && n > 0 \? n : null/);
  });
  it("App redirects preserve the query string", () => {
    const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
    expect(app.match(/\/pace\$\{search\}/g)).toHaveLength(2);
  });
});

// --- PF-12 / A5 / A7 / race first-paint regressions ---

// PF-12: the Gaps spine used `new Date(x.date).toLocaleTimeString([], { hour12:
// false })` per point — a locale formatter per sample, ~50 µs × 135 pts × 2
// series ≈ 18 ms of sync work on every ref/rival change.
describe("PF-12: Gaps x-axis clock", () => {
  const isoSamples: string[] = [
    "2024-05-26T00:00:00.000Z", "2024-05-26T00:00:09.000Z",
    "2024-05-26T07:05:07.000Z", "2024-05-26T13:45:59.000Z",
    "2024-05-26T23:59:59.000Z", "2024-12-31T12:30:00.000Z",
    "2024-01-01T00:00:00.000Z", "2024-03-10T07:59:59.000Z",
  ];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 5, 9, 59]) {
      isoSamples.push(`2024-06-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:07.000Z`);
    }
  }

  it("is byte-identical to toLocaleTimeString([], { hour12: false })", () => {
    for (const iso of isoSamples) {
      const ms = new Date(iso).getTime();
      expect(fmtClock(ms)).toBe(new Date(iso).toLocaleTimeString([], { hour12: false }));
    }
  });

  it("is fixed-width zero-padded HH:MM:SS", () => {
    expect(fmtClock(new Date(2024, 0, 1, 7, 5, 9).getTime())).toBe("07:05:09");
    expect(fmtClock(new Date(2024, 0, 1, 0, 0, 0).getTime())).toBe("00:00:00");
  });

  it("no locale formatting left on the Gaps path", () => {
    const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
    const data = stripComments(readFileSync(new URL("../../src/data/race.ts", import.meta.url), "utf8"));
    expect(data).not.toMatch(/toLocaleTimeString|toLocaleString/);
    expect(stripComments(raceSrc())).not.toMatch(/toLocaleTimeString/);
  });
});

describe("PF-12: gapSeries derivation bench", () => {
  // realistic spine: 2 drivers × 200 laps, mixed time/lapped/leader/none rows
  const intervals: Interval[] = Array.from({ length: 400 }, (_, i) => ({
    session_key: 900,
    driver_number: i % 2 === 0 ? 1 : 16,
    date: new Date(Date.UTC(2024, 4, 26, 13, 0, 0) + i * 95_000).toISOString(),
    interval: i % 17 === 0 ? "+1 LAP" : i % 23 === 0 ? "Leader" : i % 31 === 0 ? null : (i % 10) / 100,
  })) as Interval[];

  // the pre-PF-12 pipeline, verbatim minus the clock change — the comparison
  // baseline for the numbers reported alongside this fix.
  const legacySeries = (rows: Interval[], driver: number) => {
    const raw = rows
      .filter((i) => i.driver_number === driver)
      .map((i) => ({ date: i.date, v: parseInterval(i.interval) }))
      .filter((x) => x.v.type !== "none")
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((x) => ({
      ms: new Date(x.date).getTime(),
      t: new Date(x.date).toLocaleTimeString([], { hour12: false }),
      gap: x.v.type === "time" ? x.v.seconds : null,
      gapLabel: fmtInterval(x.v),
      rivalGap: null as number | null,
      rivalGapLabel: "",
    }));
  };

  it("produces the same spine as the locale path (format parity on real rows)", () => {
    expect(gapSeries(intervals, 1)).toEqual(legacySeries(intervals, 1));
    expect(gapSeries(intervals, 16)).toEqual(legacySeries(intervals, 16));
    expect(gapSeries(intervals, null)).toEqual([]);
  });

  it("whole pipeline (scan+parse+downsample+clock) stays under the 2 ms target", () => {
    // audit before: 7.3–9.0 ms for the full derivation incl. locale formatting
    const runs = 50;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      gapSeries(intervals, 1);
      gapSeries(intervals, 16);
    }
    const perPair = (performance.now() - t0) / runs;
    const t1 = performance.now();
    for (let i = 0; i < runs; i++) {
      legacySeries(intervals, 1);
      legacySeries(intervals, 16);
    }
    const legacyPerPair = (performance.now() - t1) / runs;
    // eslint-disable-next-line no-console
    console.log(`PF-12 bench: gapSeries ${perPair.toFixed(3)}ms vs locale ${legacyPerPair.toFixed(3)}ms per ref+rival pair`);
    expect(perPair).toBeLessThan(2);
  });
});

// A5: audit reported the header year badge as white-on-red 4.38:1 at 12 px
// bold. NOT REPRODUCIBLE — App.tsx renders variant="secondary"
// (#e8e8ec on #1f1f23). The 4.38:1 pair is #ffffff on #ed1c24, i.e. the
// badge's variant="default", which this app never uses. Guard both facts.
describe("A5: header year badge contrast", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

  it("year badge is variant=\"secondary\", never the white-on-red default", () => {
    expect(app).toMatch(/<Badge variant="secondary"[^>]*>\{year \?\? DEFAULT_YEAR\}/);
    expect(app).not.toMatch(/<Badge variant="default"/);
  });

  it("rendered pair clears 4.5:1; the reported pair is the unused default", () => {
    expect(contrast("#e8e8ec", "#1f1f23")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#e8e8ec", "#1f1f23")).toBeCloseTo(13.44, 1);
    expect(contrast("#ffffff", "#ed1c24")).toBeCloseTo(4.38, 2); // the audit number
  });
});

// A7: no skip link — first Tab landed on the header Season select.
describe("A7: skip link", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

  it("skip link is the first focusable element in the shell", () => {
    const link = app.indexOf('href="#main"');
    expect(link).toBeGreaterThan(0);
    expect(link).toBeLessThan(app.indexOf("<h1"));
    expect(link).toBeLessThan(app.indexOf("<Select"));
  });

  it("targets #main, and <main id=\"main\"> can actually take focus", () => {
    expect(app).toMatch(/sr-only focus:not-sr-only/);
    expect(app).toMatch(/<main id="main" tabIndex=\{-1\}/);
  });
});

// Race first paint: the base-load branch early-returned a bare skeleton, so the
// meeting card + tabs waited on a fetch they don't need, and ChartCard's title
// rendered "Loading…" as a real <h3>.
describe("Race first paint: chrome before data", () => {
  const src = raceSrc();

  it("no bare skeleton early-return above the chrome", () => {
    expect(src).not.toMatch(/if \(!bundle && !fullError\) return <LoadSkeleton/);
    expect(src).toMatch(/const basePending = !bundle && !fullError/);
  });

  it("skeleton renders inside each tab's content area", () => {
    expect(src).toMatch(/<TabsContent key=\{t\.id\} value=\{t\.id\}>\s*<LoadSkeleton chartHeight=\{chartHeight\} \/>/);
  });

  it("skeleton has no ChartCard heading", () => {
    expect(src).not.toMatch(/title="Loading…"/);
    expect(src).toMatch(/const LoadSkeleton/);
  });
});
