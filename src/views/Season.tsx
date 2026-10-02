import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from "recharts";
import { seasonBundle, type SeasonStats } from "../data/season";
import type { Meeting } from "../api/openf1";
import { ChartCard, ChartTooltip } from "@/components/charts/ChartCard";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

interface Props {
  year: number;
  meetings: Meeting[];
  onOpenRace: (meeting: Meeting) => void;
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

export const Season = ({ year, meetings, onOpenRace }: Props) => {
  const [loaded, setLoaded] = useState<{ year: number; stats: SeasonStats } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // only expose stats whose year matches the current prop — a slow older
  // bundle can never render under a newer season.
  const stats = loaded && loaded.year === year ? loaded.stats : null;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    seasonBundle(year, meetings)
      .then((b) => {
        if (alive) setLoaded({ year, stats: b.stats });
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        if (alive) setError(String(e));
      })
      .finally(() => alive && setLoading(false));
    // ponytail: signal not threaded through seasonBundle (data layer frozen) —
    // alive + year-scoped payload guard staleness; abort activates once opts lands.
    return () => { alive = false; controller.abort(); };
  }, [year, meetings, reloadKey]);

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

  if (loading) {
    return (
      <div className="space-y-8">
        <section>
          <h3 className={SECTION}>Calendar</h3>
          <Card>
            <CardContent className="pt-6">
              <div className={MEETING_GRID}>
                {Array.from({ length: meetings.length || 12 }, (_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        </section>
        <section>
          <h3 className={SECTION}>Championship</h3>
          <ChartSkeleton />
        </section>
        <section>
          <h3 className={SECTION}>Teams &amp; strategy</h3>
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </section>
        <section>
          <h3 className={SECTION}>Drivers&apos; points</h3>
          <Card>
            <CardContent className="space-y-3 pt-6">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </CardContent>
          </Card>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-destructive" title={error}>
            Failed to load the {year} season.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!stats) return null;

  const topTeams = stats.teamChampionship.slice(0, 10);
  const topStrategies = stats.strategyCount.filter((s) => s.strategy !== "no-data").slice(0, 8);

  return (
    <div className="space-y-8">
      <section>
        <h3 className={SECTION}>Calendar</h3>
        <Card>
          <CardContent className="pt-6">
            {meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No races found for {year}.</p>
            ) : (
              <div className={MEETING_GRID}>
                {meetings.map((m) => (
                  <button
                    key={m.meeting_key}
                    type="button"
                    title={m.meeting_name}
                    onClick={() => onOpenRace(m)}
                    className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h3 className={SECTION}>Championship</h3>
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
      </section>

      <section>
        <h3 className={SECTION}>Teams &amp; strategy</h3>
        <div className="grid gap-6 lg:grid-cols-2">
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
        </div>
      </section>

      <section>
        <h3 className={SECTION}>Drivers&apos; points</h3>
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
                {stats.championship.map((d) => (
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
      </section>
    </div>
  );
};
