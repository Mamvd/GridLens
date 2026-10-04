import {
  getOpenF1,
  type Driver, type Lap, type Interval, type Stint, type PitEvent,
  type SessionResult, type Overtake, type StartingGrid,
} from "../api/openf1";
import { cached, classifySeason, getCachePolicy, LIVE_DATA_ENABLED, peekCached, peekCachedBatch } from "../api/cache";

// ponytail: API has no display-name field — compose first+last; keep one helper,
// add shared formatter in lib/ if a third call site needs styling.
export const nameOfDriver = (d: Driver): string => `${d.first_name} ${d.last_name}`;

// --- fetch helpers (cached cheap resources) ---

export interface RaceBundle {
  sessionKey: number;
  drivers: Driver[];
  laps: Lap[];
  intervals: Interval[];
  stints: Stint[];
  pitEvents: PitEvent[];
  results: SessionResult[];
  overtakes: Overtake[];
  grid: StartingGrid[];
  numberToDriver: Map<number, Driver>;
  stale: boolean;
}

// Future race → no session rows exist yet; a single-key request 404s with no
// CORS headers (opaque "Failed to fetch"). Prevent the call, don't catch it.
// Boundary: date_start == now counts as run (strict >).
export const raceIsUnrun = (m: { date_start: string }, nowMs: number = Date.now()): boolean =>
  new Date(m.date_start).getTime() > nowMs;

// PF-07: chart heights only change at the 768px breakpoint — bucket widths so
// sub-boundary resize events cause zero state updates / re-renders.
// (Boundary: <768 mobile, ≥768 desktop; same edge as Tailwind's `md`.)
export type WidthBucket = "mobile" | "desktop";
export const widthBucketOf = (width: number): WidthBucket =>
  width < 768 ? "mobile" : "desktop";

// ponytail: default in-progress when year omitted — short TTL is the safe
// default for unknown recency. Upgrade path = pass the actual session
// date_end from the session rows already in memory to detect live precisely.
// live=true only takes effect when LIVE_DATA_ENABLED (free tier has no real-time).
const racePolicy = (year?: number, live?: boolean) => {
  const status = LIVE_DATA_ENABLED && live ? "live" : year == null ? "in-progress" : classifySeason(year);
  return getCachePolicy(year ?? new Date().getFullYear(), status);
};

// one read per resource. NF-01: single-key entry first (peek — no fetch, no
// stale-entry eviction, so cached()'s stale-if-error rescue still works), then
// a fresh season BATCH entry containing this session_key (rows filtered
// in-memory) — Season→Race then costs 0 request starts for rows season
// already owns. Batch miss falls through to the normal single-key cached()
// fetch, so cold direct-to-race behaves exactly as before (abort/signal/
// stale-if-error all live in that cached() call). ponytail: upgrade =
// query-side join / key aliases in the cache layer, dropping this bridge.
const raceRes = async <T extends { session_key: number }>(
  resource: string, sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal },
): Promise<{ data: T[]; stale: boolean }> => {
  const policy = racePolicy(year, live);
  if (policy.persist) {
    const single = peekCached<T>(resource, { session_key: sessionKey }, policy.ttlMs);
    if (single) return { data: single, stale: false };
    // batch alias only makes sense on persisted tiers; live always refetches
    const batch = peekCachedBatch<T>(resource, sessionKey, policy.ttlMs);
    // ponytail: a batch containing this key but zero rows (empty/future
    // session) is served as [] — a single-key fetch would 404 anyway.
    if (batch) return { data: batch.filter((r) => r.session_key === sessionKey), stale: false };
  }
  return cached<T>(resource, { session_key: sessionKey },
    (signal) => getOpenF1<T>(resource, { session_key: sessionKey }, { signal }),
    policy, opts);
};

// NF-02: settle each slice independently — one rejection must not fail the
// sibling that resolved (its rows stay usable; only the failed slice gets an
// error). AbortError still rethrows (aborted nav must not become a slice
// error, or a year-swap would paint an error card for the new race).
export interface RaceBase {
  results?: SessionResult[];
  resultsError?: string;
  drivers?: Driver[];
  driversError?: string;
  stale: boolean;
}

// always-needed resources (page shell: header, computeStrategies base)
export const loadRaceBase = async (
  sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal },
): Promise<RaceBase> => {
  const settle = <T,>(
    p: Promise<{ data: T[]; stale: boolean }>,
  ): Promise<{ ok: { data: T[]; stale: boolean } } | { err: unknown }> =>
    p.then((v) => ({ ok: v }), (err: unknown) => ({ err }));
  const [results, drivers] = await Promise.all([
    settle(raceRes<SessionResult>("session_result", sessionKey, year, live, opts)),
    settle(raceRes<Driver>("drivers", sessionKey, year, live, opts)),
  ]);
  for (const s of [results, drivers]) {
    if ("err" in s && (s.err as Error)?.name === "AbortError") throw s.err;
  }
  return {
    results: "ok" in results ? results.ok.data : undefined,
    resultsError: "err" in results ? String(results.err) : undefined,
    drivers: "ok" in drivers ? drivers.ok.data : undefined,
    driversError: "err" in drivers ? String(drivers.err) : undefined,
    stale: ("ok" in results && results.ok.stale) || ("ok" in drivers && drivers.ok.stale),
  };
};

export const loadLaps = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<Lap>("laps", sessionKey, year, live, opts);
export const loadIntervals = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<Interval>("intervals", sessionKey, year, live, opts);
export const loadStints = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<Stint>("stints", sessionKey, year, live, opts);
export const loadPit = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<PitEvent>("pit", sessionKey, year, live, opts);
export const loadOvertakes = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<Overtake>("overtakes", sessionKey, year, live, opts);
export const loadGrid = (sessionKey: number, year?: number, live?: boolean, opts?: { signal?: AbortSignal }) =>
  raceRes<StartingGrid>("starting_grid", sessionKey, year, live, opts);

// --- tab → resource map (shared by Race.tsx and race-loading-check.mjs) ---
// base (drivers + results) always loads immediately; these are the extras.
export type TabName = "pace" | "gaps" | "strategy" | "pit";
export type RaceResKey = "drivers" | "results" | "laps" | "intervals" | "stints" | "pit" | "overtakes" | "grid";

// detail-card extras (#14) — on-demand only, NEVER in TAB_RESOURCES: the
// default per-tab request sets stay byte-identical to #7.
export const DETAIL_RESOURCES: readonly RaceResKey[] = ["laps", "pit", "overtakes", "grid"];
export const missingDetail = (has: (k: RaceResKey) => boolean): RaceResKey[] =>
  DETAIL_RESOURCES.filter((k) => !has(k));

export const TAB_RESOURCES: Record<TabName, readonly RaceResKey[]> = {
  pace: ["laps"],
  gaps: ["intervals"],
  strategy: ["stints"],
  pit: ["stints", "pit", "overtakes"],
};

export const missingResources = (tab: TabName, has: (k: RaceResKey) => boolean): RaceResKey[] =>
  (TAB_RESOURCES[tab] ?? []).filter((k) => !has(k));

// --- derived analytics ---

export interface DriverStrategy {
  driver: Driver;
  finishPosition: number | null;
  points: number | null;
  totalStops: number;
  compounds: string[]; // per stint, in order
  stintLaps: number[]; // laps per stint
  avgStopTime: number | null;
  fastestLap: number | null;
  bestSector: { sector: 1 | 2 | 3; value: number; lap: number } | null;
  overtakesMade: number;
  overtakesLost: number;
  gridPosition: number | null;
}

// A3: tyre-pill label pairs for the strategy rows. 12px text needs ≥4.5:1,
// and the chart fills are far too bright for the light --foreground label —
// so labels are near-black on all three. SOFT is lifted a hair off
// --chart-1 (#ed1c24) because it lands at 4.27:1 against #121214; MEDIUM and
// HARD keep their exact --chart-2/--chart-3 values. Hues stay tyre-faithful
// (red / yellow / grey). Contrast asserted in test/unit/race-analytics.test.ts.
export const TYRE_PILL_COLORS = {
  SOFT: { bg: "#f4343c", fg: "#121214" },
  MEDIUM: { bg: "#f5c518", fg: "#121214" },
  HARD: { bg: "#8a8a93", fg: "#121214" },
} as const;

export const computeStrategies = (b: RaceBundle): DriverStrategy[] =>
  b.results
    .filter((r) => r.driver_number)
    .map((r) => {
      const driver = b.numberToDriver.get(r.driver_number)!;
      const dStints = b.stints.filter((s) => s.driver_number === r.driver_number);
      const dPits = b.pitEvents.filter((p) => p.driver_number === r.driver_number);
      // ponytail: is_valid_lap is null for most years in the live data; a
      // lap with a duration is the practical "timed" signal. Drop the
      // is_valid_lap gate; keep it if you import a dataset that populates it.
      const dLaps = b.laps.filter(
        (l) => l.driver_number === r.driver_number && l.lap_duration != null,
      );
      const fastest = dLaps.map((l) => l.lap_duration!).reduce((a, c) => Math.min(a, c), Infinity);
      const bestSec = dLaps.reduce<{ sector: 1 | 2 | 3; value: number; lap: number } | null>(
        (best, l) => {
          const secs: [number | null, 1 | 2 | 3][] = [
            [l.duration_sector_1, 1],
            [l.duration_sector_2, 2],
            [l.duration_sector_3, 3],
          ];
          for (const [v, s] of secs) {
            if (v != null && (best == null || v < best.value)) {
              best = { sector: s, value: v, lap: l.lap_number };
            }
          }
          return best;
        },
        null,
      );
      const stopTimes = dPits.map((p) => p.stop_duration).filter((v): v is number => v != null);
      return {
        driver,
        finishPosition: r.position,
        points: r.points,
        totalStops: dStints.length - 1, // first stint is the start, each subsequent stint = a stop
        compounds: dStints.map((s) => s.compound ?? "?"),
        stintLaps: dStints.map((s) => s.lap_end - s.lap_start + 1),
        avgStopTime: stopTimes.length ? stopTimes.reduce((a, c) => a + c, 0) / stopTimes.length : null,
        fastestLap: fastest === Infinity ? null : fastest,
        bestSector: bestSec,
        overtakesMade: b.overtakes.filter((o) => o.overtaking_driver_number === r.driver_number).length,
        overtakesLost: b.overtakes.filter((o) => o.overtaken_driver_number === r.driver_number).length,
        gridPosition: b.grid.find((g) => g.driver_number === r.driver_number)?.grid_position ?? null,
      };
    })
    .sort((a, b) => (a.finishPosition ?? 99) - (b.finishPosition ?? 99));

// Sector-trace: driver lap-by-lap sector times (skip warm-up lap 1).
const computeSectorLaps = (b: RaceBundle, driverNumber: number) =>
  b.laps
    .filter((l) => l.driver_number === driverNumber && l.lap_number > 1)
    .map((l) => ({
      lap_number: l.lap_number,
      s1: l.duration_sector_1,
      s2: l.duration_sector_2,
      s3: l.duration_sector_3,
      total: l.lap_duration,
    }))
    .sort((a, c) => a.lap_number - c.lap_number);

type SectorLaps = ReturnType<typeof computeSectorLaps>;

// PF-02: identical (bundle, driver) must hand back the SAME array reference —
// a fresh array on every parent re-render restarts Recharts' 1500ms tweens.
// ponytail: 1-slot identity cache (bundle comes from useState, driver from
// useState, so both are referentially stable in practice); upgrade to a
// WeakMap keyed on bundle if a second consumer alternates bundles per frame.
let sectorKey: readonly [RaceBundle, number] | null = null;
let sectorVal: SectorLaps = [];

export const driverLapsForSectors = (b: RaceBundle, driverNumber: number): SectorLaps => {
  if (sectorKey && sectorKey[0] === b && sectorKey[1] === driverNumber) return sectorVal;
  sectorVal = computeSectorLaps(b, driverNumber);
  sectorKey = [b, driverNumber];
  return sectorVal;
};

export const fmtLapTime = (secs: number | null | undefined): string => {
  if (secs == null || !isFinite(secs)) return "—";
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
};

// sector times render as bare seconds ("28.104") per the detail-card spec;
// ≥60s falls back to fmtLapTime so pathological values don't print "3600.000".
export const fmtSectorTime = (secs: number | null | undefined): string => {
  if (secs == null || !isFinite(secs)) return "—";
  if (secs < 60) return secs.toFixed(3);
  return fmtLapTime(secs);
};

// --- #14 detail card: pure field resolver (React-free, tested) ---
// "ready" covers loaded-empty AND failed — both render "—", never a
// fabricated 0/"none"; only "pending" renders a skeleton.
export type DetailPhase = "pending" | "ready";

export interface StrategyDetail {
  place: string;
  grid: { pending: boolean; text: string };
  finish: string;
  fastestLap: { pending: boolean; text: string };
  bestSector: { pending: boolean; text: string };
  stops: string;
  avgStop: { pending: boolean; text: string };
  overtakes: { pending: boolean; text: string };
}

export const detailFields = (
  s: DriverStrategy,
  phases: { laps: DetailPhase; pit: DetailPhase; overtakes: DetailPhase; grid: DetailPhase },
): StrategyDetail => {
  const f = (phase: DetailPhase, text: () => string) =>
    phase === "pending" ? { pending: true, text: "" } : { pending: false, text: text() };
  return {
    place: `P${s.finishPosition ?? "—"}${s.points != null ? ` · +${s.points} pts` : ""}`,
    grid: f(phases.grid, () => `Grid ${s.gridPosition != null ? `P${s.gridPosition}` : "—"}`),
    finish: `Finish P${s.finishPosition ?? "—"}`,
    fastestLap: f(phases.laps, () => `Fastest lap ${fmtLapTime(s.fastestLap)}`),
    bestSector: f(phases.laps, () =>
      s.bestSector ? `Best S${s.bestSector.sector} ${fmtSectorTime(s.bestSector.value)}` : "Best —",
    ),
    stops: `Pit stops ${s.totalStops}`,
    // stop_duration = stationary tyre-change seconds (not pit-lane total); null stays "—"
    avgStop: f(phases.pit, () => `(stationary avg ${s.avgStopTime != null ? `${s.avgStopTime.toFixed(2)}s` : "—"})`),
    overtakes: f(phases.overtakes, () =>
      s.overtakesMade + s.overtakesLost > 0
        ? `Overtakes +${s.overtakesMade}/-${s.overtakesLost}`
        : "Overtakes —",
    ),
  };
};

// --- interval parsing (single tested boundary for GapsTab) ---
// free tier verified numbers-only in 2023/2024/2025 races; the string forms
// below are documented but untestable live — handled defensively, never
// fabricated: unexpected input collapses to "none".

export type IntervalValue =
  | { type: "time"; seconds: number }
  | { type: "lapped"; laps: number }
  | { type: "leader" }
  | { type: "none" };

export const parseInterval = (raw: number | string | null | undefined): IntervalValue => {
  if (raw == null) return { type: "none" };
  if (typeof raw === "number") return { type: "time", seconds: raw };
  const t = raw.trim();
  if (t === "") return { type: "none" };
  if (/^leader$/i.test(t)) return { type: "leader" };
  const m = /^\+\s*(\d+)\s*(laps?)$/i.exec(t);
  if (m) return { type: "lapped", laps: Number(m[1]) };
  const n = Number(t);
  if (!Number.isNaN(n)) return { type: "time", seconds: n };
  return { type: "none" };
};

export const fmtInterval = (v: IntervalValue): string => {
  switch (v.type) {
    case "time": {
      const s = v.seconds;
      const sign = s < 0 ? "-" : "";
      const a = Math.abs(s);
      const mm = Math.floor(a / 60);
      return `${sign}${mm}:${(a - mm * 60).toFixed(3).padStart(6, "0")}`;
    }
    case "lapped": return `+${v.laps} ${v.laps === 1 ? "LAP" : "LAPS"}`;
    case "leader": return "Leader";
    case "none": return "—";
  }
};

// PF-12: Gaps x-axis clock. `new Date(iso).toLocaleTimeString([], { hour12:
// false })` builds a locale formatter per point (~50 µs × 135 points × 2
// series ≈ 18 ms of sync work on every driver/rival change). Fixed-width
// HH:MM:SS padding is byte-identical to that call's output on the default
// locale and costs ~1 µs. Verify parity in test/unit/race-analytics.test.ts.
export const fmtClock = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export type GapPoint = {
  ms: number; t: string;
  gap: number | null; gapLabel: string;
  rivalGap: number | null; rivalGapLabel: string;
};

// PF-12: one driver's interval spine — filter, parse, sort, downsample to
// 150 points, clock each point. Pure and React-free so the perf bench times
// the real pipeline; Race.tsx memoizes it on the intervals data ref + driver.
export const gapSeries = (intervals: readonly Interval[], driver: number | null): GapPoint[] => {
  if (driver == null) return [];
  const raw = intervals
    .filter((i) => i.driver_number === driver)
    .map((i) => ({ date: i.date, v: parseInterval(i.interval) }))
    // drop only "none" — lapped/leader stay in the spine as line gaps
    .filter((x) => x.v.type !== "none")
    .sort((a, b) => a.date.localeCompare(b.date));
  const step = Math.max(1, Math.ceil(raw.length / 150));
  return raw.filter((_, i) => i % step === 0).map((x) => {
    const ms = new Date(x.date).getTime();
    return {
      ms,
      t: fmtClock(ms),
      gap: x.v.type === "time" ? x.v.seconds : null, // lapped/leader → null → line gap
      gapLabel: fmtInterval(x.v),
      rivalGap: null,
      rivalGapLabel: "",
    };
  });
};
