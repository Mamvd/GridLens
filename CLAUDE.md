# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GridLens — F1 Season & Race Explorer — a pure-frontend web dashboard built on [OpenF1](https://openf1.org/docs/) data. **No backend**: the browser fetches `api.openf1.org` directly (CORS is `*`), cheap resources cache to localStorage, heavy ones stay in memory.

Stack: Vite + React 19 + TypeScript, Recharts for all charts. No router — views switch on state in `App.tsx` (season ↔ race). No test framework; verification is done headlessly with Playwright + system chromium (`/usr/bin/chromium-browser`).

## Commands

```
npm run dev        # Vite dev server (may bind to an alternate port if taken; check the log)
npm run build      # tsc -b && vite build — type-checks, so it doubles as the gate
npm run lint       # oxlint
```

There is no test runner. To smoke-test: start dev server, then drive it with Playwright against the system chromium (launch with `executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox"]`). Put throwaway scripts in `*.tmp.mjs` and delete after.

## API facts that are NOT obvious (verified against the live API)

- **OpenF1 only has data from 2023 onward.** 2019–2022 queries return 404. `App.tsx` restricts the year selector to `[2026, 2025, 2024, 2023]` — do not extend it without checking availability first.
- **No `meeting_type` filter exists.** `meetings?meeting_type=GP` returns 404. GPs are found by filtering `meeting_name.includes("Grand Prix")` (the official name can lack "GRAND PRIX", e.g. Emilia Romagna — filter on `meeting_name`, not the official name).
- **`meetings` has no `meeting_date` field.** It exposes `year`, `date_start`, `date_end`.
- **Stint field names differ from intuition**: `compound` (not `tyre_compound`), `lap_start`/`lap_end` (not `start_lap`/`end_lap`).
- **`is_valid_lap` is null in most datasets.** A "timed lap" is `lap_duration != null` — do not gate on `is_valid_lap === 1` or every chart comes out empty.
- **Multi-value filters work** (`?session_key=9472&session_key=9480`). `data/season.ts` uses this to batch an entire season into ~6 requests instead of ~96.
- **`intervals` is heavy**: ~4.2 MB per race. It is deliberately excluded from localStorage (size gate in `api/cache.ts`, ~500 KB cap) and lives in memory only.
- **Rate limiting is aggressive.** `api/openf1.ts` enforces a global pLimit(4) + 500 ms spacing between request starts + exponential backoff on 429. First season load takes ~30–60 s by design. Don't "fix" the parallelism back up — 429 responses carry no CORS headers, so the browser reports them as opaque network failures.

## Architecture

- `src/api/openf1.ts` — the only fetch site. `getOpenF1<T>(resource, ops)` encodes filter operators (`=`, `>`, `<`, `>=`, `<=`; repeated keys for multi-value) and owns the limiter/backoff.
- `src/api/cache.ts` — two-tier cache: in-memory always, localStorage only when the JSON is < 500 KB. Keys embed the full filter set. No TTL (OpenF1 historical data is immutable).
- `src/data/race.ts` — `loadRaceBundle(sessionKey)` parallel-fetches the 8 cheap resources for one race + derived analytics (`computeStrategies`, sector traces, `fmtLapTime`).
- `src/data/season.ts` — `seasonBundle(year)` batches per-race data via multi-value filters and computes championship tables, strategy frequency, pit stats, and per-race points progression.
- `src/views/` — Season (calendar + season charts) and Race (Pace / Gaps / Strategy / Pit tabs). All presentation is Recharts; keep new views in that shape.

## Conventions

- `ponytail:` comments mark deliberate simplifications with the upgrade path — preserve and follow this style when adding trade-offs.
- Dev mode: React StrictMode double-invokes effects, so API requests are issued twice in dev. That is expected; don't chase it.
