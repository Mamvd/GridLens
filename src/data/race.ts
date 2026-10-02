import {
  getOpenF1,
  type Driver, type Lap, type Interval, type Stint, type PitEvent,
  type SessionResult, type Overtake, type StartingGrid,
} from "../api/openf1";
import { getCached, setCached } from "../api/cache";

// --- fetch helpers (cached cheap resources) ---

const cached = async <T>(resource: string, ops: Parameters<typeof getCached>[1], fn: () => Promise<T[]>) => {
  const hit = getCached<T[]>(resource, ops);
  if (hit) return hit;
  const data = await fn();
  setCached(resource, ops, data);
  return data;
};

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
  nameToDriver: Map<string, Driver>;
  numberToDriver: Map<number, Driver>;
}

export const loadRaceBundle = async (
  sessionKey: number,
): Promise<RaceBundle> => {
    const [drivers, laps, intervals, stints, pitEvents, results, overtakes, grid] =
    await Promise.all([
      cached<Driver>("drivers", { session_key: sessionKey }, () =>
        getOpenF1<Driver>("drivers", { session_key: sessionKey })),
      cached<Lap>("laps", { session_key: sessionKey }, () =>
        getOpenF1<Lap>("laps", { session_key: sessionKey })),
      cached<Interval>("intervals", { session_key: sessionKey }, () =>
        getOpenF1<Interval>("intervals", { session_key: sessionKey })),
      cached<Stint>("stints", { session_key: sessionKey }, () =>
        getOpenF1<Stint>("stints", { session_key: sessionKey })),
      cached<PitEvent>("pit", { session_key: sessionKey }, () =>
        getOpenF1<PitEvent>("pit", { session_key: sessionKey })),
      cached<SessionResult>("session_result", { session_key: sessionKey }, () =>
        getOpenF1<SessionResult>("session_result", { session_key: sessionKey })),
      cached<Overtake>("overtakes", { session_key: sessionKey }, () =>
        getOpenF1<Overtake>("overtakes", { session_key: sessionKey })),
      (async () => {
        // starting_grid occasionally errors on older data — don't sink the bundle
        try {
          return await getOpenF1<StartingGrid>("starting_grid", { session_key: sessionKey });
        } catch {
          return [] as StartingGrid[];
        }
      })(),
    ]);

  const nameToDriver = new Map(drivers.map((d) => [d.driver_name, d]));
  const numberToDriver = new Map(drivers.map((d) => [d.driver_number, d]));
  return {
    sessionKey, drivers, laps, intervals, stints, pitEvents, results, overtakes, grid,
    nameToDriver, numberToDriver,
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
