import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  BarChart, Bar, CartesianGrid, Legend,
} from "recharts";
import { seasonBundle, type SeasonStats } from "../data/season";
import type { Meeting } from "../api/openf1";

interface Props {
  year: number;
  meetings: Meeting[];
  onOpenRace: (meeting: Meeting) => void;
}

export const Season = ({ year, meetings, onOpenRace }: Props) => {
  const [stats, setStats] = useState<SeasonStats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    seasonBundle(year, meetings)
      .then((b) => {
        if (!alive) return;
        setStats(b.stats);
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [year, meetings]);

  // cumulative points per driver across the season
  const standingsSeries = useMemo(() => {
    if (!stats) return { rows: [] as Record<string, number | string>[], names: [] as string[] };
    const perDriver = new Map<string, number>();
    const rows: Record<string, number | string>[] = [];
    for (const p of stats.progression) {
      for (const dp of p.racePoints) {
        perDriver.set(dp.name, (perDriver.get(dp.name) ?? 0) + dp.points);
      }
      const top = [...perDriver.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const row: Record<string, number | string> = { race: p.meetingName };
      top.forEach(([name, pts]) => (row[name] = pts));
      rows.push(row);
    }
    const names = [...perDriver.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);
    return { rows, names };
  }, [stats]);

  if (loading) return <div className="muted">Loading {year} season…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!stats) return null;

  const topTeams = stats.teamChampionship.slice(0, 10);
  const topStrategies = stats.strategyCount.filter((s) => s.strategy !== "no-data").slice(0, 8);

  return (
    <div className="season">
      <section>
        <h3>Meetings</h3>
        <div className="meetings">
          {meetings.map((m) => (
            <button key={m.meeting_key} className="meeting" onClick={() => onOpenRace(m)}>
              <span className="flag"><img src={m.country_flag} alt="" width={24} /></span>
              <span>{m.meeting_name}</span>
              <span className="muted">{m.circuit_short_name}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Drivers' championship (top 10, cumulative)</h3>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={standingsSeries.rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="race" tick={{ fontSize: 10 }} interval={1} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {standingsSeries.names.map((n) => (
              <Line key={n} dataKey={n} dot={false} strokeWidth={2} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section>
        <h3>Constructors' championship</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={topTeams}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="team" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="points" fill="#4a7dff" name="Points" />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section>
        <h3>Most common strategies (compound sequences)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={topStrategies} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="strategy" width={120} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="count" fill="#34c98e" name="Races" />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section>
        <h3>Drivers' points</h3>
        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Team</th><th>Pts</th><th>Wins</th><th>Podiums</th><th>DNF</th></tr>
          </thead>
          <tbody>
            {stats.championship.map((d) => (
              <tr key={d.driverName}>
                <td>{d.driverName}</td>
                <td>{d.team}</td>
                <td>{d.points}</td>
                <td>{d.wins}</td>
                <td>{d.podiums}</td>
                <td>{d.dnf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};
