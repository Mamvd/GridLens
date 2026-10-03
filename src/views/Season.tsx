import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
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
  resolveTeamColours, FALLBACK_HUES, type ChartRange,
} from "../lib/chart-select";
import { ChartCard, ChartTooltip } from "@/components/charts/ChartCard";
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
const TICK = { fontSize: 10, fill: "var(--muted-foreground)" };
const GRID_PROPS = { stroke: "var(--border)", strokeDasharray: "3 3" };

const fmtNum = (v: unknown) => {
  if (v == null) return "—";
  return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
};

// "Bahrain Grand Prix" → "Bahrain" for axis density.
const raceTick = (v: string) => v.replace(/\s+Grand Prix$/i, "");

// tooltip: "driver · round · points" (spec format), text tokens only —
// never the series colour, per dataviz rules.
const champTip = (props: {
  active: boolean;
  label?: string | number;
  payload: ReadonlyArray<{
    name?: string | number;
    value?: number | string | ReadonlyArray<number | string>;
    payload?: unknown;
  }>;
}) => {
  if (!props.active || !props.payload.length) return null;
  const row = props.payload[0];
  const data = (row.payload ?? {}) as { race?: string };
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md">
      {String(row.name ?? "")} · {raceTick(String(data.race ?? props.label ?? ""))} · {fmtNum(row.value)} pts
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
    // ponytail: cap at 20 lines ("All" ≈ one F1 grid) — Recharts renders 20
    // fine unanimated; raise after profiling if backmarker data is wanted.
    const names = [...perDriver.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n]) => n);
    return { rows, names };
  }, [coreData]);

  // #15 championship-chart interactions: hover dims, click isolates
  // (persists until re-click / Show all), legend buttons + search + ranges.
  const [chartRange, setChartRange] = useState<ChartRange>("top10");
  const [chartSearch, setChartSearch] = useState("");
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
      search: chartSearch,
      hidden,
      focus: hovered ?? isolate,
    }),
    [standingsSeries.names, chartRange, chartSearch, hidden, hovered, isolate],
  );
  const toggleIsolate = (name: string) => setIsolated((iso) => (iso === name ? null : name));

  const topTeams = coreReady && coreData ? coreData.teamChampionship.slice(0, 10) : [];
  const topStrategies = (extrasData?.strategyCount ?? []).filter((s) => s.strategy !== "no-data").slice(0, 8);
  const stagePending = coreStatus !== "ready" || extrasStatus !== "ready";
  const coreError = core.year === year ? core.error : "";
  const extrasError = extras.year === year ? extras.error : "";

  return (
    <div className="space-y-8">
      {stagePending && (
        <div role="status" className="rounded-md border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {`calendar ✓ · championship data ${stepLabel(coreStatus)} · strategy data ${stepLabel(extrasStatus)}`}
        </div>
      )}
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
                subtitle={`Cumulative points · ${sel.visible.length} shown`}
                srSummary="Line chart of cumulative championship points per driver across each Grand Prix; legend and table below show the same data."
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
                  <ChartTooltip content={champTip} />
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
                        onMouseEnter={() => setHovered(n)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={() => toggleIsolate(n)}
                      />
                    );
                  })}
                </LineChart>
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
              >
                <BarChart data={topTeams}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="team"
                    {...AXIS}
                    tick={TICK}
                    interval={0}
                    angle={-20}
                    height={60}
                  />
                  <YAxis {...AXIS} tick={TICK} width={45} allowDecimals={false} />
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Team</TableHead>
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
              </CardContent>
            </Card>
          </StageSlot>
        </section>
      )}
    </div>
  );
};
