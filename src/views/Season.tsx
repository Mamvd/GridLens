import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from "recharts";
import {
  seasonCore, seasonExtras, type SeasonCore, type SeasonExtras,
} from "../data/season";
import { raceIsUnrun } from "../data/race";
import type { Meeting } from "../api/openf1";
import { slugForMeeting } from "../lib/slug";
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

// ponytail: 5 token hues cycle across the top-10 lines (repeat lap at 0.55
// opacity) — upgrade path: full categorical palette once >5 series must stay distinct.
const SERIES = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)", "var(--chart-3)",
];


const fmtNum = (v: unknown) => {
  if (v == null) return "—";
  return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
};

// "Bahrain Grand Prix" → "Bahrain" for axis density.
const raceTick = (v: string) => v.replace(/\s+Grand Prix$/i, "");

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
// skeleton, ready → cached note (when stale) + content
const StageSlot = ({
  status, error, stale, message, onRetry, skeleton, children,
}: {
  status: StageStatus;
  error: string;
  stale: boolean;
  message: string;
  onRetry: () => void;
  skeleton: ReactNode;
  children: ReactNode;
}) => {
  if (status === "failed") return <StageError message={message} error={error} onRetry={onRetry} />;
  if (status === "loading") return <>{skeleton}</>;
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
    seasonCore(year, meetings)
      .then((r) => {
        if (alive) setCore({ year, data: r, stale: r.stale, error: "" });
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive) setCore({ year, data: null, stale: false, error: String(e) });
      });
    // ponytail: signal not threaded through seasonCore (data layer frozen) —
    // alive + year-scoped payload guard staleness; abort activates once opts lands.
    return () => { alive = false; controller.abort(); };
  }, [year, meetings, coreRetry]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    seasonExtras(year)
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

  // cumulative points per driver across the season
  const standingsSeries = useMemo(() => {
    if (!coreData) return { rows: [] as Record<string, number | string>[], names: [] as string[] };
    const perDriver = new Map<string, number>();
    const rows: Record<string, number | string>[] = [];
    for (const p of coreData.progression) {
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
  }, [coreData]);

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
        <h3 className={SECTION}>Calendar</h3>
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
        <h3 className={SECTION}>Championship</h3>
        <StageSlot
          status={coreStatus} error={coreError} stale={coreStale}
          message={`Failed to load the ${year} championship data.`}
          onRetry={retryCore} skeleton={<ChartSkeleton />}
        >
          <ChartCard title="Drivers' championship" subtitle="Top 10 cumulative points">
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
              <ChartTooltip
                formatter={(value, name) => [fmtNum(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {standingsSeries.names.map((n, i) => (
                <Line
                  key={n}
                  dataKey={n}
                  dot={false}
                  strokeWidth={2}
                  stroke={SERIES[i % SERIES.length]}
                  strokeOpacity={i < SERIES.length ? 1 : 0.55}
                />
              ))}
            </LineChart>
          </ChartCard>
        </StageSlot>
      </section>

      <section>
        <h3 className={SECTION}>Teams &amp; strategy</h3>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* core failed → its one error card already sits above; skip duplicates */}
          {coreStatus === "failed" ? null : (
            <StageSlot
              status={coreStatus} error={coreError} stale={coreStale}
              message={`Failed to load the ${year} championship data.`}
              onRetry={retryCore} skeleton={<ChartSkeleton />}
            >
              <ChartCard title="Constructors' championship" subtitle="Top 10 teams">
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
          >
            <ChartCard title="Most common strategies" subtitle="Compound sequences across the season">
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
          <h3 className={SECTION}>Drivers&apos; points</h3>
          <StageSlot
            status={coreStatus} error={coreError} stale={coreStale}
            message={`Failed to load the ${year} championship data.`}
            onRetry={retryCore}
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
