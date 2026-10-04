import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  BarChart, Bar,
} from "recharts";
import {
  seasonCore, seasonExtras, type SeasonCore, type SeasonExtras,
} from "../data/season";
import { raceIsUnrun } from "../data/race";
import type { Meeting } from "../api/openf1";
import { slugForMeeting } from "../lib/slug";
import { resourcePhase } from "../lib/resource-state";
import {
  chartSelect, teammateDashed, fallbackPalette, ensureVisible,
  resolveTeamColours, FALLBACK_HUES, type ChartRange, champTipRows,
  SEARCH_DEBOUNCE_MS,
} from "../lib/chart-select";
import { ChartCard, ChartTooltip, buildSrTable } from "@/components/charts/ChartCard";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

interface Props {
  year: number;
  meetings: Meeting[];
  // #9: meetings list came from stale cache after an API failure — show the
  // out-of-date note alongside the stages' own stale flags.
  meetingsStale?: boolean;
}

const SECTION = "mb-3 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground";
const MEETING_GRID = "grid grid-cols-1 gap-2 md:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]";
const AXIS = { stroke: "var(--border)" };
const TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
const GRID_PROPS = { stroke: "var(--border)", strokeDasharray: "3 3" };

const fmtNum = (v: unknown) => {
  if (v == null) return "—";
  return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
};

// "Bahrain Grand Prix" → "Bahrain" for axis density.
const raceTick = (v: string) => v.replace(/\s+Grand Prix$/i, "");

// tooltip: meeting header + one row per series (driver · pts). Recharts'
// payload carries EVERY series at the hovered index — all are rendered
// (UX-01), the hovered line's row first; colour appears only as a swatch
// dot (text stays tokens, per dataviz rules).
const champTip = (
  props: {
    active: boolean;
    label?: string | number;
    payload: ReadonlyArray<{
      name?: string | number;
      value?: number | string | ReadonlyArray<number | string>;
      color?: string;
      payload?: unknown;
    }>;
  },
  hovered: string | null,
) => {
  if (!props.active || !props.payload.length) return null;
  const rows = champTipRows(props.payload);
  const lead = hovered != null ? rows.findIndex((r) => r.name === hovered) : -1;
  if (lead > 0) rows.unshift(...rows.splice(lead, 1));
  const race = raceTick(String(rows[0]?.race || props.label || ""));
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md">
      <div className="mb-1 font-semibold text-muted-foreground">{race}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: r.color ?? "var(--border)" }}
          />
          <span>{r.name}</span>
          <span className="text-muted-foreground">· {fmtNum(r.value)} pts</span>
        </div>
      ))}
    </div>
  );
};

const ChartSkeleton = ({ className }: { className?: string }) => (
  <Card className={className}>
    <CardHeader className="pb-2">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-56" />
    </CardHeader>
    <CardContent>
      <Skeleton className="h-[320px] w-full" />
    </CardContent>
  </Card>
);

// stage lifecycle: year-tagged state + derived status (year mismatch from a
// slow old-year stage reads as loading — never renders under a new year)
type Stage<T> = { year: number; data: T | null; stale: boolean; error: string };
type StageStatus = "ready" | "loading" | "failed";
const stageStatus = <T,>(s: Stage<T>, year: number): StageStatus =>
  s.year !== year || (!s.data && !s.error) ? "loading" : s.error ? "failed" : "ready";

const CachedNote = () => (
  <p className="mb-2 text-[11px] text-muted-foreground">based on cached data</p>
);

const StageError = ({ message, error, onRetry }: { message: string; error: string; onRetry: () => void }) => (
  <Card className="border-destructive/50 bg-destructive/10">
    <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-[13px] text-destructive" title={error}>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </CardContent>
  </Card>
);

// one section slot bound to one stage: failed → its error card, loading →
// skeleton, ready with 0 rows → emptyMessage (stale note still shows),
// ready with rows → cached note (when stale) + content. Phases from
// resourcePhase so finished-but-empty never sits as a skeleton.
const StageSlot = ({
  status, error, stale, message, onRetry, skeleton, rowCount, emptyMessage, children,
}: {
  status: StageStatus;
  error: string;
  stale: boolean;
  message: string;
  onRetry: () => void;
  skeleton: ReactNode;
  rowCount?: number;
  emptyMessage?: string;
  children: ReactNode;
}) => {
  const phase = resourcePhase(
    [{
      loading: status === "loading",
      error: status === "failed" ? error : undefined,
      data: status === "ready" ? children : undefined,
    }],
    rowCount ?? 1, // no emptyMessage → "empty" unreachable
  );
  if (phase === "error") return <StageError message={message} error={error} onRetry={onRetry} />;
  if (phase === "loading") return <>{skeleton}</>;
  if (phase === "empty") {
    return (
      <>
        {stale && <CachedNote />}
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </>
    );
  }
  return (
    <>
      {stale && <CachedNote />}
      {children}
    </>
  );
};

const stepLabel = (s: StageStatus) => (s === "ready" ? "✓" : s === "failed" ? "failed" : "loading…");

export const Season = ({ year, meetings, meetingsStale }: Props) => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // UX-02: derive initial state from URL params once; invalid values fall
  // back to defaults (range ∉ {top5,top10,all} → top10, missing q → "").
  const [chartRange, setChartRange] = useState<ChartRange>(() => {
    const r = searchParams.get("range");
    return (r === "top5" || r === "top10" || r === "all") ? r as ChartRange : "top10";
  });
  const [chartSearch, setChartSearch] = useState(() => searchParams.get("q") ?? "");
  // PF-05: filter on a debounced copy — raw keystrokes re-render the whole
  // Season tree otherwise (chartSelect + LineChart visible-set rebuild per
  // key, 67–152 ms/frame). URL sync below rides the same debounced value,
  // so `q` is debounced before write without a second timer.
  const [appliedSearch, setAppliedSearch] = useState(chartSearch);
  useEffect(() => {
    const t = setTimeout(() => setAppliedSearch(chartSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [chartSearch]);

  const [core, setCore] = useState<Stage<SeasonCore>>({ year: -1, data: null, stale: false, error: "" });
  const [extras, setExtras] = useState<Stage<SeasonExtras>>({ year: -1, data: null, stale: false, error: "" });
  const [coreRetry, setCoreRetry] = useState(0);
  const [extrasRetry, setExtrasRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    seasonCore(year, meetings, { signal: controller.signal })
      .then((r) => {
        if (alive) setCore({ year, data: r, stale: r.stale, error: "" });
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive) setCore({ year, data: null, stale: false, error: String(e) });
      });
    return () => { alive = false; controller.abort(); };
  }, [year, meetings, coreRetry]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    seasonExtras(year, { signal: controller.signal })
      .then((r) => {
        if (alive) setExtras({ year, data: r, stale: r.stale, error: "" });
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive) setExtras({ year, data: null, stale: false, error: String(e) });
      });
    return () => { alive = false; controller.abort(); };
  }, [year, extrasRetry]);

  const coreStatus = stageStatus(core, year);
  const extrasStatus = stageStatus(extras, year);
  const coreData = core.year === year ? core.data : null;
  const extrasData = extras.year === year ? extras.data : null;
  const coreReady = coreStatus === "ready" && coreData != null;
  const coreStale = coreReady && core.stale;
  const extrasStale = extrasStatus === "ready" && extras.stale;

  const retryCore = () => {
    setCore((s) => ({ ...s, data: null, error: "" }));
    setCoreRetry((k) => k + 1);
  };
  const retryExtras = () => {
    setExtras((s) => ({ ...s, data: null, error: "" }));
    setExtrasRetry((k) => k + 1);
  };

  // cumulative points per driver across the season — full points order;
  // chart-select applies range/search/isolate on top (no points math change)
  const standingsSeries = useMemo(() => {
    if (!coreData) return { rows: [] as Record<string, number | string>[], names: [] as string[] };
    const perDriver = new Map<string, number>();
    const rows = coreData.progression.map((p) => {
      for (const dp of p.racePoints) {
        perDriver.set(dp.name, (perDriver.get(dp.name) ?? 0) + dp.points);
      }
      const row: Record<string, number | string> = { race: p.meetingName };
      for (const [name, pts] of perDriver) row[name] = pts;
      return row;
    });
    const names = [...perDriver.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return { rows, names };
  }, [coreData]);

  // #15 championship-chart interactions: hover dims, click isolates
  // (persists until re-click / Show all), legend buttons + search + ranges.
  const [hovered, setHovered] = useState<string | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);

  const teamByDriver = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of coreData?.championship ?? []) m.set(d.driverName, d.team);
    return m;
  }, [coreData]);
  const chartEntries = useMemo(
    () => standingsSeries.names.map((name) => ({ name, team: teamByDriver.get(name) ?? "Unknown" })),
    [standingsSeries.names, teamByDriver],
  );
  const palette = useMemo(() => fallbackPalette(chartEntries.map((e) => e.team)), [chartEntries]);
  const dashedSet = useMemo(() => teammateDashed(chartEntries), [chartEntries]);
  const teamHexes = useMemo(
    () => resolveTeamColours(chartEntries, coreData?.driverColours ?? {}),
    [chartEntries, coreData],
  );
  // API team_colour first (lifted to the dark-surface floor), else the
  // team's deterministic fallback hue — never a fabricated colour
  const colourOf = (name: string): string => {
    const team = teamByDriver.get(name) ?? "Unknown";
    return ensureVisible(teamHexes[team] ?? "") ?? palette[team] ?? FALLBACK_HUES[0];
  };

  // stale isolate (e.g. year switch) auto-clears; hidden = everyone else
  const isolate = isolated != null && standingsSeries.names.includes(isolated) ? isolated : null;
  const hidden = useMemo<ReadonlySet<string>>(
    () => (isolate ? new Set(standingsSeries.names.filter((n) => n !== isolate)) : new Set()),
    [isolate, standingsSeries.names],
  );
  const sel = useMemo(
    () => chartSelect({
      order: standingsSeries.names,
      range: chartRange,
      search: appliedSearch,
      hidden,
      focus: hovered ?? isolate,
    }),
    [standingsSeries.names, chartRange, appliedSearch, hidden, hovered, isolate],
  );
  const toggleIsolate = (name: string) => setIsolated((iso) => (iso === name ? null : name));

  // A2: SR-only table — visible drivers × races, values straight from the
  // chart's own rows (drivers who hadn't scored yet at a race → "—").
  const champSrTable = useMemo(
    () => buildSrTable(
      standingsSeries.rows.map((r) => String(r.race ?? "")),
      sel.visible.map((n) => ({
        name: n,
        data: standingsSeries.rows.map((r) => (typeof r[n] === "number" ? (r[n] as number) : null)),
      })),
    ),
    [standingsSeries.rows, sel.visible],
  );

  // UX-02: sync range + q to the URL (replace, not push — never floods
  // history). q rides appliedSearch, so the write is debounced by the same
  // timer as the filter; defaults (top10, empty q) are omitted from the URL.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (chartRange !== "top10") next.set("range", chartRange);
    else next.delete("range");
    if (appliedSearch) next.set("q", appliedSearch);
    else next.delete("q");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [chartRange, appliedSearch, searchParams, setSearchParams]);

  // Nearest-line hit-test (recharts Line ignores onMouseEnter in v3)
  const chartRef = useRef<HTMLDivElement>(null);
  const pointsRef = useRef<Record<string, ReadonlyArray<{ x: number; y: number; race: string }>> | null>(null);
  useEffect(() => {
    const chartDiv = chartRef.current;
    if (!chartDiv || !chartDiv.querySelector) return;
    const points: Record<string, ReadonlyArray<{ x: number; y: number; race: string }>> = {};
    for (const name of sel.visible) {
      const path = chartDiv.querySelector<SVGPathElement>(`path.recharts-line-curve[stroke="${colourOf(name)}"]`);
      if (!path) continue;
      const len = path.getTotalLength();
      const pts: { x: number; y: number; race: string }[] = [];
      for (let i = 0; i < standingsSeries.rows.length; i++) {
        const pt = path.getPointAtLength((len * i) / (standingsSeries.rows.length - 1 || 1));
        const ctm = path.getScreenCTM();
        if (!ctm) continue;
        const screen = new DOMPoint(pt.x, pt.y).matrixTransform(ctm);
        const rect = chartDiv.getBoundingClientRect();
        pts.push({
          x: screen.x - rect.left,
          y: screen.y - rect.top,
          race: String(standingsSeries.rows[i]?.race ?? ""),
        });
      }
      if (pts.length) points[name] = pts;
    }
    pointsRef.current = points;
  }, [sel.visible, standingsSeries.rows, colourOf]);

  useEffect(() => {
    const root = chartRef.current;
    if (!root) return;
    const handleMove = (e: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      const cy = e.clientY - rect.top;
      let best = { name: null as string | null, dist: Infinity };
      for (const [name, pts] of Object.entries(pointsRef.current ?? {}) as [string, { x: number; y: number; race: string }[]][]) {
        for (const p of pts) {
          const d = Math.abs(p.y - cy);
          if (d < best.dist) {
            best = { name, dist: d };
          }
        }
      }
      if (best.name && best.name !== hovered) setHovered(best.name);
    };
    const handleLeave = () => setHovered(null);
    root.addEventListener("mousemove", handleMove);
    root.addEventListener("mouseleave", handleLeave);
    return () => {
      root.removeEventListener("mousemove", handleMove);
      root.removeEventListener("mouseleave", handleLeave);
    };
  }, [hovered, sel.visible]);

  // PF-06: stable row arrays — inline slice/filter handed Recharts a fresh
  // reference every parent render, restarting bar animations on hover/resize
  // with identical geometry (first mount still animates).
  const topTeams = useMemo(
    () => (coreReady && coreData ? coreData.teamChampionship.slice(0, 10) : []),
    [coreReady, coreData],
  );
  const topStrategies = useMemo(
    () => (extrasData?.strategyCount ?? []).filter((s) => s.strategy !== "no-data").slice(0, 8),
    [extrasData],
  );
  // A2: SR tables for the two bar charts
  const teamsSrTable = useMemo(
    () => buildSrTable(
      topTeams.map((t) => t.team),
      [{ name: "Points", data: topTeams.map((t) => t.points) }],
    ),
    [topTeams],
  );
  const strategiesSrTable = useMemo(
    () => buildSrTable(
      topStrategies.map((s) => s.strategy),
      [{ name: "Races", data: topStrategies.map((s) => s.count) }],
    ),
    [topStrategies],
  );
  const stagePending = coreStatus !== "ready" || extrasStatus !== "ready";
  const coreError = core.year === year ? core.error : "";
  const extrasError = extras.year === year ? extras.error : "";

  return (
    <div className="space-y-8">
      <div role="status" className="rounded-md border bg-muted/60 px-3 py-2 text-xs text-muted-foreground min-h-[50px]">
        {stagePending ? `calendar ✓ · championship data ${stepLabel(coreStatus)} · strategy data ${stepLabel(extrasStatus)}` : ' '}
      </div>
      {(coreStale || extrasStale || meetingsStale) && (
        <div className="rounded-md border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          Data may be out of date (latest revalidation failed).
        </div>
      )}
      <section>
        <h2 className={SECTION}>Calendar</h2>
        <Card>
          <CardContent className="pt-6">
            {meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No races found for {year}.</p>
            ) : (
              <div className={MEETING_GRID}>
                {meetings.map((m) => {
                  const upcoming = raceIsUnrun(m);
                  return (
                    <button
                      key={m.meeting_key}
                      type="button"
                      title={m.meeting_name}
                      onClick={() => navigate(`/race/${m.year}/${slugForMeeting(meetings, m)}`)}
                      className={`flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring${upcoming ? " opacity-60" : ""}`}
                    >
                      <img
                        src={m.country_flag}
                        alt=""
                        width={24}
                        loading="lazy"
                        decoding="async"
                        className="h-auto w-6 shrink-0 rounded-[2px]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{m.meeting_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {m.circuit_short_name}
                        </span>
                      </span>
                      {upcoming && (
                        <Badge variant="secondary" className="ml-auto shrink-0">upcoming</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className={SECTION}>Championship</h2>
        <StageSlot
          status={coreStatus} error={coreError} stale={coreStale}
          message={`Failed to load the ${year} championship data.`}
          onRetry={retryCore} skeleton={<ChartSkeleton />}
          rowCount={coreData?.championship.length ?? 0} emptyMessage="No results yet."
        >
          <>
            {/* controls stack above the chart and wrap at 320px */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={chartSearch}
                onChange={(e) => setChartSearch(e.target.value)}
                placeholder="Search driver"
                aria-label="Search drivers"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-52 sm:flex-none"
              />
              <div role="group" aria-label="Range" className="flex h-8 shrink-0 overflow-hidden rounded-md border border-input text-xs">
                {([["top5", "Top 5"], ["top10", "Top 10"], ["all", "All"]] as const).map(([r, label], i) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={chartRange === r}
                    onClick={() => setChartRange(r)}
                    className={`px-2.5 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground${i > 0 ? " border-l border-input" : ""}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {isolate != null && (
                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setIsolated(null)}>
                  Show all
                </Button>
              )}
            </div>
            {/* legend: real buttons, wraps freely at 320px, text-token labels */}
            <ul className="mb-2 flex flex-wrap gap-x-1 gap-y-0.5" data-testid="champ-legend">
              {sel.visible.map((name) => {
                const c = colourOf(name);
                const dim = sel.focus != null && sel.focus !== name;
                return (
                  <li key={name}>
                    <button
                      type="button"
                      aria-pressed={isolate === name}
                      aria-label={`Isolate ${name}`}
                      onMouseEnter={() => setHovered(name)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(name)}
                      onBlur={() => setHovered(null)}
                      onClick={() => toggleIsolate(name)}
                      className={`flex h-8 items-center gap-1.5 rounded px-1.5 text-[11px] transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring${isolate === name ? " text-foreground" : " text-muted-foreground"}${dim ? " opacity-40" : ""}`}
                    >
                      {dashedSet.has(name) ? (
                        <span aria-hidden className="inline-block h-0 w-3 border-t-2 border-dashed" style={{ borderColor: c }} />
                      ) : (
                        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
                      )}
                      {name}
                    </button>
                  </li>
                );
              })}
            </ul>
            {sel.visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">No drivers match.</p>
            ) : (
              <ChartCard
                title="Drivers' championship"
                subtitle={`Cumulative points · ${sel.visible.length} shown · Sprint points merged into their weekend's column`}
                srSummary="Line chart of cumulative championship points per driver across each Grand Prix; an sr-only data table lists every visible driver's score at each race."
                srTable={champSrTable}
              >
                <div
                  ref={chartRef}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const cy = e.clientY - rect.top;
                    let best = { name: null as string | null, dist: Infinity };
                    for (const [name, pts] of Object.entries(pointsRef.current ?? {}) as [string, { x: number; y: number; race: string }[]][]) {
                      for (const p of pts) {
                        const d = Math.abs(p.y - cy);
                        if (d < best.dist) {
                          best = { name, dist: d };
                        }
                      }
                    }
                    if (best.name && best.name !== hovered) setHovered(best.name);
                  }}
                  onMouseLeave={() => setHovered(null)}
                  style={{ position: "relative" }}
                >
                  <LineChart data={standingsSeries.rows}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      dataKey="race"
                      {...AXIS}
                      tick={TICK}
                      interval={1}
                      tickFormatter={raceTick}
                    />
                    <YAxis {...AXIS} tick={TICK} width={45} />
                    <ChartTooltip content={(p) => champTip(p, hovered)} />
                    {sel.visible.map((n) => {
                      const c = colourOf(n);
                      const dash = dashedSet.has(n);
                      const dim = sel.focus != null && sel.focus !== n;
                      return (
                        <Line
                          key={n}
                          dataKey={n}
                          stroke={c}
                          strokeWidth={2}
                          strokeOpacity={dim ? 0.15 : 1}
                          strokeDasharray={dash ? "6 4" : undefined}
                          // teammate marker difference: dashed 2nd driver also carries dots
                          dot={dash ? { r: 2.5, strokeWidth: 0, fill: c } : false}
                          activeDot={{ r: 4 }}
                          // off: 20-line range switches must not queue 1.5s animations
                          isAnimationActive={false}
                          onClick={() => toggleIsolate(n)}
                        />
                      );
                    })}
                  </LineChart>
                </div>
              </ChartCard>
            )}
          </>
        </StageSlot>
      </section>

      <section>
        <h2 className={SECTION}>Teams &amp; strategy</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* core failed → its one error card already sits above; skip duplicates */}
          {coreStatus === "failed" ? null : (
            <StageSlot
              status={coreStatus} error={coreError} stale={coreStale}
              message={`Failed to load the ${year} championship data.`}
              onRetry={retryCore} skeleton={<ChartSkeleton />}
              rowCount={topTeams.length} emptyMessage="No team data yet."
            >
              <ChartCard
                title="Constructors' championship"
                subtitle="Top 10 teams"
                srSummary="Bar chart of total championship points for the top 10 constructor teams."
                srTable={teamsSrTable}
              >
                <BarChart data={topTeams} layout="vertical" margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                  <YAxis type="category" dataKey="team" width={110} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" interval={0} />
                  <ChartTooltip formatter={(value) => [fmtNum(value), "Points"]} />
                  <Bar dataKey="points" name="Points" fill="var(--chart-4)" />
                </BarChart>
              </ChartCard>
            </StageSlot>
          )}

          <StageSlot
            status={extrasStatus} error={extrasError} stale={extrasStale}
            message={`Failed to load the ${year} strategy data.`}
            onRetry={retryExtras} skeleton={<ChartSkeleton />}
            rowCount={topStrategies.length} emptyMessage="No strategy data yet."
          >
            <ChartCard
              title="Most common strategies"
              subtitle="Compound sequences across the season"
              srSummary="Horizontal bar chart counting how many races each tyre compound sequence was used across the season."
              srTable={strategiesSrTable}
            >
              <BarChart data={topStrategies} layout="vertical">
                <CartesianGrid {...GRID_PROPS} />
                <XAxis type="number" {...AXIS} tick={TICK} allowDecimals={false} />
                {/* full SOFT/MEDIUM/HARD words straight from season.ts — width keeps long sequences untruncated */}
                <YAxis
                  type="category"
                  dataKey="strategy"
                  {...AXIS}
                  tick={TICK}
                  width={170}
                  interval={0}
                />
                <ChartTooltip formatter={(value) => [fmtNum(value), "Races"]} />
                <Bar dataKey="count" name="Races" fill="var(--chart-5)" />
              </BarChart>
            </ChartCard>
          </StageSlot>
        </div>
      </section>

      {/* core failed → its one error card already sits above; skip duplicates */}
      {coreStatus !== "failed" && (
        <section>
          <h2 className={SECTION}>Drivers&apos; points</h2>
          <StageSlot
            status={coreStatus} error={coreError} stale={coreStale}
            message={`Failed to load the ${year} championship data.`}
            onRetry={retryCore}
            rowCount={coreData?.championship.length ?? 0} emptyMessage="No results yet."
            skeleton={
              <Card>
                <CardContent className="space-y-3 pt-6">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </CardContent>
              </Card>
            }
          >
            <Card>
              <CardContent className="pt-6">
                <div className="relative" aria-label="Drivers points table scrollable horizontally">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Driver</TableHead>
                        <TableHead>Final team</TableHead>
                        <TableHead className="text-right">Pts</TableHead>
                        <TableHead className="text-right">Wins</TableHead>
                        <TableHead className="text-right">Podiums</TableHead>
                        <TableHead className="text-right">DNF</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(coreData?.championship ?? []).map((d) => (
                        <TableRow key={d.driverName}>
                          <TableCell className="font-medium">{d.driverName}</TableCell>
                          <TableCell className="text-muted-foreground">{d.team}</TableCell>
                          <TableCell className="text-right tabular-nums">{d.points}</TableCell>
                          <TableCell className="text-right tabular-nums">{d.wins}</TableCell>
                          <TableCell className="text-right tabular-nums">{d.podiums}</TableCell>
                          <TableCell className="text-right tabular-nums">{d.dnf}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l from-card to-transparent" aria-hidden="true" />
                </div>
              </CardContent>
            </Card>
          </StageSlot>
        </section>
      )}
    </div>
  );
};
