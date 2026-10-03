// Championship-chart selection + colour helpers (#15). Pure, React-free:
// Season.tsx owns state, this owns decisions — every branch node-testable
// via scripts/chart-select-check.mjs.

export type ChartRange = "top5" | "top10" | "all";

export const rangeLimit = (range: ChartRange): number =>
  range === "top5" ? 5 : range === "top10" ? 10 : Number.POSITIVE_INFINITY;

// case- and diacritic-insensitive substring match ("josé" finds "José",
// "JOSE" finds "José", "g" matches every name containing g)
const norm = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const matchesSearch = (name: string, search: string): boolean => {
  const q = norm(search);
  return q.length === 0 || norm(name).includes(q);
};

export interface ChartSelectInput {
  order: readonly string[];    // driver names, points order (best first)
  range: ChartRange;            // quick-range cap, applied to order first
  search: string;               // name filter (matchesSearch)
  hidden: ReadonlySet<string>;  // toggled-out / isolate-away — persistent
  focus: string | null;         // hovered or isolated driver
}

export interface ChartSelectResult {
  visible: string[];            // rendered keys, order preserved
  focus: string | null;         // focus only when that driver is visible
}

// Range caps the points-order pool, then hidden + search filter it. A focus
// driver outside the visible set collapses to null (no phantom isolation).
export const chartSelect = (input: ChartSelectInput): ChartSelectResult => {
  const limit = rangeLimit(input.range);
  const pool = Number.isFinite(limit) ? input.order.slice(0, limit) : [...input.order];
  const visible = pool.filter((n) => !input.hidden.has(n) && matchesSearch(n, input.search));
  const focus = input.focus != null && visible.includes(input.focus) ? input.focus : null;
  return { visible, focus };
};

// Teammates share one team colour → second driver in points order gets a
// dashed stroke (plus a different dot marker in the view) to tell them apart.
export const teammateDashed = (
  entries: readonly { name: string; team: string }[],
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const dashed = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.team)) dashed.add(e.name);
    else seen.add(e.team);
  }
  return dashed;
};

// First points-order driver with an API team_colour defines the team's colour
// → teammates always stroke the same hex even when only one row has data.
export const resolveTeamColours = (
  entries: readonly { name: string; team: string }[],
  driverColours: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const hex = driverColours[e.name];
    if (hex && !out[e.team]) out[e.team] = hex;
  }
  return out;
};

// 10-slot fallback palette for teams without an API colour — validated
// dark-mode via dataviz validate_palette.js against surface #1a1a19:
// lightness band 0.48–0.67, chroma ≥0.1, worst adjacent CVD ΔE 8.4,
// normal-vision ΔE 19.3, contrast ≥3:1 (ALL CHECKS PASS).
export const FALLBACK_HUES = [
  "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181",
  "#008300", "#9085e9", "#e66767", "#0f9fd6", "#86a300",
] as const;

const djb2 = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// team → hue: sorted iteration + linear probe → deterministic for any input
// order, no collisions up to 10 teams. ponytail: >10 teams wrap hues (the
// palette is adjacent-pair validated, not all-pairs) — extend FALLBACK_HUES
// + re-run validate_palette.js when the grid exceeds 10 constructors.
export const fallbackPalette = (teams: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  for (const team of [...new Set(teams)].sort()) {
    let slot = djb2(team) % FALLBACK_HUES.length;
    while (used.has(slot)) slot = (slot + 1) % FALLBACK_HUES.length;
    used.add(slot);
    out[team] = FALLBACK_HUES[slot];
  }
  return out;
};

// Dark-surface stroke floor: relative luminance ≥0.17 ≈ 3:1 against the
// chart card #1a1a19. Near-black team colours (e.g. #000000) lift toward
// white in 5% steps — hue preserved as far as possible, never swapped for
// grey. App is dark-only (App.tsx hardcodes the `dark` class), so one floor
// covers every stroke; revisit only if a light theme appears.
const MIN_STROKE_LUM = 0.17;

const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (r: number, g: number, b: number): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

// null → invalid/missing hex, caller falls back to fallbackPalette.
export const ensureVisible = (hex: string): string | null => {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  if (relativeLuminance(r, g, b) >= MIN_STROKE_LUM) {
    return hex.trim().startsWith("#") ? hex.trim() : `#${hex.trim()}`;
  }
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const rr = Math.round(r + (255 - r) * t);
    const gg = Math.round(g + (255 - g) * t);
    const bb = Math.round(b + (255 - b) * t);
    if (relativeLuminance(rr, gg, bb) >= MIN_STROKE_LUM) {
      const h2 = (c: number) => c.toString(16).padStart(2, "0");
      return `#${h2(rr)}${h2(gg)}${h2(bb)}`;
    }
  }
  return "#ffffff";
};
