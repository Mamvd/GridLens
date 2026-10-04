import { Link } from "react-router-dom";
import { availableYears, MIN_DATA_YEAR } from "../lib/years";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const YEARS = availableYears();
const FEATURED_YEAR = YEARS[0]; // CTA target — derived, never hardcoded

// Only features that exist today — titles/labels match Season.tsx sections and
// Race.tsx tabs (Pace / Gaps / Strategy / Pit).
const FEATURES: { title: string; body: string }[] = [
  {
    title: "Championship standings",
    body: "Drivers' and constructors' points race by race — Sprint points merged into their weekend's column.",
  },
  {
    title: "Calendar",
    body: "Every Grand Prix weekend of the season, dated in the circuit's own timezone.",
  },
  {
    title: "Tyre strategy",
    body: "The most common compound sequences across the season, plus each driver's stint plan per race.",
  },
  {
    title: "Pace",
    body: "Lap times for every driver with a Sector Times breakdown on the Pace tab.",
  },
  {
    title: "Gaps",
    body: "Interval to the car ahead, lap by lap, on the Gaps tab.",
  },
  {
    title: "Pit stops",
    body: "Stationary time per stop (Pit Stop Times) plus overtakes made and lost.",
  },
];

// Inline sparkline — decorative, dimensioned (width/height) so it reserves its
// box before paint (zero CLS). No external images.
const HeroSparkline = () => (
  <svg
    width="320"
    height="72"
    viewBox="0 0 320 72"
    aria-hidden="true"
    focusable="false"
    className="mt-7 h-auto w-full max-w-[320px]"
  >
    <line x1="0" y1="70" x2="320" y2="70" stroke="var(--border)" strokeWidth="1" />
    <polyline
      points="4,26 24,34 44,22 64,40 84,30 104,46 124,36 144,52 164,44 184,58 204,48 224,34 244,50 264,42 284,60 304,52 316,46"
      fill="none"
      stroke="var(--chart-4)"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <circle cx="184" cy="58" r="3.5" fill="var(--chart-1)" />
  </svg>
);

const SECTION = "mb-4 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground";
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export const Landing = () => (
  <div className="space-y-12 pb-4">
    {/* hero — owns the page's only h1 (header brand renders as a span on /) */}
    <section className="pt-6 sm:pt-10">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">GridLens</h1>
      <p className="mt-3 text-base text-muted-foreground sm:text-lg">
        F1 season &amp; race explorer built on OpenF1 data, {MIN_DATA_YEAR} onward.
      </p>
      <p className="mt-2 max-w-[640px] text-sm text-foreground/90">
        Championship standings, calendar, tyre strategy, lap pace, gaps and pit stops —
        every {MIN_DATA_YEAR}&ndash;{YEARS[0]} season, right in your browser. No account, no backend.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* dark text on racing red = 4.52:1 (white on #ed1c24 is only 4.38:1) */}
        <Button
          asChild
          size="lg"
          className={`min-h-11 bg-primary text-background hover:bg-primary ${FOCUS}`}
        >
          <Link to={`/season/${FEATURED_YEAR}`}>Explore {FEATURED_YEAR} season</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className={`min-h-11 ${FOCUS}`}>
          <a href="#seasons">Pick a season</a>
        </Button>
      </div>
      <HeroSparkline />
    </section>

    <section aria-labelledby="explore">
      <h2 id="explore" className={SECTION}>What you can explore</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <Card key={f.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{f.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-xs leading-relaxed">{f.body}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>

    <section id="seasons" className="scroll-mt-20" aria-labelledby="seasons-title">
      <h2 id="seasons-title" className={SECTION}>Seasons</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {YEARS.map((y) => (
          <li key={y}>
            <Link
              to={`/season/${y}`}
              className={`flex min-h-11 items-center justify-between rounded-xl border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted ${FOCUS}`}
            >
              <span>{y} season</span>
              <span aria-hidden className="text-xs text-muted-foreground">&rarr;</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>

    <section aria-labelledby="how">
      <h2 id="how" className={SECTION}>How it works</h2>
      <Card>
        <CardContent className="pt-6">
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">OpenF1 data.</span>{" "}
              Race data comes from{" "}
              <a
                href="https://openf1.org"
                className={`text-foreground underline underline-offset-4 hover:text-muted-foreground ${FOCUS}`}
              >
                openf1.org
              </a>
              , an open motorsport data API.
            </li>
            <li>
              <span className="font-medium text-foreground">Fully in your browser.</span>{" "}
              No backend and no account — the app fetches the API directly and caches
              seasons locally between visits.
            </li>
            <li>
              <span className="font-medium text-foreground">From {MIN_DATA_YEAR} onward.</span>{" "}
              OpenF1 has no data before {MIN_DATA_YEAR}, so earlier seasons are not offered.
            </li>
          </ul>
        </CardContent>
      </Card>
    </section>

    <footer className="border-t pt-6 pb-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <a
          href="https://openf1.org"
          className={`inline-flex min-h-10 items-center underline underline-offset-4 hover:text-foreground ${FOCUS}`}
        >
          Data by OpenF1
        </a>
        <a
          href="https://github.com/Mamvd/GridLens"
          className={`inline-flex min-h-10 items-center underline underline-offset-4 hover:text-foreground ${FOCUS}`}
        >
          GitHub
        </a>
      </div>
      <p>
        Unofficial project. Not affiliated with Formula 1, the FIA, or any team.
      </p>
    </footer>
  </div>
);
