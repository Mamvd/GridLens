import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seasonExtras } from "../../src/data/season";
import { __resetCacheForTests } from "../../src/api/cache";
import { lsReset } from "./setup";

// seasonExtras pitStats: avg must divide by the count of NON-NULL
// stop_duration values — OpenF1 stop_duration = stationary tyre-change time
// (lane_duration = pit-lane total, never used), nulls are legitimate in
// historical sessions and must yield unavailable (null), never a fabricated 0.

type Row = Record<string, unknown>;
let FIXTURE: { sessions: Row[]; pit: Row[]; stints: Row[]; drivers: Row[] } =
  { sessions: [], pit: [], stints: [], drivers: [] };
const realFetch = globalThis.fetch;

beforeEach(() => {
  __resetCacheForTests();
  lsReset();
  FIXTURE = { sessions: [], pit: [], stints: [], drivers: [] };
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const resource = u.pathname.split("/").pop();
    const qp = u.searchParams;
    const sks = qp.getAll("session_key").map(Number);
    let rows: Row[] = [];
    if (resource === "sessions") {
      const year = Number(qp.get("year"));
      const name = qp.get("session_name");
      rows = FIXTURE.sessions.filter((s) => s.year === year && s.session_name === name);
    } else if (resource === "pit") rows = FIXTURE.pit.filter((p) => sks.includes(p.session_key as number));
    else if (resource === "stints") rows = FIXTURE.stints.filter((s) => sks.includes(s.session_key as number));
    else if (resource === "drivers") rows = FIXTURE.drivers.filter((d) => sks.includes(d.session_key as number));
    return {
      ok: true, status: 200,
      json: async () => rows, text: async () => JSON.stringify(rows),
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetCacheForTests();
  lsReset();
});

// one race session in `year` for driver 44
const season = (year: number, pit: Row[]) => {
  FIXTURE.sessions = [{ session_key: 7000, meeting_key: 700, session_name: "Race", year, date_start: `${year}-03-02`, date_end: `${year}-03-02` }];
  FIXTURE.pit = pit.map((p) => ({ session_key: 7000, meeting_key: 700, driver_number: 44, ...p }));
  FIXTURE.stints = [];
  FIXTURE.drivers = [{ session_key: 7000, driver_number: 44, first_name: "Test", last_name: "Driver", team_name: "Test Team" }];
  return year;
};

describe("seasonExtras pitStats (stationary stop_duration avg)", () => {
  it("valid stop_duration → avg of stop_duration", async () => {
    const year = season(2091, [{ stop_duration: 2.4, stop_speed: null }]);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats).toEqual([{ driverName: "Test Driver", stops: 1, avgStop: 2.4 }]);
  });

  it("lane_duration present but different → avg uses stop_duration, not lane", async () => {
    const year = season(2092, [{ stop_duration: 2.4, stop_speed: null, lane_duration: 8.0 }]);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats[0].avgStop).toBe(2.4);
    expect(pitStats[0].avgStop).not.toBe(8.0);
  });

  it("mixed nulls divide by non-null count only (not stop count)", async () => {
    const year = season(2093, [
      { stop_duration: 2.4, stop_speed: null },
      { stop_duration: null, stop_speed: null },
    ]);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats[0].stops).toBe(2);
    expect(pitStats[0].avgStop).toBe(2.4); // biased-low bug: 2.4/2 = 1.2
  });

  it("stop_duration = 0 counted as 0, never dropped", async () => {
    const year = season(2094, [
      { stop_duration: 0, stop_speed: null },
      { stop_duration: 2.0, stop_speed: null },
    ]);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats[0].stops).toBe(2);
    expect(pitStats[0].avgStop).toBe(1.0); // (0 + 2) / 2
  });

  it("historical session: all stop_duration null → avgStop null (unavailable), stops still counted", async () => {
    const year = season(2095, [
      { stop_duration: null, stop_speed: null },
      { stop_duration: null, stop_speed: null },
    ]);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats[0].stops).toBe(2);
    expect(pitStats[0].avgStop).toBeNull(); // never a fabricated 0
  });

  it("no pit data → empty pitStats", async () => {
    const year = season(2096, []);
    const { pitStats } = await seasonExtras(year);
    expect(pitStats).toEqual([]);
  });
});
