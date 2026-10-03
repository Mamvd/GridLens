import { useEffect, useState } from "react";
import {
  BrowserRouter, Routes, Route, Navigate, Link,
  useParams, useLocation, useNavigate,
} from "react-router-dom";
import { seasonMeetings } from "./data/season";
import {
  resolveMeetingsState, initialMeetingsState,
  type MeetingsLoadState,
} from "./lib/meetings-state";
import { Season } from "./views/Season";
import { Race } from "./views/Race";
import { meetingFor } from "./lib/slug";
import { availableYears } from "./lib/years";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const YEARS = availableYears();
const DEFAULT_YEAR = 2026;
const TABS = ["pace", "gaps", "strategy", "pit"] as const;

// year embedded in /season/:year and /race/:year/… — null when absent or not selectable
const yearFromPath = (pathname: string): number | null => {
  const m = pathname.match(/^\/(?:season|race)\/(\d{4})(?:\/|$)/);
  const y = m ? Number(m[1]) : null;
  return y !== null && YEARS.includes(y) ? y : null;
};

const NotFound = () => (
  <Card>
    <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">Not found</p>
      <Link
        to={`/season/${DEFAULT_YEAR}`}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Back to season
      </Link>
    </CardContent>
  </Card>
);

// #9: meetings fetch failed with no cached entry — never "No races found".
// Raw error text stays out of the copy (title attr only).
const MeetingsErrorCard = ({ year, onRetry }: { year: number; onRetry: () => void }) => (
  <Card className="border-destructive/50 bg-destructive/10">
    <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-[13px] text-destructive">
        Unable to reach OpenF1. The {year} season could not be loaded.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </CardContent>
  </Card>
);

const RouteSkeleton = () => (
  <Card>
    <CardContent className="space-y-3 p-6">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-9 w-full max-w-[360px]" />
    </CardContent>
  </Card>
);

const SeasonRoute = ({ state, onRetry }: { state: MeetingsLoadState; onRetry: () => void }) => {
  const { year } = useParams();
  if (!year || !YEARS.includes(Number(year))) {
    return <Navigate to={`/season/${DEFAULT_YEAR}`} replace />;
  }
  // error + no stale cache → explicit error card (never "No races found")
  if (state.status === "error") return <MeetingsErrorCard year={Number(year)} onRetry={onRetry} />;
  // success with 0 meetings is the ONLY empty case → Season shows "No races found"
  if (state.status !== "success") return <RouteSkeleton />;
  return (
    <Season
      year={Number(year)}
      meetings={state.meetings}
      meetingsStale={state.stale}
    />
  );
};

const RaceRedirect = () => {
  const { year, slug } = useParams();
  return <Navigate to={`/race/${year}/${slug}/pace`} replace />;
};

const RaceRoute = ({ state, onRetry }: { state: MeetingsLoadState; onRetry: () => void }) => {
  const { year, slug, tab } = useParams();
  if (!year || !YEARS.includes(Number(year))) {
    return <Navigate to={`/season/${DEFAULT_YEAR}`} replace />;
  }
  if (!TABS.includes(tab as (typeof TABS)[number])) {
    return <Navigate to={`/race/${year}/${slug}/pace`} replace />;
  }
  // meetings error → same card as Season route, not skeleton-forever / NotFound
  if (state.status === "error") return <MeetingsErrorCard year={Number(year)} onRetry={onRetry} />;
  const meetings = state.status === "success" ? state.meetings : [];
  const loadedYear = state.status === "success" ? state.year : null;
  const meeting = meetingFor(meetings, slug ?? "");
  if (meeting) return <Race meeting={meeting} />;
  // slug can't be judged until the year's meetings have loaded
  if (state.status !== "success" || loadedYear !== Number(year)) {
    return <RouteSkeleton />;
  }
  return <NotFound />;
};

const Shell = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const year = yearFromPath(location.pathname);
  // #9: single state machine — API-down ≠ empty season. stale=true means the
  // list came from cache after a failed fetch (seasonMeetings' stale-if-error).
  const [state, setState] = useState<MeetingsLoadState>(initialMeetingsState);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setState((prev) => resolveMeetingsState(prev, { type: "start", year: year ?? DEFAULT_YEAR }));
    if (year !== null) {
      // seasonMeetings → cached(): network failure with a cache entry resolves
      // as {stale: true}; reject means no cache → error state (clean card).
      seasonMeetings(year)
        .then((res) => {
          if (!alive) return;
          setState((prev) => resolveMeetingsState(prev, {
            type: "success",
            year,
            meetings: res.data,
            stale: res.stale,
          }));
        })
        .catch((e) => {
          if ((e as Error)?.name === "AbortError") return;
          if (!alive) return;
          setState((prev) => resolveMeetingsState(prev, { type: "error", year }));
        });
    }
    return () => { alive = false; controller.abort(); };
  }, [year, reloadKey]);

  // one document.title effect for every route
  useEffect(() => {
    const meetings = state.status === "success" ? state.meetings : [];
    const loadedYear = state.status === "success" ? state.year : null;
    const season = location.pathname.match(/^\/season\/(\d{4})/);
    if (season) {
      document.title = `GridLens — ${season[1]} Season`;
      return;
    }
    const race = location.pathname.match(/^\/race\/(\d{4})\/([^/]+)(?:\/([^/]+))?/);
    if (race) {
      const meeting = meetingFor(meetings, race[2]);
      const tabLabel = (race[3] ?? "pace").replace(/^./, (c) => c.toUpperCase());
      if (meeting) document.title = `GridLens — ${meeting.meeting_name} (${tabLabel})`;
      else document.title = loadedYear === Number(race[1]) ? "GridLens — Not found" : "GridLens";
      return;
    }
    document.title = location.pathname === "/"
      ? `GridLens — ${DEFAULT_YEAR} Season`
      : "GridLens — Not found";
  }, [location.pathname, state]);

  return (
    <div className="dark min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-5 py-3">
          <h1 className="text-[17px] font-semibold tracking-tight">GridLens</h1>
          <span className="text-xs text-muted-foreground">F1 Season & Race Explorer</span>
          <Badge variant="secondary" className="ml-1 hidden sm:inline">{year ?? DEFAULT_YEAR}</Badge>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">Season</span>
            <Select value={String(year ?? DEFAULT_YEAR)} onValueChange={(v) => navigate(`/season/${v}`)}>
              <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YEARS.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-5">
        <Routes>
          <Route path="/" element={<Navigate to={`/season/${DEFAULT_YEAR}`} replace />} />
          <Route path="/season/:year" element={<SeasonRoute state={state} onRetry={() => setReloadKey((k) => k + 1)} />} />
          <Route path="/race/:year/:slug" element={<RaceRedirect />} />
          <Route
            path="/race/:year/:slug/:tab"
            element={<RaceRoute state={state} onRetry={() => setReloadKey((k) => k + 1)} />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
