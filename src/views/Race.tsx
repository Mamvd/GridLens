import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  BarChart, Bar, CartesianGrid, ComposedChart, Area,
} from "recharts";
import {
  computeStrategies, driverLapsForSectors, fmtLapTime,
  nameOfDriver, raceIsUnrun, parseInterval, fmtInterval,
  loadRaceBase, loadLaps, loadIntervals, loadStints, loadPit, loadOvertakes, loadGrid,
  missingResources, TAB_RESOURCES, DETAIL_RESOURCES, detailFields,
  type RaceBundle, type RaceResKey, type DetailPhase,
} from "../data/race";
import type {
  Meeting, Driver, Lap, Interval, Stint, PitEvent, SessionResult, Overtake, StartingGrid,
} from "../api/openf1";
import { seasonRaceSessions } from "../data/season";
import { formatRaceDateRange } from "../lib/dates";
import { resourcePhase } from "../lib/resource-state";

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

// per-resource slices — each tab's data loads, fails and retries on its own
type Slice = { data?: unknown; loading: boolean; error?: string; stale?: boolean };
type ResState = Record<RaceResKey, Slice>;
const emptyRes = (): ResState => ({
  drivers: { loading: false },
  results: { loading: false },
  laps: { loading: false },
  intervals: { loading: false },
  stints: { loading: false },
  pit: { loading: false },
  overtakes: { loading: false },
  grid: { loading: false },
});

const LoadSkeleton = ({ chartHeight }: { chartHeight: number }) => (
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

const RES_LABEL: Partial<Record<RaceResKey, string>> = {
  laps: "lap timing",
  intervals: "gap intervals",
  stints: "tyre stints",
  pit: "pit stops",
  overtakes: "overtakes",
  grid: "starting grid",
};

// per-tab gate: ONLY this tab's resources decide loading/error — a failed
// slice never blocks the other tabs. rowCount = this tab's derived rows once
// its resources finish: 0 rows renders emptyMessage, never a skeleton.
const TabGate = ({ tab, res, chartHeight, onRetry, rowCount, emptyMessage, children }: {
  tab: Tab; res: ResState; chartHeight: number;
  onRetry: (keys: RaceResKey[]) => void;
  rowCount: number; emptyMessage: string;
  children: ReactNode;
}) => {
  const needs = TAB_RESOURCES[tab];
  const phase = resourcePhase(needs.map((k) => res[k]), rowCount);
  if (phase === "error") {
    const failed = needs.filter((k) => res[k].error);
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-destructive" title={failed.map((k) => String(res[k].error)).join("; ")}>
            Failed to load {failed.map((k) => RES_LABEL[k] ?? k).join(", ")}.
          </p>
          <Button variant="outline" size="sm" onClick={() => onRetry(failed)}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (phase === "loading") return <LoadSkeleton chartHeight={chartHeight} />;
  if (phase === "empty") {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
};

interface Props {
  meeting: Meeting;
}

export const Race = ({ meeting }: Props) => {
  const navigate = useNavigate();
  const { year = "", slug = "", tab: tabParam = "pace" } = useParams();
  const tab = tabParam as Tab; // App RaceRoute validated it ∈ TABS
  const [res, setRes] = useState<ResState>(emptyRes);
  const [sess, setSess] = useState<{ sk: number; meetingKey: number; gmtOffset?: string } | null>(null);
  const [error, setError] = useState("");
  const [sessionsStale, setSessionsStale] = useState(false);
  const [refDriver, setRefDriver] = useState<number | null>(null);
  const [rivalDriver, setRivalDriver] = useState<number | null>(null);
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 0);
  const [reloadKey, setReloadKey] = useState(0);
  // gen guards slice writes: a newer meeting/reload invalidates older responses
  const genRef = useRef(0);
  // Radix Tabs fires onValueChange twice per trigger interaction (both fires
  // close over the pre-navigation render, so a URL-tab compare can't catch
  // the second one) — a 100 ms window dedupes the pair into one history entry.
  const lastTabNavRef = useRef<{ to: string; at: number }>({ to: "", at: 0 });
  const inflight = useRef<Set<string>>(new Set());
  const resRef = useRef(res);

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // keep the skip-if-loaded snapshot current (read by startLoad via ref)
  useEffect(() => { resRef.current = res; }, [res]);

  const startLoad = useCallback((gen: number, sk: number, key: RaceResKey | "base") => {
    const patch = (k: RaceResKey, next: Partial<Slice>) =>
      setRes((r) => ({ ...r, [k]: { ...r[k], ...next } }));
    if (inflight.current.has(key)) return;
    if (key !== "base" && resRef.current[key].data !== undefined) return; // loaded → revisit costs nothing
    inflight.current.add(key);
    const done = () => { if (gen === genRef.current) inflight.current.delete(key); };

    if (key === "base") {
      patch("drivers", { loading: true, error: undefined });
      patch("results", { loading: true, error: undefined });
      loadRaceBase(sk, meeting.year).then(
        (b) => {
          if (gen !== genRef.current) return;
          patch("drivers", { data: b.drivers, loading: false, stale: b.stale });
          patch("results", { data: b.results, loading: false, stale: b.stale });
          const sorted = [...b.results].filter((r) => r.driver_number)
            .sort((a, b2) => (a.position ?? Infinity) - (b2.position ?? Infinity));
          if (sorted.length >= 2) {
            setRefDriver(sorted[0].driver_number);
            setRivalDriver(sorted[1].driver_number);
          }
        },
        (e) => {
          if (gen !== genRef.current || (e as Error)?.name === "AbortError") return;
          patch("drivers", { loading: false, error: String(e) });
          patch("results", { loading: false, error: String(e) });
        },
      ).finally(done);
      return;
    }

    patch(key, { loading: true, error: undefined });
    const loader =
      key === "laps" ? loadLaps(sk, meeting.year) :
      key === "intervals" ? loadIntervals(sk, meeting.year) :
      key === "stints" ? loadStints(sk, meeting.year) :
      key === "pit" ? loadPit(sk, meeting.year) :
      key === "grid" ? loadGrid(sk, meeting.year) :
      loadOvertakes(sk, meeting.year);
    loader.then(
      (v) => {
        if (gen !== genRef.current) return;
        patch(key, { data: v.data, loading: false, stale: v.stale });
      },
      (e) => {
        if (gen !== genRef.current || (e as Error)?.name === "AbortError") return;
        patch(key, { loading: false, error: String(e) });
      },
    ).finally(done);
  }, [meeting]);

  // resolve the meeting's race session + always-on base; full reset on
  // meeting change / reloadKey retry.
  useEffect(() => {
    // future race: single-key session_result 404s with no CORS headers (opaque
    // "Failed to fetch") — prevent the request, never catch it.
    if (raceIsUnrun(meeting)) return;
    const gen = ++genRef.current;
    inflight.current.clear();
    setRes(emptyRes());
    setSess(null);
    setError("");
    setSessionsStale(false);
    setRefDriver(null);
    setRivalDriver(null);
    let alive = true;
    const controller = new AbortController();
    seasonRaceSessions(meeting.year)
      .then((sessionsRes) => {
        if (!alive || gen !== genRef.current) return;
        const race = sessionsRes.data.find((s) => s.meeting_key === meeting.meeting_key);
        if (!race) { setError("No race session found for this meeting."); return; }
        setSess({ sk: race.session_key, meetingKey: meeting.meeting_key, gmtOffset: race.gmt_offset });
        setSessionsStale(sessionsRes.stale);
        startLoad(gen, race.session_key, "base");
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive && gen === genRef.current) setError(String(e));
      });
    // ponytail: signal not threaded through seasonRaceSessions/loadRaceBase
    // (data layer frozen) — gen + alive guard stale meeting state; abort
    // activates once those accept opts.
    return () => { alive = false; controller.abort(); };
  }, [meeting, reloadKey, startLoad]);

  // tab change (URL-driven): fetch this tab's resources minus already-loaded
  // ones — never touches the base.
  useEffect(() => {
    if (raceIsUnrun(meeting) || !sess || sess.meetingKey !== meeting.meeting_key) return;
    const gen = genRef.current;
    for (const key of missingResources(tab, (k) => resRef.current[k].data !== undefined)) {
      startLoad(gen, sess.sk, key);
    }
  }, [tab, sess, meeting, startLoad]);

  const bundle = useMemo<RaceBundle | null>(() => {
    if (!sess || sess.meetingKey !== meeting.meeting_key) return null;
    const driversRaw = res.drivers.data;
    const resultsRaw = res.results.data;
    if (driversRaw === undefined || resultsRaw === undefined) return null;
    const drivers = driversRaw as Driver[];
    const results = resultsRaw as SessionResult[];
    return {
      sessionKey: sess.sk,
      drivers,
      results,
      laps: (res.laps.data as Lap[] | undefined) ?? [],
      intervals: (res.intervals.data as Interval[] | undefined) ?? [],
      stints: (res.stints.data as Stint[] | undefined) ?? [],
      pitEvents: (res.pit.data as PitEvent[] | undefined) ?? [],
      overtakes: (res.overtakes.data as Overtake[] | undefined) ?? [],
      grid: (res.grid.data as StartingGrid[] | undefined) ?? [],
      numberToDriver: new Map(drivers.map((d) => [d.driver_number, d])),
      stale: sessionsStale || Object.values(res).some((s) => s.stale === true),
    };
  }, [sess, meeting, res, sessionsStale]);

  const strategies = useMemo(() => (bundle ? computeStrategies(bundle) : []), [bundle]);

  const retryKeys = (keys: RaceResKey[]) => {
    if (!sess) return;
    for (const k of keys) startLoad(genRef.current, sess.sk, k);
  };

  // detail card on expand: ask for every detail resource — startLoad skips
  // loaded + in-flight keys, so repeat expands cost 0 requests
  const ensureDetail = () => {
    if (!sess) return;
    const gen = genRef.current;
    for (const key of DETAIL_RESOURCES) startLoad(gen, sess.sk, key);
  };

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

  const baseError = res.drivers.error ?? res.results.error;
  const fullError = error || (baseError ? String(baseError) : "");
  if (fullError) {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-destructive" title={fullError}>Failed to load {meeting.meeting_name}.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (error) { setError(""); setReloadKey((k) => k + 1); }
              else if (sess) startLoad(genRef.current, sess.sk, "base");
            }}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  const chartHeight = width < 768 ? 260 : 320;

  if (!bundle) return <LoadSkeleton chartHeight={chartHeight} />;

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
            <h2 className="text-[17px] font-semibold tracking-tight">{meeting.meeting_name}</h2>
            <div className="text-muted-foreground text-sm">
              {meeting.circuit_short_name} · {formatRaceDateRange(meeting.date_start, meeting.date_end, meeting.gmt_offset ?? sess?.gmtOffset)}
            </div>
          </div>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(val) => {
        const to = `/race/${year}/${slug}/${val}`;
        // two-fire dedupe: same target within 100 ms = the second Radix fire
        const now = Date.now();
        if (lastTabNavRef.current.to === to && now - lastTabNavRef.current.at < 100) return;
        lastTabNavRef.current = { to, at: now };
        navigate(to);
      }} className="w-full">
        <TabsList className="grid w-full grid-cols-4 bg-muted">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="flex-1 items-center justify-center px-2 h-10">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="pace">
          <TabGate
            tab="pace" res={res} chartHeight={chartHeight} onRetry={retryKeys}
            rowCount={bundle.laps.length} emptyMessage="No lap data available for this race."
          >
            <PaceTab
              bundle={bundle}
              strategies={strategies}
              refDriver={refDriver}
              setRefDriver={setRefDriver}
              chartHeight={chartHeight}
            />
          </TabGate>
        </TabsContent>
        <TabsContent value="gaps">
          <TabGate
            tab="gaps" res={res} chartHeight={chartHeight} onRetry={retryKeys}
            rowCount={bundle.intervals.length} emptyMessage="No gap data available for this race."
          >
            <GapsTab
              bundle={bundle}
              refDriver={refDriver}
              rivalDriver={rivalDriver}
              setRefDriver={setRefDriver}
              setRivalDriver={setRivalDriver}
              chartHeight={chartHeight}
            />
          </TabGate>
        </TabsContent>
        <TabsContent value="strategy">
          <TabGate
            tab="strategy" res={res} chartHeight={chartHeight} onRetry={retryKeys}
            rowCount={strategies.length} emptyMessage="No strategy data available for this race."
          >
            <StrategyTab strategies={strategies} res={res} onExpand={ensureDetail} />
          </TabGate>
        </TabsContent>
        <TabsContent value="pit">
          <TabGate
            tab="pit" res={res} chartHeight={chartHeight} onRetry={retryKeys}
            rowCount={strategies.length} emptyMessage="No pit stop data available for this race."
          >
            <PitTab strategies={strategies} />
          </TabGate>
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
          {bundle.drivers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No driver data yet.</p>
          ) : (
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
          )}
        </div>
        {fastestLap != null && (
          <div className="text-muted-foreground text-sm self-end sm:self-start">
            · fastest lap {fmtLapTime(fastestLap)}
          </div>
        )}
      </div>
      <ChartCard
        title="Sector Times"
        height={chartHeight}
        srSummary="Area chart of total lap time with line series for sector 1, sector 2 and sector 3 times on each lap."
      >
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
// gap is numeric seconds for "time" intervals only — lapped/leader → null so
// Recharts breaks the line instead of plotting a fabricated axis number.
type GapPoint = {
  ms: number; t: string;
  gap: number | null; gapLabel: string;
  rivalGap: number | null; rivalGapLabel: string;
};

const GapsTab = ({ bundle, refDriver, rivalDriver, setRefDriver, setRivalDriver, chartHeight }: {
  bundle: RaceBundle; refDriver: number | null; rivalDriver: number | null;
  setRefDriver: (n: number | null) => void; setRivalDriver: (n: number | null) => void;
  chartHeight: number;
}) => {
  const series = useMemo(() => {
    if (refDriver == null) return [];
    const raw = bundle.intervals
      .filter((i) => i.driver_number === refDriver)
      .map((i) => ({ date: i.date, v: parseInterval(i.interval) }))
      // drop only "none" — lapped/leader stay in the spine as line gaps
      .filter((x) => x.v.type !== "none")
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((x) => ({
      ms: new Date(x.date).getTime(),
      t: new Date(x.date).toLocaleTimeString([], { hour12: false }),
      gap: x.v.type === "time" ? x.v.seconds : null, // lapped/leader → null → line gap
      gapLabel: fmtInterval(x.v),
    }));
  }, [bundle, refDriver]);

  // Rival series — same downsample stride; empty when unselected or identical
  // to refDriver (stale state → render one line, not a duplicate).
  const rivalSeries = useMemo(() => {
    if (rivalDriver == null || rivalDriver === refDriver) return [];
    const raw = bundle.intervals
      .filter((i) => i.driver_number === rivalDriver)
      .map((i) => ({ date: i.date, v: parseInterval(i.interval) }))
      .filter((x) => x.v.type !== "none")
      .sort((a, b) => a.date.localeCompare(b.date));
    const step = Math.max(1, Math.ceil(raw.length / 150));
    return raw.filter((_, i) => i % step === 0).map((x) => ({
      ms: new Date(x.date).getTime(),
      t: new Date(x.date).toLocaleTimeString([], { hour12: false }),
      gap: x.v.type === "time" ? x.v.seconds : null,
      gapLabel: fmtInterval(x.v),
    }));
  }, [bundle, rivalDriver, refDriver]);

  // lapped intervals on the FULL spine (before downsample) — powers the note
  // below the chart so +N LAP values are stated even when stride drops points.
  const lapped = useMemo(() => {
    if (refDriver == null) return { count: 0, labels: [] as string[] };
    const vals = bundle.intervals
      .filter((i) => i.driver_number === refDriver)
      .map((i) => parseInterval(i.interval))
      .filter((v) => v.type === "lapped");
    return { count: vals.length, labels: [...new Set(vals.map(fmtInterval))] };
  }, [bundle, refDriver]);

  // Union both spines by timestamp; missing side = null (Recharts skips nulls).
  const chartData = useMemo<GapPoint[]>(() => {
    if (rivalSeries.length === 0) {
      return series.map((p) => ({ ...p, rivalGap: null, rivalGapLabel: "" }));
    }
    const byMs = new Map<number, GapPoint>();
    for (const p of series) byMs.set(p.ms, { ...p, rivalGap: null, rivalGapLabel: "" });
    for (const p of rivalSeries) {
      const e = byMs.get(p.ms);
      if (e) { e.rivalGap = p.gap; e.rivalGapLabel = p.gapLabel; }
      else byMs.set(p.ms, { ms: p.ms, t: p.t, gap: null, gapLabel: "", rivalGap: p.gap, rivalGapLabel: p.gapLabel });
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
      {bundle.drivers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No driver data yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
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
      )}
      <p className="muted small">Gap to the car ahead (intervals). Negative = behind / being lapped.</p>
      <ChartCard
        title="Gap to Car Ahead"
        height={chartHeight}
        srSummary="Line chart of the time gap to the car ahead on each lap, with an optional second line for a comparison driver."
      >
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" minTickGap={60} />
          <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
          <Tooltip
            contentStyle={chartTooltip.contentStyle}
            labelStyle={chartTooltip.labelStyle}
            itemStyle={chartTooltip.itemStyle}
            cursor={chartTooltip.cursor}
            // numeric = time-interval seconds (not ms); lapped/leader are null → "—".
            // ponytail: keep fmtLapTime for m:ss, sign prefix for negative gaps.
            formatter={(v) => (typeof v === "number" ? (v < 0 ? `-${fmtLapTime(-v)}` : fmtLapTime(v)) : "—")}
          />
          <Line dataKey="gap" name={refName} dot={false} strokeWidth={2} stroke="var(--chart-4)" />
          {showRival && (
            <Line dataKey="rivalGap" name={rivalName} dot={false} strokeWidth={1.5} stroke="var(--chart-1)" />
          )}
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </LineChart>
      </ChartCard>
      <p className="text-muted-foreground text-xs">
        ◦ Line gaps mark lapped or no-gap intervals
        {lapped.count > 0 &&
          ` — Lapped sections shown as gaps: ${lapped.count} interval${lapped.count === 1 ? "" : "s"} ${lapped.count === 1 ? "was" : "were"} ${lapped.labels.join(" / ")}`}
      </p>
      {rivalMissing && (
        <p className="text-muted-foreground text-sm">No interval data for {rivalName}</p>
      )}
    </section>
  );
};

// ---- Strategy: compound sequence + stops per driver ----
// empty (0 strategies) never reaches here: TabGate renders the empty message.
// Row = <button> (Tab/Enter/Space expand). Detail loads laps/pit/overtakes/grid
// on demand via onExpand → startLoad (cache-deduped, gen-guarded).
const StrategyTab = ({ strategies, res, onExpand }: {
  strategies: ReturnType<typeof computeStrategies>;
  res: ResState;
  onExpand: () => void;
}) => {
  const [openDriver, setOpenDriver] = useState<number | null>(null);
  const phase = (k: RaceResKey): DetailPhase => {
    const s = res[k];
    if (s.data !== undefined) return "ready";
    // ponytail: detail-load failure folds into "ready" → field shows "—";
    // upgrade path: per-field retry once error states get a UI here.
    if (s.error) return "ready";
    return "pending";
  };
  const detailPhases = {
    laps: phase("laps"), pit: phase("pit"),
    overtakes: phase("overtakes"), grid: phase("grid"),
  };
  const anyPending = Object.values(detailPhases).some((p) => p === "pending");

  return (
    <Card className="w-full">
      <CardHeader className="mb-4">
        <CardTitle className="text-sm font-semibold">Driver Strategies</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {strategies.map((s) => {
            const isOpen = openDriver === s.driver.driver_number;
            const d = detailFields(s, detailPhases);
            const fld = (f: { pending: boolean; text: string }) =>
              f.pending
                ? <Skeleton className="inline-block h-3.5 w-14 align-middle" aria-hidden="true" />
                : f.text;
            return (
              <div key={s.driver.driver_number} className="border-b border-muted/50 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => {
                    if (isOpen) { setOpenDriver(null); return; }
                    setOpenDriver(s.driver.driver_number);
                    onExpand();
                  }}
                  className="flex w-full flex-col gap-1.5 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-4 sm:py-2"
                >
                  {/* narrow: pos+name on line 1; ≥sm: contents → flat single row */}
                  <div className="flex items-center gap-4 sm:contents">
                    <span className="min-w-[40px] text-muted-foreground text-sm">{s.finishPosition ?? "—"}</span>
                    <span className="flex-1 text-muted-foreground text-sm">{nameOfDriver(s.driver)}</span>
                  </div>
                  {/* always wrappable: a 5-stint chain never forces page scroll;
                      arrow rides with the chip it introduces (no orphan/trailing →) */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {s.compounds.map((c, i) => {
                      const bgColor = c === "SOFT" ? "var(--chart-1)" : c === "MEDIUM" ? "var(--chart-2)" : c === "HARD" ? "var(--chart-3)" : "var(--muted)";
                      const textColor = c === "MEDIUM" ? "var(--foreground)" : "var(--card-foreground)";
                      return (
                        <span key={i} className="inline-flex items-center gap-1.5 text-xs">
                          {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
                          <span
                            className="px-2 py-0.5 rounded font-medium"
                            style={{
                              backgroundColor: bgColor,
                              color: textColor,
                            }}
                            title={`${c} · ${s.stintLaps[i]} laps`}
                          >
                            {c} {s.stintLaps[i]}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                  <span className="min-w-[60px] text-muted-foreground text-sm">
                    {s.totalStops} stop{s.totalStops === 1 ? "" : "s"}
                  </span>
                </button>
                {isOpen && (
                  <div className="space-y-1 border-t border-muted/40 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                    {anyPending && (
                      <p className="flex items-center gap-2 text-xs">
                        <Skeleton className="h-3 w-14" />
                        loading details…
                      </p>
                    )}
                    <p>{d.place}</p>
                    <p>{fld(d.grid)} → {d.finish}</p>
                    <p>{fld(d.fastestLap)} · {fld(d.bestSector)}</p>
                    <p>{d.stops} {fld(d.avgStop)} · {fld(d.overtakes)}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

// ---- Pit: stop-time + overtakes leaderboard ----
// empty (0 strategies) never reaches here: TabGate renders the empty message.
const PitTab = ({ strategies }: { strategies: ReturnType<typeof computeStrategies> }) => {
  const pitRows = strategies
    .filter((s) => s.avgStopTime != null)
    .sort((a, b) => (a.avgStopTime! - b.avgStopTime!));
  const overtakeRows = strategies
    .filter((s) => s.overtakesMade + s.overtakesLost > 0)
    .sort((a, b) => b.overtakesMade - a.overtakesMade);

  return (
    <Card className="w-full">
      <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section>
          <ChartCard
            title="Pit Stop Times (avg)"
            height={260}
            srSummary="Horizontal bar chart of each driver's average pit stop time in seconds."
          >
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
          <ChartCard
            title="Overtakes Made"
            height={260}
            srSummary="Bar chart comparing overtakes made and overtakes lost for each driver."
          >
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
