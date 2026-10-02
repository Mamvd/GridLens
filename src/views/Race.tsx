import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  BarChart, Bar, CartesianGrid, Legend, ComposedChart, Area,
} from "recharts";
import {
  loadRaceBundle, computeStrategies, driverLapsForSectors, fmtLapTime,
  type RaceBundle,
} from "../data/race";
import type { Meeting } from "../api/openf1";
import { seasonRaceSessions } from "../data/season";

type Tab = "pace" | "gaps" | "strategy" | "pit";
const TABS: { id: Tab; label: string }[] = [
  { id: "pace", label: "Pace" },
  { id: "gaps", label: "Gaps" },
  { id: "strategy", label: "Strategy" },
  { id: "pit", label: "Pit" },
];

const COMPOUND_COLOR: Record<string, string> = {
  SOFT: "#e23b3b", MEDIUM: "#f2c11e", HARD: "#3a3a3a", INTERMEDIATE: "#2fa3d9", WET: "#1565c0",
};

interface Props {
  meeting: Meeting;
  onBack: () => void;
}

export const Race = ({ meeting, onBack }: Props) => {
  const [bundle, setBundle] = useState<RaceBundle | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("pace");
  const [refDriver, setRefDriver] = useState<number | null>(null);
  const [rivalDriver, setRivalDriver] = useState<number | null>(null);

  // find the race session for this meeting
  useEffect(() => {
    seasonRaceSessions(meeting.year)
      .then((sessions) => {
        const race = sessions.find((s) => s.meeting_key === meeting.meeting_key);
        if (!race) { setError("No race session found for this meeting."); return; }
        setRefDriver(null); setRivalDriver(null);
        loadRaceBundle(race.session_key)
          .then((b) => {
            setBundle(b);
            const sorted = [...b.results].filter((r) => r.driver_number).sort((a, b2) => a.position - b2.position);
            if (sorted.length >= 2) {
              setRefDriver(sorted[0].driver_number);
              setRivalDriver(sorted[1].driver_number);
            }
          })
          .catch((e) => setError(String(e)));
      })
      .catch((e) => setError(String(e)));
  }, [meeting]);

  const strategies = useMemo(() => (bundle ? computeStrategies(bundle) : []), [bundle]);

  if (error) return <div className="error">{error}</div>;
  if (!bundle) return <div className="muted">Loading {meeting.meeting_name}…</div>;

  return (
    <div className="race">
      <header className="race-head">
        <button className="back" onClick={onBack}>← Season</button>
        <div>
          <h2>{meeting.meeting_name}</h2>
          <div className="muted">{meeting.circuit_short_name} · {meeting.date_start}</div>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "pace" && (
        <PaceTab bundle={bundle} strategies={strategies} refDriver={refDriver} setRefDriver={setRefDriver} />
      )}
      {tab === "gaps" && (
        <GapsTab bundle={bundle} refDriver={refDriver} rivalDriver={rivalDriver}
          setRefDriver={setRefDriver} setRivalDriver={setRivalDriver} />
      )}
      {tab === "strategy" && <StrategyTab strategies={strategies} />}
      {tab === "pit" && <PitTab strategies={strategies} />}
    </div>
  );
};

// ---- Pace: sector trace for a driver ----
const PaceTab = ({ bundle, strategies, refDriver, setRefDriver }: {
  bundle: RaceBundle; strategies: ReturnType<typeof computeStrategies>;
  refDriver: number | null; setRefDriver: (n: number | null) => void;
}) => {
  const laps = refDriver != null ? driverLapsForSectors(bundle, refDriver) : [];
  const fastestLap = strategies.find((s) => s.driver.driver_number === refDriver)?.fastestLap ?? null;
  return (
    <section>
      <label>
        Driver{" "}
        <select value={refDriver ?? ""} onChange={(e) => setRefDriver(e.target.value ? +e.target.value : null)}>
          <option value="">—</option>
          {bundle.drivers.map((d) => (
            <option key={d.driver_number} value={d.driver_number}>
              {d.driver_name}
            </option>
          ))}
        </select>
        {fastestLap != null && <span className="muted"> · fastest lap {fmtLapTime(fastestLap)}</span>}
      </label>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={laps}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="lap_number" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit="s" domain={["auto", "auto"]} />
          <Tooltip formatter={(v) => (typeof v === "number" ? `${v.toFixed(3)}s` : "—")} />
          <Area dataKey="total" name="Lap" fill="#4a7dff22" stroke="#4a7dff" />
          <Line dataKey="s1" name="Sector 1" dot={false} strokeWidth={1.5} stroke="#34c98e" />
          <Line dataKey="s2" name="Sector 2" dot={false} strokeWidth={1.5} stroke="#f2c11e" />
          <Line dataKey="s3" name="Sector 3" dot={false} strokeWidth={1.5} stroke="#e23b3b" />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
};

// ---- Gaps: interval trace for a driver (gap to car ahead) ----
const GapsTab = ({ bundle, refDriver, rivalDriver, setRefDriver, setRivalDriver }: {
  bundle: RaceBundle; refDriver: number | null; rivalDriver: number | null;
  setRefDriver: (n: number | null) => void; setRivalDriver: (n: number | null) => void;
}) => {
  const series = useMemo(() => {
    if (refDriver == null) return [];
    const raw = bundle.intervals
      .filter((i) => i.driver_number === refDriver && i.interval != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((i) => ({
      t: new Date(i.date).toLocaleTimeString([], { hour12: false }),
      gap: i.interval!,
    }));
  }, [bundle, refDriver]);

  return (
    <section>
      <div className="row">
        <label>Driver
          <select value={refDriver ?? ""} onChange={(e) => setRefDriver(e.target.value ? +e.target.value : null)}>
            <option value="">—</option>
            {bundle.drivers.map((d) => <option key={d.driver_number} value={d.driver_number}>{d.driver_name}</option>)}
          </select>
        </label>
        <label>vs. (context)
          <select value={rivalDriver ?? ""} onChange={(e) => setRivalDriver(e.target.value ? +e.target.value : null)}>
            <option value="">—</option>
            {bundle.drivers.map((d) => <option key={d.driver_number} value={d.driver_number}>{d.driver_name}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">Gap to the car ahead (intervals). Negative = behind / being lapped.</p>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={series}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={60} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Line dataKey="gap" name="Gap" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
};

// ---- Strategy: compound sequence + stops per driver ----
const StrategyTab = ({ strategies }: { strategies: ReturnType<typeof computeStrategies> }) => (
  <section>
    <div className="strategy">
      {strategies.map((s) => (
        <div key={s.driver.driver_number} className="strat-row">
          <span className="num">{s.finishPosition ?? "—"}</span>
          <span>{s.driver.driver_name}</span>
          <span className="comps">
            {s.compounds.map((c, i) => (
              <span key={i} className="chip"
                style={{ background: COMPOUND_COLOR[c] ?? "#888" }} title={`${c} · ${s.stintLaps[i]} laps`}>
                {c?.slice(0, 3)}
              </span>
            ))}
          </span>
          <span className="muted small">{s.totalStops} stop{s.totalStops === 1 ? "" : "s"}</span>
        </div>
      ))}
    </div>
  </section>
);

// ---- Pit: stop-time + overtakes leaderboard ----
const PitTab = ({ strategies }: { strategies: ReturnType<typeof computeStrategies> }) => {
  const pitRows = strategies
    .filter((s) => s.avgStopTime != null)
    .sort((a, b) => (a.avgStopTime! - b.avgStopTime!));
  const overtakeRows = strategies
    .filter((s) => s.overtakesMade + s.overtakesLost > 0)
    .sort((a, b) => b.overtakesMade - a.overtakesMade);
  return (
    <div className="row">
      <section>
        <h4>Pit stop times (avg)</h4>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={pitRows.map((s) => ({ name: s.driver.driver_name, avg: s.avgStopTime! }))} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 10 }} />
            <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)}s` : "—")} />
            <Bar dataKey="avg" fill="#4a7dff" name="Avg stop (s)" />
          </BarChart>
        </ResponsiveContainer>
      </section>
      <section>
        <h4>Overtakes made</h4>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={overtakeRows.map((s) => ({ name: s.driver.driver_name, made: s.overtakesMade, lost: s.overtakesLost }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 10 }} />
            <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Bar dataKey="made" fill="#34c98e" name="Made" />
            <Bar dataKey="lost" fill="#e23b3b" name="Lost" />
          </BarChart>
        </ResponsiveContainer>
      </section>
    </div>
  );
};
