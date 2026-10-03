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
}

// API sends boolean dnf/dns/dsq; SessionResult type still declares stale is_dnf (always null).
type ResultRow = SessionResult & { dnf?: boolean };

// All GP meetings for a year (meetings?year=N works; exclude tests).
export const seasonMeetings = (year: number) =>
  cached<Meeting>("meetings", { year }, async () => {
    const all = await getOpenF1<Meeting>("meetings", { year });
    return all.filter((m) => m.meeting_name.includes("Grand Prix"));
  }, seasonPolicy(year));

// Race sessions for the whole year in one query (sessions?year=N works).
export const seasonRaceSessions = (year: number) =>
  cached<Session>("sessions", { year, session_name: "Race" }, () =>
    getOpenF1<Session>("sessions", { year, session_name: "Race" }), seasonPolicy(year));

// Sprint sessions (6 per season) — points-scoring, separate from seasonRaceSessions.
export const seasonSprintSessions = (year: number) =>
  cached<Session>("sessions", { year, session_name: "Sprint" }, () =>
    getOpenF1<Session>("sessions", { year, session_name: "Sprint" }), seasonPolicy(year));

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

export const seasonBundle = async (year: number, meetings?: Meeting[]): Promise<{ meetings: Meeting[]; stats: SeasonStats; stale: boolean }> => {
  const ownMeetings = meetings ? null : await seasonMeetings(year);
  const m = meetings ?? ownMeetings!.data;
  const racesRes = await seasonRaceSessions(year);
  const sprintsRes = await seasonSprintSessions(year);
  const races = racesRes.data;
  const sprints = sprintsRes.data;

  // Batch the whole season into 4 multi-value requests (OpenF1 accepts
  // repeated session_key). ponytail: swap for per-race cached requests only
  // if a single batch response outgrows browser memory (~rare).
  const sks = races.map((r) => r.session_key);
  const sprintSks = sprints.map((s) => s.session_key);
  const [resultsRes, pitRes, stintsRes, driversRes] = await Promise.all([
    // session_result spans Race + Sprint (points); mixed batch stays HTTP 200
    // as long as ≥1 key has rows — ponytail: future/empty sessions
    // contribute zero rows via the `?? []` below, no special-casing.
    cached<ResultRow>("session_result", { session_key: [...sks, ...sprintSks] }, () =>
      getOpenF1<ResultRow>("session_result", { session_key: [...sks, ...sprintSks] }), seasonPolicy(year)),
    cached<SeasonPitStop>("pit", { session_key: sks }, () =>
      getOpenF1<SeasonPitStop>("pit", { session_key: sks }), seasonPolicy(year)),
    cached<SeasonStint>("stints", { session_key: sks }, () =>
      getOpenF1<SeasonStint>("stints", { session_key: sks }), seasonPolicy(year)),
    cached<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }, () =>
      getOpenF1<RaceDriver>("drivers", { session_key: [...sks, ...sprintSks] }), seasonPolicy(year)),
  ]);
  const results = resultsRes.data;
  const pit = pitRes.data;
  const stints = stintsRes.data;
  const drivers = driversRes.data;
  // any sub-fetch served stale → surface it once for the view banner
  const stale = (ownMeetings?.stale ?? false) || racesRes.stale || sprintsRes.stale
    || resultsRes.stale || pitRes.stale || stintsRes.stale || driversRes.stale;
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
  const resultsBySession = bySession(results);
  const pitBySession = bySession(pit);
  const stintsBySession = bySession(stints);
  const driversBySession = bySession(drivers);
  const perRace = races.map((s) => ({
    sk: s.session_key,
    meetingKey: s.meeting_key,
    date: s.session_date ?? "",
    results: resultsBySession.get(s.session_key) ?? [],
    pit: pitBySession.get(s.session_key) ?? [],
    stints: stintsBySession.get(s.session_key) ?? [],
    drivers: driversBySession.get(s.session_key) ?? [],
  }));
  // ponytail: empty/future sprints (`?? []`) contribute zero points, no crash.
  // drivers rows fetch race+sprint keys — sprint team can differ from race team
  // on the same weekend (per-session team is the constructor source of truth).
  const perSprint = sprints.map((s) => ({
    sk: s.session_key,
    meetingKey: s.meeting_key,
    date: s.session_date ?? "",
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
  const sessionsChrono = [
    ...perRace.map((p) => ({ date: p.date, meetingKey: p.meetingKey, drivers: p.drivers, results: p.results, sprint: false })),
    ...perSprint.map((p) => ({ date: p.date, meetingKey: p.meetingKey, drivers: p.drivers, results: p.results, sprint: true })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sessionsChrono) {
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

  // Pit-stop stats
  const stopAgg = new Map<string, { stops: number; total: number }>();
  for (const p of perRace) {
    for (const stop of p.pit) {
      const name = nameOf(p.meetingKey, stop.driver_number);
      const cur = stopAgg.get(name) ?? { stops: 0, total: 0 };
      cur.stops++;
      if (stop.stop_duration != null) cur.total += stop.stop_duration;
      stopAgg.set(name, cur);
    }
  }

  // Strategy frequency: compound sequence per driver per race (skip warmup laps < 2)
  const strategyAgg = new Map<string, number>();
  for (const p of perRace) {
    const byDriver = new Map<number, string[]>();
    for (const s of p.stints) {
      const arr = byDriver.get(s.driver_number) ?? [];
      if (s.compound) arr.push(s.compound);
      byDriver.set(s.driver_number, arr);
    }
    byDriver.forEach((seq) => {
      const key = seq.length ? seq.join("-") : "no-data";
      strategyAgg.set(key, (strategyAgg.get(key) ?? 0) + 1);
    });
  }

  const stats: SeasonStats = {
    year,
    championship: [...perDriver.values()].sort((a, b) => b.points - a.points),
    teamChampionship: [...teamPts.entries()].map(([team, points]) => ({ team, points })).sort((a, b) => b.points - a.points),
    pitStats: [...stopAgg.entries()]
      .map(([driverName, v]) => ({ driverName, stops: v.stops, avgStop: v.stops ? v.total / v.stops : null }))
      .sort((a, b) => b.stops - a.stops),
    strategyCount: [...strategyAgg.entries()].map(([strategy, count]) => ({ strategy, count })).sort((a, b) => b.count - a.count),
    progression,
  };
  return { meetings: m, stats, stale };
};
