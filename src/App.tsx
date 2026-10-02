import { useEffect, useState } from "react";
import {
  BrowserRouter, Routes, Route, Navigate, Link,
  useParams, useLocation, useNavigate,
} from "react-router-dom";
import { getOpenF1, type Meeting } from "./api/openf1";
import { Season } from "./views/Season";
import { Race } from "./views/Race";
import { meetingFor } from "./lib/slug";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const YEARS = [2026, 2025, 2024, 2023];
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

const SeasonRoute = ({ meetings }: { meetings: Meeting[] }) => {
  const { year } = useParams();
  if (!year || !YEARS.includes(Number(year))) {
    return <Navigate to={`/season/${DEFAULT_YEAR}`} replace />;
  }
  return <Season year={Number(year)} meetings={meetings} />;
};

const RaceRedirect = () => {
  const { year, slug } = useParams();
  return <Navigate to={`/race/${year}/${slug}/pace`} replace />;
};

const RaceRoute = ({ meetings, loadedYear }: { meetings: Meeting[]; loadedYear: number | null }) => {
  const { year, slug, tab } = useParams();
  if (!year || !YEARS.includes(Number(year))) {
    return <Navigate to={`/season/${DEFAULT_YEAR}`} replace />;
  }
  if (!TABS.includes(tab as (typeof TABS)[number])) {
    return <Navigate to={`/race/${year}/${slug}/pace`} replace />;
  }
  const meeting = meetingFor(meetings, slug ?? "");
  if (meeting) return <Race meeting={meeting} />;
  // slug can't be judged until the year's meetings have loaded
  if (loadedYear !== Number(year)) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-9 w-full max-w-[360px]" />
        </CardContent>
      </Card>
    );
  }
  return <NotFound />;
};

const Shell = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const year = yearFromPath(location.pathname);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loadedYear, setLoadedYear] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setMeetings([]);
    setLoadedYear(null);
    if (year !== null) {
      getOpenF1<Meeting>("meetings", { year }, { signal: controller.signal })
        .then((all) => {
          if (!alive) return;
          setMeetings(all.filter((m) => m.meeting_name.includes("Grand Prix")));
          setLoadedYear(year);
        })
        .catch((e) => {
          if ((e as Error)?.name === "AbortError") return;
          if (alive) setLoadedYear(year); // empty list → no-races / not-found downstream
        });
    }
    return () => { alive = false; controller.abort(); };
  }, [year]);

  // one document.title effect for every route
  useEffect(() => {
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
  }, [location.pathname, meetings, loadedYear]);

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
          <Route path="/season/:year" element={<SeasonRoute meetings={meetings} />} />
          <Route path="/race/:year/:slug" element={<RaceRedirect />} />
          <Route
            path="/race/:year/:slug/:tab"
            element={<RaceRoute meetings={meetings} loadedYear={loadedYear} />}
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
