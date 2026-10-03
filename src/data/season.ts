import {
  getOpenF1,
  type Meeting, type Session, type SessionResult,
} from "../api/openf1";
import { cached, classifySeason, getCachePolicy } from "../api/cache";

// Season-scoped cache policy: completed years persist forever; the current
// year uses a short TTL + revalidate-on-expiry (see api/cache.ts).
const seasonPolicy = (year: number) => getCachePolicy(year, classifySeason(year));

export interface SeasonPitStop {
  driver_number: number;
  session_key: number;
  stop_duration: number | null;
  stop_speed: number | null;
}
export interface SeasonStint {
  driver_number: number;
  session_key: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string | null;
}

export interface RaceDriver {
  // OpenF1 has no driver_name field (verified 2023-2025) — name is built from first+last.
  first_name: string;
  last_name: string;
  team_name: string;
  driver_number: number;
  session_key: number;
  // hex "RRGGBB" (sometimes with #); absent on some rows → chart falls back
  team_colour?: string;
}

// API sends boolean dnf/dns/dsq; SessionResult type still declares stale is_dnf (always null).
type ResultRow = SessionResult & { dnf?: boolean };

// All GP meetings for a year (meetings?year=N works; exclude tests).
export const seasonMeetings = (year: number, opts?: { signal?: AbortSignal }) =>
  cached<Meeting>("meetings", { year }, (signal) => {
    const all = getOpenF1<Meeting>("meetings", { year }, { signal });
    return all.then((rows) => rows.filter((m) => m.meeting_name.includes("Grand Prix")));
  }, seasonPolicy(year), opts);

// Race sessions for the whole year in one query (sessions?year=N works).
export const seasonRaceSessions = (year: number, opts?: { signal?: AbortSignal }) =>
  cached<Session>("sessions", { year, session_name: "Race" }, (signal) =>
    getOpenF1<Session>("sessions", { year, session_name: "Race" }, { signal }),
    seasonPolicy(year), opts);

// Sprint sessions (6 per season) — points-scoring, separate from seasonRaceSessions.
export const seasonSprintSessions = (year: number, opts?: { signal?: AbortSignal }) =>
  cached<Session>("sessions", { year, session_name: "Sprint" }, (signal) =>
    getOpenF1<Session>("sessions", { year, session_name: "Sprint" }, { signal }),
    seasonPolicy(year), opts);

export interface SeasonPoint {
  meetingKey: number;
  meetingName: string;
  raceDate: string;
  winner: { name: string; points: number };
  podium: { name: string; points: number; pos: number }[];
  racePoints: { name: string; points: number }[]; // all finishers, for cumulative chart
}

export interface DriverChampionship {
  driverName: string;
  team: string;
  points: number;
  wins: number;
  podiums: number;
  dnf: number;
}

export interface SeasonStats {
  year: number;
  championship: DriverChampionship[];
  teamChampionship: { team: string; points: number }[];
  pitStats: { driverName: string; stops: number; avgStop: number | null }[];
  strategyCount: { strategy: string; count: number }[]; // compound sequences across season
  progression: SeasonPoint[];
}

// --- progressive load: two stages (#8) ---
// core = championship/teams/progression/standings; extras = strategy (+ pit).
// Both use the same cached keys as before — stages re-arrange, never add,
// fetches. seasonBundle composes both (behavior-identical for existing callers).

export interface SeasonCore {
  meetings: Meeting[];
  championship: DriverChampionship[];
  teamChampionship: { team: string; points: number }[];
  progression: SeasonPoint[];
  // last-seen API team_colour per driver name ("first last"), chronological
  // walk — missing names mean the chart uses its deterministic fallback
  driverColours: Record<string, string>;
  stale: boolean;
}

export interface SeasonExtras {
  pitStats: SeasonStats["pitStats"];
  strategyCount: SeasonStats["strategyCount"];
  stale: boolean;
}

const bySession = <T extends { session_key: number }>(rows: T[]) => {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = r.session_key;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
};

// Stage A: sessions + session_result + drivers → everything standings-shaped.
export const seasonCore = async (year: number, meetings?: Meeting[], opts?: { signal?: AbortSignal }): Promise<SeasonCore> => {
  const ownMeetings = meetings ? null : await seasonMeetings(year, opts);
  const m = meetings ?? ownMeetings!.data;

  // Batch the whole season into 2 multi-value requests (OpenF1 accepts
  // repeated session_key). ponytail: swap for per-race cached requests only
  // if a single batch response outgrows browser memory (~rare).
  const racesRes = await seasonRaceSessions(year, opts);
  const sprintsRes = await seasonSprintSessions(year, opts);
  const races = racesRes.data;
  const sprints = sprintsRes.data;
  const sks = races.map((r) => r.session_key);
  const sprintSks = sprints.map((s) => s.session_key);
  const [resultsRes, driversRes] = await Promise.all([
    // session_result spans Race + Sprint (points); mixed batch stays HTTP 200
    // as long as ≥1 key has rows — ponytail: future/empty sessions
    // contribute zero rows via the `?? []` below, no special-casing.
    cached<ResultRow>("session_result", { session_key: [...sks, ...sprintSks] }, (signal) =>
      getOpenF1<ResultRow>("session_result", { session_key: [...sks, ...sprintSks] }, { signal }),
      seasonPolicy(year), opts),
    cached<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }, (signal) =>
      getOpenF1<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }, { signal }),
      seasonPolicy(year), opts),
  ]);
  const results = resultsRes.data;
  const drivers = driversRes.data;
  // any sub-fetch served stale → surface it once for the view banner
  const stale = (ownMeetings?.stale ?? false) || racesRes.stale || sprintsRes.stale
    || resultsRes.stale || driversRes.stale;
  const resultsBySession = bySession(results);
  const driversBySession = bySession(drivers);
  const perRace = races.map((s) => ({
    sk: s.session_key,
    meetingKey: s.meeting_key,
    date: s.date_start ?? "",
    results: resultsBySession.get(s.session_key) ?? [],
    drivers: driversBySession.get(s.session_key) ?? [],
  }));
  // ponytail: empty/future sprints (`?? []`) contribute zero points, no crash.
  // drivers rows fetch race+sprint keys — sprint team can differ from race team
  // on the same weekend (per-session team is the constructor source of truth).
  const perSprint = sprints.map((s) => ({
    sk: s.session_key,
    meetingKey: s.meeting_key,
    date: s.date_start ?? "",
    results: resultsBySession.get(s.session_key) ?? [],
    drivers: driversBySession.get(s.session_key) ?? [],
  }));

  const nameOf = (meetingKey: number, n: number) => {
    const d = perRace.find((p) => p.meetingKey === meetingKey)?.drivers.find((x) => x.driver_number === n);
    return d ? `${d.first_name} ${d.last_name}` : `#${n}`;
  };
  const teamOf = (meetingKey: number, n: number) =>
    perRace.find((p) => p.meetingKey === meetingKey)?.drivers.find((d) => d.driver_number === n)?.team_name ?? "Unknown";

  const progression: SeasonPoint[] = [];
  for (const meeting of m) {
    const p = perRace.find((r) => r.meetingKey === meeting.meeting_key);
    if (!p) continue;
    const sorted = [...p.results].filter((r) => r.driver_number).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
    if (!sorted.length) continue;
    const winner = sorted[0];
    progression.push({
      meetingKey: meeting.meeting_key,
      meetingName: meeting.meeting_name,
      raceDate: meeting.date_start,
      winner: { name: nameOf(meeting.meeting_key, winner.driver_number!), points: winner.points ?? 0 },
      podium: sorted.slice(0, 3).map((r) => ({
        name: nameOf(meeting.meeting_key, r.driver_number!),
        points: r.points ?? 0,
        pos: r.position,
      })),
      racePoints: sorted.map((r) => ({
        name: nameOf(meeting.meeting_key, r.driver_number!),
        points: r.points ?? 0,
      })),
    });
  }

  // ponytail: sprint points merge into the same weekend's racePoints — one
  // x-axis point per meeting (sprint Sat + race Sun are one chart column);
  // winner/podium stay Race-based above.
  for (const sp of perSprint) {
    const entry = progression.find((p) => p.meetingKey === sp.meetingKey);
    if (!entry) continue;
    for (const r of sp.results.filter((r) => r.driver_number)) {
      entry.racePoints.push({
        name: nameOf(sp.meetingKey, r.driver_number!),
        points: r.points ?? 0,
      });
    }
  }

  // Driver + team championship — walk sessions chronologically so constructor
  // credit and the display team follow per-session truth (mid-season swaps,
  // sprint≠race team on the same weekend). Real 2025 case: Ricciardo RBR→RB,
  // Tsunoda RB→RBR; frozen first-seen misattributed both.
  // ponytail: wins/podiums/dnf stay Race-only — sprint adds points only
  // (upgrade: sprint-win countback for official tie-breaks).
  const perDriver = new Map<string, DriverChampionship>();
  const lastTeam = new Map<string, string>();
  const teamPts = new Map<string, number>();
  const colourByName = new Map<string, string>();
  const sessionsChrono = [
    ...perRace.map((p) => ({ date: p.date, meetingKey: p.meetingKey, drivers: p.drivers, results: p.results, sprint: false })),
    ...perSprint.map((p) => ({ date: p.date, meetingKey: p.meetingKey, drivers: p.drivers, results: p.results, sprint: true })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sessionsChrono) {
    // colour follows the same chronological last-seen walk as the team
    for (const d of s.drivers) {
      if (d.team_colour) colourByName.set(`${d.first_name} ${d.last_name}`, d.team_colour);
    }
    for (const r of s.results.filter((r) => r.driver_number)) {
      // per-session team: that session's drivers row wins; meeting-level race
      // drivers are the fallback when a sprint session has no drivers rows.
      const team = s.drivers.find((d) => d.driver_number === r.driver_number)?.team_name
        ?? teamOf(s.meetingKey, r.driver_number!);
      const name = nameOf(s.meetingKey, r.driver_number!);
      const cur = perDriver.get(name) ?? {
        driverName: name, team,
        points: 0, wins: 0, podiums: 0, dnf: 0,
      };
      cur.points += r.points ?? 0;
      if (!s.sprint) {
        if (r.position === 1) cur.wins++;
        if (r.position >= 1 && r.position <= 3) cur.podiums++;
        if (r.dnf) cur.dnf++;
      }
      perDriver.set(name, cur);
      lastTeam.set(name, team); // chronological walk → last-seen = final team
      teamPts.set(team, (teamPts.get(team) ?? 0) + (r.points ?? 0));
    }
  }
  // display team = last-seen across the season (final team after swaps)
  for (const v of perDriver.values()) {
    const t = lastTeam.get(v.driverName);
    if (t) v.team = t;
  }

  return {
    meetings: m,
    championship: [...perDriver.values()].sort((a, b) => b.points - a.points),
    teamChampionship: [...teamPts.entries()].map(([team, points]) => ({ team, points })).sort((a, b) => b.points - a.points),
    progression,
    driverColours: Object.fromEntries(colourByName),
    stale,
  };
};

// Stage B: stints + pit → strategy frequency (+ pitStats, unused by the view).
// ponytail: re-reads sessions/drivers keys as cache-shares of core's fetches
// (in-flight dedupe when both stages run together → zero extra requests);
// upgrade = pass core's rows in to skip the re-read when a caller needs a
// standalone extras retry without touching those keys.
export const seasonExtras = async (year: number, opts?: { signal?: AbortSignal }): Promise<SeasonExtras> => {
  const racesRes = await seasonRaceSessions(year, opts);
  const sprintsRes = await seasonSprintSessions(year, opts);
  const sks = racesRes.data.map((r) => r.session_key);
  const sprintSks = sprintsRes.data.map((s) => s.session_key);
  const [pitRes, stintsRes, driversRes] = await Promise.all([
    cached<SeasonPitStop>("pit", { session_key: sks }, (signal) =>
      getOpenF1<SeasonPitStop>("pit", { session_key: sks }, { signal }), seasonPolicy(year), opts),
    cached<SeasonStint>("stints", { session_key: sks }, (signal) =>
      getOpenF1<SeasonStint>("stints", { session_key: sks }, { signal }), seasonPolicy(year), opts),
    cached<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }, (signal) =>
      getOpenF1<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }, { signal }), seasonPolicy(year), opts),
  ]);
  const stale = racesRes.stale || sprintsRes.stale || pitRes.stale || stintsRes.stale || driversRes.stale;
  const pitBySession = bySession(pitRes.data);
  const stintsBySession = bySession(stintsRes.data);
  const driversBySession = bySession(driversRes.data);
  const races = racesRes.data;
  const nameOf = (sessionKey: number, n: number) => {
    const d = driversBySession.get(sessionKey)?.find((x) => x.driver_number === n);
    return d ? `${d.first_name} ${d.last_name}` : `#${n}`;
  };
  // Pit-stop stats (kept in SeasonStats; no view consumer today)
  const stopAgg = new Map<string, { stops: number; total: number }>();
  for (const r of races) {
    for (const stop of pitBySession.get(r.session_key) ?? []) {
      const name = nameOf(r.session_key, stop.driver_number);
      const cur = stopAgg.get(name) ?? { stops: 0, total: 0 };
      cur.stops++;
      if (stop.stop_duration != null) cur.total += stop.stop_duration;
      stopAgg.set(name, cur);
    }
  }

  // Strategy frequency: compound sequence per driver per race (skip warmup laps < 2)
  const strategyAgg = new Map<string, number>();
  for (const r of races) {
    const byDriver = new Map<number, string[]>();
    for (const s of stintsBySession.get(r.session_key) ?? []) {
      const arr = byDriver.get(s.driver_number) ?? [];
      if (s.compound) arr.push(s.compound);
      byDriver.set(s.driver_number, arr);
    }
    byDriver.forEach((seq) => {
      const key = seq.length ? seq.join("-") : "no-data";
      strategyAgg.set(key, (strategyAgg.get(key) ?? 0) + 1);
    });
  }

  return {
    pitStats: [...stopAgg.entries()]
      .map(([driverName, v]) => ({ driverName, stops: v.stops, avgStop: v.stops ? v.total / v.stops : null }))
      .sort((a, b) => b.stops - a.stops),
    strategyCount: [...strategyAgg.entries()].map(([strategy, count]) => ({ strategy, count })).sort((a, b) => b.count - a.count),
    stale,
  };
};

export const seasonBundle = async (year: number, meetings?: Meeting[]): Promise<{ meetings: Meeting[]; stats: SeasonStats; stale: boolean }> => {
  const [core, extras] = await Promise.all([seasonCore(year, meetings), seasonExtras(year)]);
  return {
    meetings: core.meetings,
    stats: {
      year,
      championship: core.championship,
      teamChampionship: core.teamChampionship,
      pitStats: extras.pitStats,
      strategyCount: extras.strategyCount,
      progression: core.progression,
    },
    stale: core.stale || extras.stale,
  };
};
