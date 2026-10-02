import { useEffect, useState } from "react";
import { getOpenF1, type Meeting } from "./api/openf1";
import { Season } from "./views/Season";
import { Race } from "./views/Race";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const YEARS = [2026, 2025, 2024, 2023];

export default function App() {
  const [year, setYear] = useState(2024);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);

  useEffect(() => {
    setMeeting(null);
    getOpenF1<Meeting>("meetings", { year })
      .then((all) => setMeetings(all.filter((m) => m.meeting_name.includes("Grand Prix"))))
      .catch(() => setMeetings([]));
  }, [year]);

  return (
    <div className="dark min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-5 py-3">
          <h1 className="text-[17px] font-semibold tracking-tight">F1 Season &amp; Race Explorer</h1>
          <Badge variant="secondary" className="ml-1 hidden sm:inline-flex">{year}</Badge>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">Season</span>
            <Select value={String(year)} onValueChange={(v) => setYear(+v)}>
              <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YEARS.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-5">
        {meeting ? (
          <Race meeting={meeting} onBack={() => setMeeting(null)} />
        ) : (
          <Season year={year} meetings={meetings} onOpenRace={setMeeting} />
        )}
      </main>
    </div>
  );
}
