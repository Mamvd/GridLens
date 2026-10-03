import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  BarChart, Bar, CartesianGrid, ComposedChart, Area,
} from "recharts";
import {
  loadRaceBundle, computeStrategies, driverLapsForSectors, fmtLapTime,
  nameOfDriver, raceIsUnrun,
  type RaceBundle,
} from "../data/race";
import type { Meeting } from "../api/openf1";
import { seasonRaceSessions } from "../data/season";

import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartCard } from "@/components/charts/ChartCard";
import { chartTooltip } from "@/components/charts/ChartCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type Tab = "pace" | "gaps" | "strategy" | "pit";
const TABS: { id: Tab; label: string }[] = [
  { id: "pace", label: "Pace" },
  { id: "gaps", label: "Gaps" },
  { id: "strategy", label: "Strategy" },
  { id: "pit", label: "Pit" },
];


interface Props {
  meeting: Meeting;
}

export const Race = ({ meeting }: Props) => {
  const navigate = useNavigate();
  const { year = "", slug = "", tab = "pace" } = useParams();
  const [bundle, setBundle] = useState<RaceBundle | null>(null);
  const [error, setError] = useState("");
  const [refDriver, setRefDriver] = useState<number | null>(null);
  const [rivalDriver, setRivalDriver] = useState<number | null>(null);
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // find the race session for this meeting
  useEffect(() => {
    // future race: single-key session_result 404s with no CORS headers (opaque
    // "Failed to fetch") — prevent the request, never catch it.
    if (raceIsUnrun(meeting)) return;
    let alive = true;
    const controller = new AbortController();
    setError("");
    setBundle(null);
    setRefDriver(null);
    setRivalDriver(null);
    seasonRaceSessions(meeting.year)
      .then((sessionsRes) => {
        if (!alive) return;
        const race = sessionsRes.data.find((s) => s.meeting_key === meeting.meeting_key);
        if (!race) { setError("No race session found for this meeting."); return; }
        loadRaceBundle(race.session_key, meeting.year)
          .then((b) => {
            if (!alive) return;
            setBundle({ ...b, stale: b.stale || sessionsRes.stale });
            const sorted = [...b.results].filter((r) => r.driver_number).sort((a, b2) => (a.position ?? Infinity) - (b2.position ?? Infinity));
            if (sorted.length >= 2) {
              setRefDriver(sorted[0].driver_number);
              setRivalDriver(sorted[1].driver_number);
            }
          })
          .catch((e) => {
            if ((e as Error)?.name === "AbortError") return;
            if (alive) setError(String(e));
          });
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive) setError(String(e));
      });
    // ponytail: signal not threaded through seasonRaceSessions/loadRaceBundle
    // (data layer frozen) — alive guard prevents stale meeting state; abort
    // activates once those accept opts.
    return () => { alive = false; controller.abort(); };
  }, [meeting, reloadKey]);

  const strategies = useMemo(() => (bundle ? computeStrategies(bundle) : []), [bundle]);

  // render guard mirrors the effect guard above — no bundle fetch ever fires
  if (raceIsUnrun(meeting)) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {meeting.meeting_name} hasn&apos;t been run yet — no data available.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/season/${meeting.year}`)}
          >
            ← Season
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-destructive" title={error}>Failed to load {meeting.meeting_name}.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setError(""); setReloadKey((k) => k + 1); }}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  const chartHeight = width < 768 ? 260 : 320;

  if (!bundle) return (
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-9 w-full max-w-[360px]" />
          </CardContent>
        </Card>
        <ChartCard title="Loading…" height={chartHeight}>
          <div className="flex h-full items-center justify-center" />
        </ChartCard>
      </div>
    );

  return (
    <div className="race">
      {bundle.stale && (
        <div className="mb-4 rounded-md border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          Data may be out of date (latest revalidation failed).
        </div>
      )}
      <Card className="mb-6">
        <div className="flex flex-row items-start justify-between space-y-0 pb-4">
          <div className="space-y-1">
            <Button variant="outline" onClick={() => navigate(`/season/${meeting.year}`)}>← Season</Button>
            <h1 className="text-[17px] font-semibold tracking-tight">{meeting.meeting_name}</h1>
            <div className="text-muted-foreground text-sm">{meeting.circuit_short_name} · {meeting.date_start}</div>
          </div>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(val) => navigate(`/race/${year}/${slug}/${val}`)} className="w-full">
        <TabsList className="grid w-full grid-cols-4 bg-muted">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="flex-1 items-center justify-center px-2 h-10">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="pace">
          <PaceTab
            bundle={bundle}
            strategies={strategies}
            refDriver={refDriver}
            setRefDriver={setRefDriver}
            chartHeight={chartHeight}
          />
        </TabsContent>
        <TabsContent value="gaps">
          <GapsTab
            bundle={bundle}
            refDriver={refDriver}
            rivalDriver={rivalDriver}
            setRefDriver={setRefDriver}
            setRivalDriver={setRivalDriver}
            chartHeight={chartHeight}
          />
        </TabsContent>
        <TabsContent value="strategy">
          <StrategyTab strategies={strategies} />
        </TabsContent>
        <TabsContent value="pit">
          <PitTab strategies={strategies} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

// ---- Pace: sector trace for a driver ----
const PaceTab = ({ bundle, strategies, refDriver, setRefDriver, chartHeight }: {
  bundle: RaceBundle; strategies: ReturnType<typeof computeStrategies>;
  refDriver: number | null; setRefDriver: (n: number | null) => void;
  chartHeight: number;
}) => {
  const laps = refDriver != null ? driverLapsForSectors(bundle, refDriver) : [];
  const fastestLap = strategies.find((s) => s.driver.driver_number === refDriver)?.fastestLap ?? null;
  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between sm:space-x-4">
        <div className="space-y-1">
          <label className="text-muted-foreground text-sm">Driver</label>
          <Select
            value={refDriver != null ? String(refDriver) : undefined}
            onValueChange={(v) => setRefDriver(v ? +v : null)}
          >
            <SelectTrigger className="w-[200px] sm:w-auto">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {bundle.drivers.map((d) => (
                <SelectItem key={d.driver_number} value={String(d.driver_number)}>
                  {nameOfDriver(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {fastestLap != null && (
          <div className="text-muted-foreground text-sm self-end sm:self-start">
            · fastest lap {fmtLapTime(fastestLap)}
          </div>
        )}
      </div>
      <ChartCard title="Sector Times" height={chartHeight}>
        <ComposedChart data={laps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="lap_number" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
          <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" unit="s" domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={chartTooltip.contentStyle}
            labelStyle={chartTooltip.labelStyle}
            itemStyle={chartTooltip.itemStyle}
            cursor={chartTooltip.cursor}
            formatter={(v) => (typeof v === "number" ? `${v.toFixed(3)}s` : "—")}
          />
          <Area dataKey="total" name="Lap" fill="var(--chart-4)33" stroke="var(--chart-4)" />
          <Line dataKey="s1" name="Sector 1" dot={false} strokeWidth={1.5} stroke="var(--chart-5)" />
          <Line dataKey="s2" name="Sector 2" dot={false} strokeWidth={1.5} stroke="var(--chart-2)" />
          <Line dataKey="s3" name="Sector 3" dot={false} strokeWidth={1.5} stroke="var(--chart-1)" />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </ComposedChart>
      </ChartCard>
    </section>
  );
};

// ---- Gaps: interval trace for a driver (gap to car ahead) ----
type GapPoint = { ms: number; t: string; gap: number | null; rivalGap: number | null };

const GapsTab = ({ bundle, refDriver, rivalDriver, setRefDriver, setRivalDriver, chartHeight }: {
  bundle: RaceBundle; refDriver: number | null; rivalDriver: number | null;
  setRefDriver: (n: number | null) => void; setRivalDriver: (n: number | null) => void;
  chartHeight: number;
}) => {
  const series = useMemo(() => {
    if (refDriver == null) return [];
    const raw = bundle.intervals
      .filter((i) => i.driver_number === refDriver && i.interval != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((i) => ({
      ms: new Date(i.date).getTime(),
      t: new Date(i.date).toLocaleTimeString([], { hour12: false }),
      gap: i.interval!,
    }));
  }, [bundle, refDriver]);

  // Rival series — same downsample stride; empty when unselected or identical
  // to refDriver (stale state → render one line, not a duplicate).
  const rivalSeries = useMemo(() => {
    if (rivalDriver == null || rivalDriver === refDriver) return [];
    const raw = bundle.intervals
      .filter((i) => i.driver_number === rivalDriver && i.interval != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((i) => ({
      ms: new Date(i.date).getTime(),
      t: new Date(i.date).toLocaleTimeString([], { hour12: false }),
      gap: i.interval!,
    }));
  }, [bundle, rivalDriver, refDriver]);

  // Union both spines by timestamp; missing side = null (Recharts skips nulls).
  const chartData = useMemo<GapPoint[]>(() => {
    if (rivalSeries.length === 0) {
      return series.map((p) => ({ ms: p.ms, t: p.t, gap: p.gap, rivalGap: null }));
    }
    const byMs = new Map<number, GapPoint>();
    for (const p of series) byMs.set(p.ms, { ms: p.ms, t: p.t, gap: p.gap, rivalGap: null });
    for (const p of rivalSeries) {
      const e = byMs.get(p.ms);
      if (e) e.rivalGap = p.gap;
      else byMs.set(p.ms, { ms: p.ms, t: p.t, gap: null, rivalGap: p.gap });
    }
    return [...byMs.values()].sort((a, b) => a.ms - b.ms);
  }, [series, rivalSeries]);

  const refRow = bundle.drivers.find((d) => d.driver_number === refDriver);
  const rivalRow = bundle.drivers.find((d) => d.driver_number === rivalDriver);
  const refName = refRow ? nameOfDriver(refRow) : "—";
  const rivalName = rivalRow ? nameOfDriver(rivalRow) : "—";
  const showRival = rivalSeries.length > 0 && rivalDriver !== refDriver;
  const rivalMissing = rivalDriver != null && rivalDriver !== refDriver && rivalSeries.length === 0;

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="space-y-1">
          <label className="text-muted-foreground text-sm">Driver</label>
          <Select
            value={refDriver != null ? String(refDriver) : undefined}
            onValueChange={(v) => setRefDriver(v ? +v : null)}
          >
            <SelectTrigger className="w-[200px] sm:w-auto">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {bundle.drivers.map((d) => (
                <SelectItem key={d.driver_number} value={String(d.driver_number)}>
                  {nameOfDriver(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-muted-foreground text-sm">Compare driver</label>
          <Select
            value={rivalDriver != null ? String(rivalDriver) : undefined}
            onValueChange={(v) => setRivalDriver(v ? +v : null)}
          >
            <SelectTrigger className="w-[200px] sm:w-auto">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {/* exclude the ref driver — identical selection is meaningless */}
              {bundle.drivers
                .filter((d) => d.driver_number !== refDriver)
                .map((d) => (
                  <SelectItem key={d.driver_number} value={String(d.driver_number)}>
                    {nameOfDriver(d)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="muted small">Gap to the car ahead (intervals). Negative = behind / being lapped.</p>
      <ChartCard title="Gap to Car Ahead" height={chartHeight}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" minTickGap={60} />
          <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
          <Tooltip
            contentStyle={chartTooltip.contentStyle}
            labelStyle={chartTooltip.labelStyle}
            itemStyle={chartTooltip.itemStyle}
            cursor={chartTooltip.cursor}
            // ponytail: interval is seconds (not ms) — keep fmtLapTime for m:ss, sign prefix for lapped gaps.
            formatter={(v) => (typeof v === "number" ? (v < 0 ? `-${fmtLapTime(-v)}` : fmtLapTime(v)) : "—")}
          />
          <Line dataKey="gap" name={refName} dot={false} strokeWidth={2} stroke="var(--chart-4)" />
          {showRival && (
            <Line dataKey="rivalGap" name={rivalName} dot={false} strokeWidth={1.5} stroke="var(--chart-1)" />
          )}
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </LineChart>
      </ChartCard>
      {rivalMissing && (
        <p className="text-muted-foreground text-sm">No interval data for {rivalName}</p>
      )}
    </section>
  );
};

// ---- Strategy: compound sequence + stops per driver ----
const StrategyTab = ({ strategies }: { strategies: ReturnType<typeof computeStrategies> }) => {
  if (!strategies || strategies.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Driver Strategies</CardTitle>
        </CardHeader>
        <CardContent className="h-[320px] flex items-center justify-center">
          <Skeleton className="w-full h-4" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="mb-4">
        <CardTitle className="text-sm font-semibold">Driver Strategies</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {strategies.map((s) => (
            <div key={s.driver.driver_number} className="flex items-center gap-4 px-3 py-2 border-b border-muted/50 last:border-b-0">
              <span className="min-w-[40px] text-muted-foreground text-sm">{s.finishPosition ?? "—"}</span>
              <span className="flex-1 text-muted-foreground text-sm">{nameOfDriver(s.driver)}</span>
              <span className="flex-shrink-0 space-x-2">
                {s.compounds.map((c, i) => {
                  const compoundName = c;
                  const bgColor = c === "SOFT" ? "var(--chart-1)" : c === "MEDIUM" ? "var(--chart-2)" : c === "HARD" ? "var(--chart-3)" : "var(--muted)";
                  const textColor = c === "MEDIUM" ? "var(--foreground)" : "var(--card-foreground)";
                  return (
                    <span
                      key={i}
                      className="px-2 py-0.5 rounded text-xs font-medium"
                      style={{
                        backgroundColor: bgColor,
                        color: textColor,
                      }}
                      title={`${compoundName} · ${s.stintLaps[i]} laps`}
                    >
                      {compoundName}
                    </span>
                  );
                })}
              </span>
              <span className="min-w-[60px] text-muted-foreground text-sm">
                {s.totalStops} stop{s.totalStops === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

// ---- Pit: stop-time + overtakes leaderboard ----
const PitTab = ({ strategies }: { strategies: ReturnType<typeof computeStrategies> }) => {
  if (!strategies || strategies.length === 0) {
    return (
      <Card className="w-full">
        <CardContent className="grid grid-cols-2 gap-4">
          <Skeleton className="h-[260px]" />
          <Skeleton className="h-[260px]" />
        </CardContent>
      </Card>
    );
  }

  const pitRows = strategies
    .filter((s) => s.avgStopTime != null)
    .sort((a, b) => (a.avgStopTime! - b.avgStopTime!));
  const overtakeRows = strategies
    .filter((s) => s.overtakesMade + s.overtakesLost > 0)
    .sort((a, b) => b.overtakesMade - a.overtakesMade);

  return (
    <Card className="w-full">
      <CardContent className="grid grid-cols-2 gap-4">
        <section>
          <ChartCard title="Pit Stop Times (avg)" height={260}>
            <BarChart data={pitRows.map((s) => ({ name: nameOfDriver(s.driver), avg: s.avgStopTime! }))} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <Tooltip
                contentStyle={chartTooltip.contentStyle}
                labelStyle={chartTooltip.labelStyle}
                itemStyle={chartTooltip.itemStyle}
                cursor={chartTooltip.cursor}
                formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)}s` : "—")}
              />
              <Bar dataKey="avg" fill="var(--chart-4)" name="Avg stop (s)" />
            </BarChart>
          </ChartCard>
        </section>
        <section>
          <ChartCard title="Overtakes Made" height={260}>
            <BarChart data={overtakeRows.map((s) => ({ name: nameOfDriver(s.driver), made: s.overtakesMade, lost: s.overtakesLost }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <Tooltip
                contentStyle={chartTooltip.contentStyle}
                labelStyle={chartTooltip.labelStyle}
                itemStyle={chartTooltip.itemStyle}
                cursor={chartTooltip.cursor}
              />
              <Bar dataKey="made" fill="var(--chart-5)" name="Made" />
              <Bar dataKey="lost" fill="var(--chart-1)" name="Lost" />
            </BarChart>
          </ChartCard>
        </section>
      </CardContent>
    </Card>
  );
};
