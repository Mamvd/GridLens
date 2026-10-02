# GridLens — F1 Season & Race Explorer

Pure-frontend React+TS dashboard over OpenF1 data (api.openf1.org), no backend; browser-side caching. Season view (calendar, championship, strategy frequency, pit stats) + race view (Pace/Gaps/Strategy/Pit tabs).

## Quick start

```bash
npm install
npm run dev
npm run build
npm run lint
```

## Architecture

- `src/api` — OpenF1 client with rate limiter and cache
- `src/data` — derived analytics (`race.ts`, `season.ts`)
- `src/views` — Season and Race views
- `shadcn/ui` components
- `design.md` — design system source of truth
- `CLAUDE.md` — repository guide for Claude Code

## Note

OpenF1 data available 2023+ only.