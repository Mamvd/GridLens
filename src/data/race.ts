import {
  getOpenF1,
  type Driver, type Lap, type Interval, type Stint, type PitEvent,
  type SessionResult, type Overtake, type StartingGrid,
} from "../api/openf1";
import { cached, classifySeason, getCachePolicy, LIVE_DATA_ENABLED } from "../api/cache";

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

// ponytail: default in-progress when year omitted — short TTL is the safe
// default for unknown recency. Upgrade path = pass the actual session
// date_end from the session rows already in memory to detect live precisely.
// live=true only takes effect when LIVE_DATA_ENABLED (free tier has no real-time).
const racePolicy = (year?: number, live?: boolean) => {
  const status = LIVE_DATA_ENABLED && live ? "live" : year == null ? "in-progress" : classifySeason(year);
  return getCachePolicy(year ?? new Date().getFullYear(), status);
};

// one cached() call per resource — revisit-hits the two-tier cache (intervals
// stays memory-only via the 500 KB localStorage gate in api/cache.ts)
const raceRes = <T>(resource: string, sessionKey: number, year?: number, live?: boolean) =>
  cached<T>(resource, { session_key: sessionKey },
    () => getOpenF1<T>(resource, { session_key: sessionKey }), racePolicy(year, live));

// always-needed resources (page shell: header, computeStrategies base)
export const loadRaceBase = async (sessionKey: number, year?: number, live?: boolean) => {
  const [resultsRes, driversRes] = await Promise.all([
    raceRes<SessionResult>("session_result", sessionKey, year, live),
    raceRes<Driver>("drivers", sessionKey, year, live),
  ]);
  return {
    results: resultsRes.data,
    drivers: driversRes.data,
    stale: resultsRes.stale || driversRes.stale,
  };
};

export const loadLaps = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<Lap>("laps", sessionKey, year, live);
export const loadIntervals = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<Interval>("intervals", sessionKey, year, live);
export const loadStints = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<Stint>("stints", sessionKey, year, live);
export const loadPit = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<PitEvent>("pit", sessionKey, year, live);
export const loadOvertakes = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<Overtake>("overtakes", sessionKey, year, live);
export const loadGrid = (sessionKey: number, year?: number, live?: boolean) =>
  raceRes<StartingGrid>("starting_grid", sessionKey, year, live);

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

export const loadRaceBundle = async (
  sessionKey: number,
  year?: number,
  live?: boolean,
): Promise<RaceBundle> => {
  const [base, lapsRes, intervalsRes, stintsRes, pitRes, overtakesRes, grid] =
    await Promise.all([
      loadRaceBase(sessionKey, year, live),
      loadLaps(sessionKey, year, live),
      loadIntervals(sessionKey, year, live),
      loadStints(sessionKey, year, live),
      loadPit(sessionKey, year, live),
      loadOvertakes(sessionKey, year, live),
      (async () => {
        // starting_grid occasionally errors on older data — don't sink the bundle
        try {
          return await getOpenF1<StartingGrid>("starting_grid", { session_key: sessionKey });
        } catch {
          return [] as StartingGrid[];
        }
      })(),
    ]);

  const numberToDriver = new Map(base.drivers.map((d) => [d.driver_number, d]));
  return {
    sessionKey,
    drivers: base.drivers,
    results: base.results,
    laps: lapsRes.data,
    intervals: intervalsRes.data,
    stints: stintsRes.data,
    pitEvents: pitRes.data,
    overtakes: overtakesRes.data,
    grid,
    numberToDriver,
    stale: base.stale || lapsRes.stale || intervalsRes.stale || stintsRes.stale
      || pitRes.stale || overtakesRes.stale,
  };
};

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
export const driverLapsForSectors = (b: RaceBundle, driverNumber: number) =>
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
    avgStop: f(phases.pit, () => `(avg ${s.avgStopTime != null ? `${s.avgStopTime.toFixed(2)}s` : "—"})`),
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
