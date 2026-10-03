import { describe, it, expect } from "vitest";
import {
  parseInterval, fmtInterval, computeStrategies, detailFields, fmtLapTime, fmtSectorTime,
  type RaceBundle, type DetailPhase,
} from "../../src/data/race";
import type { Driver, Lap, Interval, Stint, PitEvent, SessionResult, Overtake, StartingGrid } from "../../src/api/openf1";

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
