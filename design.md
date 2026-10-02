# Design System — GridLens

Single source of truth for rebuilding any view. Dark-first, data-dense, one accent.

## Principles

- **Data density without clutter** — maximize information per pixel; use grid + Card grouping, tight type, subtle borders. No decorative chrome.
- **One accent = racing red** (`--primary: #ed1c24`). Only brand/title/primary action/data highlight use red. Everything else is neutral (zinc/carbon).
- **Motion only on state change** — no ambient animation. Transitions: 150 ms on hover/border, `animate-in` on overlay open only.
- **Keyboard-first** — every interactive element reachable by Tab, focus ring via `ring-ring`, Radix primitives handle roving focus.
- **Dark-first** — app renders `class="dark"` on root. Light tokens defined but unused by default. All contrast checked on dark.

## Tokens

All values live in `src/index.css` under `:root` (light) and `.dark` (dark). Consumed via Tailwind `@theme inline` aliases.

### Surface scale (dark)

| Token | Value | Usage |
|---|---|---|
| `--background` | `#0a0a0b` | page bg |
| `--card` / `--popover` | `#121214` | card / popover bg (slightly lighter than page) |
| `--secondary` / `--muted` | `#1f1f23` | muted fills, skeleton, tabs bg |
| `--border` / `--input` | `#1f1f23` | borders, inputs — same as muted fill (subtle) |
| `--foreground` / `--card-foreground` | `#e8e8ec` | primary text |
| `--muted-foreground` | `#8a8a93` | secondary text, axis ticks |

### Primary / semantic

| Token | Value | Usage |
|---|---|---|
| `--primary` / `--ring` | `#ed1c24` | racing red — primary button, active tab indicator, chart highlight, focus ring |
| `--primary-foreground` | `#ffffff` | text on red |
| `--accent` | `#4a7dff` | gap/secondary accent (blue), secondary hover |
| `--accent-foreground` | `#ffffff` |
| `--destructive` | `#ff3b30` | error state |
| `--radius` | `0.625rem` | base radius; `sm: -4px, md: -2px, lg: base, xl: +4px` |

### Chart palette

| Token | Value | Tire / role |
|---|---|---|
| `--chart-1` | `#ed1c24` | Soft (red) + primary series |
| `--chart-2` | `#f5c518` | Medium (yellow) |
| `--chart-3` | `#8a8a93` | Hard (near-black; `#8a8a93` for visibility on dark — true tire near-black `#2b2b30` invisible on dark) |
| `--chart-4` | `#4a7dff` | Gap / accent series (blue) |
| `--chart-5` | `#34c759` | extra series |

Compound chip colors derive from same mapping: S=`#ed1c24`, M=`#f5c518` (dark text), H=`#e8e8ec` on `#2b2b30` or `#8a8a93` fallback.

### Type & spacing

- `--font-sans`: `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (no font install needed).
- Type scale: h1 17px/650, section h3 14px uppercase muted `letter-spacing 0.06em`, card title 14px/600, body/table 13px, small/muted 12px, chip 10px/600.
- Spacing: header `py-3 px-5`, main `px-5 py-5`, Card `p-6` header + `p-6 pt-0` content, grid gap `8px` (meetings) / `24px` (row layouts). Container `max-w-[1100px] mx-auto`.

## Component Recipes

### Card / Section pattern

Use `Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`. Title 14px semibold, description 12px muted. Sections in Season/Race wrap content in Cards; page-level `h3` headings are uppercase muted (see type scale) above Card grids.

### KPI stat tile spec

`Card` with `CardHeader` (label muted 12px uppercase) + large value (24–30px tabular-nums) + delta/badge row. Grid: `grid-cols-2` on <768, `grid-cols-4` on ≥768. Border only, no shadow.

### ChartCard usage

`src/components/charts/ChartCard.tsx` — `ChartCard({ title, subtitle?, height=320, action?, children })`. Wraps children `ResponsiveContainer` element at given height. Exports `chartTooltip` helper and `ChartTooltip` component for Recharts `Tooltip`.

```tsx
import { ChartCard, chartTooltip } from "@/components/charts/ChartCard"
<ChartCard title="Drivers' championship" subtitle="Top 10 cumulative" height={320}>
  <LineChart data={rows}>
    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
    <XAxis dataKey="race" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
    <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
    <Tooltip contentStyle={chartTooltip.contentStyle} ... />
  </LineChart>
</ChartCard>
```

### Tabs

shadcn `Tabs` (Radix). `TabsList` muted bg, `TabsTrigger` active: `bg-background text-foreground shadow`. Used for Race sub-views (Pace/Gaps/Strategy/Pit). Keep tab count ≤5, labels short.

### Table

shadcn `Table` (`TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`). Head muted 500 weight, row hover `bg-muted/50`, `text-sm`, `p-2`. Wrap in `Card` or `CardContent` with `overflow-auto`.

### Badge — compound chips

`Badge` + custom chip style for tire compounds. Display 3-letter code: `SOF`/`MED`/`HAR` (or `S`/`M`/`H` single-letter compact). Colors per chart palette; dark chip uses light text. Implement as `Badge` variant or plain `span.chip` with inline bg: see `chip` class pattern (10px/600, `px-7px py-2px`, `rounded 4px`, `min-w 30px`).

### Loading (skeleton) rules

On async load, render `Skeleton` blocks mirroring final layout (cards/rows) rather than spinners. One `Skeleton` per card/row, `animate-pulse bg-muted`, heights matching target (e.g., `h-[320px]` for charts). Text rows: `h-4 w-3/4`.

### Error state

`Card` with `border-destructive/50` + `bg-destructive/10`, text `text-destructive` 13px. Keep error copy short (one line) with retry action via `Button variant="outline"`.

## Chart Rules

- **Axis/grid**: `CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3"`, axis `stroke="hsl(var(--muted-foreground))"`, tick 10–11px.
- **Line widths**: primary series 2px, secondary/gap 1.5px, `dot={false}` except last point or hover.
- **Downsample**: ≤150 points per series (decimate by stride or Largest-Triangle-Three-Buckets if needed). Applied in data layer before passing to Recharts.
- **Compound chip**: 3-letter format (`SOF`/`MED`/`HAR`) on strategy rows; compact `S`/`M`/`H` inside chart legends if space tight.
- **Tooltip**: dark card bg (`chartTooltip.contentStyle`), red accent numbers, label muted bold. Time values formatted via `fmtLapTime(ms)` → `m:ss.sss` (e.g., `1:23.456`). Use `ChartTooltip` or spread `chartTooltip` onto Recharts `Tooltip`.
- **Legend**: top or bottom, muted 12px, compound colors match chip palette.

## Responsive

- `<768px` — stack all: single column, meetings grid `1fr`, chart height `260px`, hide secondary columns.
- `768–1024px` — 2-col grids (`grid-cols-2`), meetings `repeat(auto-fill, minmax(200px, 1fr))`, charts span full width.
- `≥1024px` — full layout: `max-w-[1100px]` centered, multi-col where designed, charts `320–380px` height.

Use Tailwind breakpoints `sm/md/lg` accordingly; no custom media queries.

## Do / Don't

- Do use `Card` for every data grouping; don't use bare `div` with custom borders.
- Do use zinc/carbon surfaces + one red accent; don't introduce extra hues outside chart palette.
- Do format times with `fmtLapTime`; don't hand-roll `toFixed` variants.
- Do downsample to ≤150 pts; don't render raw 1000+ point traces.
- Do use `Select` for year/selector controls; don't use native `<select>`.
- Do wrap charts in `ChartCard`; don't place `ResponsiveContainer` directly on page.
- Do keep light-mode vars defined (future) but ship dark; don't add a theme toggle until requested.
- Do use `Skeleton` for loading; don't use spinners or blank space.
