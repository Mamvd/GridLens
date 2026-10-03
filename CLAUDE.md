# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GridLens — F1 Season & Race Explorer — a pure-frontend web dashboard built on [OpenF1](https://openf1.org/docs/) data. **No backend**: the browser fetches `api.openf1.org` directly (CORS is `*`), cheap resources cache to localStorage, heavy ones stay in memory.

Stack: Vite + React 19 + TypeScript + Tailwind CSS 4 + Recharts 3 for all charts. UI primitives are shadcn/ui-style components (`components.json`, Radix + lucide + cva/clsx/tailwind-merge). Routing is **react-router-dom** (`BrowserRouter`) — deep links like `/race/2024/monaco-grand-prix/pace` are first-class; `vercel.json` rewrites all paths to `index.html` for SPA hosting.

Design system: `design.md` is the source of truth (dark-first, racing-red accent `#ed1c24`, tokens in `src/index.css`). New views should follow it.

## Commands

```
npm run dev        # Vite dev server (may bind to an alternate port if taken; check the log)
npm run build      # tsc -b && vite build — type-checks, so it doubles as the gate
npm run lint       # oxlint
npm run test       # vitest unit suite (node env, test/unit/**)
npm run e2e        # Playwright deterministic suite vs route fixtures (no live API needed)
npm run e2e:live   # Playwright smoke vs real OpenF1 (data-dependent asserts skip on error cards)
npm run preview    # vite preview of a production build
```

Testing layout:

- **Unit** (`test/unit/*.test.ts`): vitest, **node environment, no jsdom**. Setup stubs `localStorage`/`fetch` on `globalThis` (`test/unit/setup.ts`). Tests live **outside** `src/` so `tsc -b` (tsconfig.app.json includes `src/` only) never typechecks them — vitest owns that surface. Extend the hand-rolled stubs rather than adding jsdom.
- **E2E** (`tests/e2e/`): Playwright against system chromium (`/usr/bin/chromium-browser`, `--no-sandbox`). `deterministic.mjs` installs OpenF1 route fixtures and must pass with no network; `live.mjs` hits the real API and treats rate-limit/error cards as skips. Both build `dist/` if missing.
- **Standalone checks** (`scripts/*.mjs`): assert-based scripts for pure modules (cache, slug, intervals, meetings-state, …). Pre-date the vitest suite; run with `node scripts/<name>-check.mjs` (Node strips TS types natively). Prefer vitest for new coverage.

## API facts that are NOT obvious (verified against the live API)

- **OpenF1 only has data from 2023 onward.** 2019–2022 queries return 404. Year floor lives in `src/lib/years.ts` (`MIN_DATA_YEAR = 2023`); the selector list is `[2026, 2025, 2024, 2023]` filtered by that floor. Do not extend it without checking availability first.
- **No `meeting_type` filter exists.** `meetings?meeting_type=GP` returns 404. GPs are found by filtering `meeting_name.includes("Grand Prix")` (the official name can lack "GRAND PRIX", e.g. Emilia Romagna — filter on `meeting_name`, not the official name).
- **`meetings` has no `meeting_date` field.** It exposes `year`, `date_start`, `date_end` (plus `gmt_offset`, circuit fields). Sessions likewise use `date_start`/`date_end`.
- **Stint field names differ from intuition**: `compound` (not `tyre_compound`), `lap_start`/`lap_end` (not `start_lap`/`end_lap`).
- **`is_valid_lap` is null in most datasets.** A "timed lap" is `lap_duration != null` — do not gate on `is_valid_lap === 1` or every chart comes out empty.
- **Multi-value filters work** (`?session_key=9472&session_key=9480`). `data/season.ts` uses this to batch a whole season into a handful of requests instead of ~96.
- **`intervals` is heavy**: ~4.2 MB per race. It is deliberately excluded from localStorage (size gate in `api/cache.ts`, ~500 KB cap) and lives in memory only.
- **Rate limiting is aggressive.** `api/openf1.ts` enforces a global pLimit(4) + 500 ms spacing between request starts + exponential backoff on 429. First season load takes ~30–60 s by design. Don't "fix" the parallelism back up — 429 responses carry no CORS headers, so the browser reports them as opaque network failures.
- **Free tier locks out during live sessions** (401 "Live F1 session in progress", often CORS-opaque in the browser). `src/lib/meetings-state.ts` classifies failures as `offline` / `restricted` / `unreachable` and auto-retries only opaque network errors (bounded, 2 attempts). `LIVE_DATA_ENABLED` in `api/cache.ts` is `false` — no real-time source on the free tier.
- **Boundary validation is mandatory.** `getOpenF1` runs `validateRows` (identity keys, required fields, typed-field map, NaN checks) and throws `OpenF1ValidationError` on HTML/garbage/wrong-shape responses. When adding a resource, register its identity/required/type fields in `IDENTITY`/`REQUIRED`/`TYPE` in `openf1.ts`.
- **Future races 404 opaquely** (single-key request, no CORS headers). `raceIsUnrun` in `data/race.ts` prevents the call — prefer prevention over catch.
- **API has no driver display-name field** — compose `` `${first_name} ${last_name}` `` (helper: `nameOfDriver` in `data/season.ts`).

## Architecture

- `src/App.tsx` — shell + **react-router** routes: `/` → `/season/:year`, `/season/:year`, `/race/:year/:slug` → redirect to `.../pace`, `/race/:year/:slug/:tab`, `*` → NotFound. Owns the meetings load state machine (retry, online listener, error card — never renders "No races found" on API failure). Year comes from the path; header Select navigates. `DEFAULT_YEAR = 2026`.
- `src/api/openf1.ts` — the only fetch site. `getOpenF1<T>(resource, ops)` encodes filter operators (`=`, `>`, `<`, `>=`, `<=`; repeated keys for multi-value), owns the limiter/backoff, accepts `AbortSignal`, validates rows, and exports the shared resource types (`Meeting`, `Session`, `Lap`, `Stint`, …).
- `src/api/cache.ts` — two-tier cache via `cached()`: in-memory always; localStorage only when `persist` && serialized < 500 KB. **Policy is not "no TTL"**: completed seasons persist forever; current year gets a 15 min TTL + revalidate-on-expiry; live (gated off) never persists. Also: in-flight request dedupe, stale-if-error rescue (`{data, stale}`), versioned keys `gridlens:v2:…` (legacy purged on init), `__resetCacheForTests`.
- `src/data/season.ts` — season pipeline. `seasonMeetings` filters GPs; `seasonCore` (championship, team standings, points progression, driver colours) + `seasonExtras` (strategy frequency, pit stats) load progressively in two stages, sharing multi-value batched requests; `seasonBundle` composes both. Sprint sessions merge points into the same weekend's chart column; constructor credit walks sessions chronologically (mid-season team swaps).
- `src/data/race.ts` — lazy per-tab race loading. `loadRaceBase` fetches `session_result` + `drivers` only; `TAB_RESOURCES` maps pace→laps, gaps→intervals, strategy→stints, pit→stints+pit+overtakes; `DETAIL_RESOURCES` (laps/pit/overtakes/grid) load on demand for detail cards. Derived analytics: `computeStrategies`, `driverLapsForSectors`, `parseInterval`/`fmtInterval`, `fmtLapTime`/`fmtSectorTime`, `raceIsUnrun`, `detailFields`.
- `src/lib/` — pure, React-free helpers (importable by tests/scripts without JSX): `meetings-state.ts` (load state machine + failure classification), `resource-state.ts` (loading/error/empty/ready phase resolver), `slug.ts` (meeting slugs, deduped, diacritic-safe), `years.ts` (year floor), `dates.ts` (circuit-local dates via `gmt_offset`, never viewer-zone), `chart-select.ts` (championship chart selection/colours), `utils.ts` (`cn()`).
- `src/components/ui/` — shadcn-style primitives (badge, button, card, select, skeleton, table, tabs). `src/components/charts/ChartCard.tsx` wraps Recharts panels.
- `src/views/` — `Season.tsx` (calendar + championship/strategy charts; progressive core→extras) and `Race.tsx` (Pace / Gaps / Strategy / Pit tabs + on-demand detail cards). All chart presentation is Recharts; keep new views in that shape.

## Conventions

- `ponytail:` comments mark deliberate simplifications with the upgrade path — preserve and follow this style when adding trade-offs.
- Keep pure logic in `src/lib/` (or exported from data/api modules) React-free so vitest and `scripts/*.mjs` can import it without a DOM or JSX transform.
- Dev mode: React StrictMode double-invokes effects, so API requests are issued twice in dev. Expected — the cache's in-flight dedupe makes the second call join the first. Don't chase it.
- oxlint: `react/rules-of-hooks` is an error; keep hooks unconditional.
- Path alias `@/*` → `src/*` (vite + tsconfig + vitest all wire it).
