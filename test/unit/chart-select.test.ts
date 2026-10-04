import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  rangeLimit, matchesSearch, chartSelect, teammateDashed, fallbackPalette, ensureVisible,
  FALLBACK_HUES, SEARCH_DEBOUNCE_MS, legendInk, LEGEND_RED_INK, CARD_BG, relativeLuminance,
} from "../../src/lib/chart-select";
import { srTableModel } from "../../src/lib/sr-table";

// WCAG 2.x contrast for a #rrggbb pair — the audit's relativeLuminance method.
const contrast = (fg: string, bg: string): number => {
  const rgb = (h: string): [number, number, number] => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [r1, g1, b1] = rgb(fg);
  const [r2, g2, b2] = rgb(bg);
  const a = relativeLuminance(r1, g1, b1);
  const b = relativeLuminance(r2, g2, b2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe("rangeLimit", () => {
  it("top5 / top10 / all", () => {
    expect(rangeLimit("top5")).toBe(5);
    expect(rangeLimit("top10")).toBe(10);
    expect(rangeLimit("all")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("matchesSearch", () => {
  it("empty query matches everything", () => {
    expect(matchesSearch("Max Verstappen", "")).toBe(true);
  });
  it("diacritic-insensitive both directions", () => {
    expect(matchesSearch("José", "josé")).toBe(true);
    expect(matchesSearch("José", "JOSE")).toBe(true);
    expect(matchesSearch("Jose", "josé")).toBe(true);
  });
  it("substring, case-insensitive", () => {
    expect(matchesSearch("Charles Leclerc", "lec")).toBe(true);
    expect(matchesSearch("Charles Leclerc", "HAM")).toBe(false);
  });
});

describe("chartSelect", () => {
  const order = ["Verstappen", "Norris", "Leclerc", "Piastri", "Russell", "Hamilton"];

  it("caps by range, preserves order", () => {
    const r = chartSelect({ order, range: "top5", search: "", hidden: new Set(), focus: null });
    expect(r.visible).toEqual(["Verstappen", "Norris", "Leclerc", "Piastri", "Russell"]);
    const all = chartSelect({ order, range: "all", search: "", hidden: new Set(), focus: null });
    expect(all.visible).toEqual(order);
  });

  it("hidden filters out drivers", () => {
    const r = chartSelect({ order, range: "all", search: "", hidden: new Set(["Norris"]), focus: null });
    expect(r.visible).not.toContain("Norris");
    expect(r.visible).toContain("Verstappen");
  });

  it("focus outside visible set collapses to null", () => {
    const r = chartSelect({ order, range: "top5", search: "", hidden: new Set(), focus: "Hamilton" });
    expect(r.focus).toBeNull(); // Hamilton is #6, outside top5
    const r2 = chartSelect({ order, range: "top5", search: "", hidden: new Set(), focus: "Norris" });
    expect(r2.focus).toBe("Norris");
  });

  it("search intersects with range cap", () => {
    const r = chartSelect({ order, range: "top5", search: "ham", hidden: new Set(), focus: null });
    expect(r.visible).toEqual([]); // Hamilton is outside top5 pool
  });
});

describe("teammateDashed", () => {
  it("second driver of a team is dashed", () => {
    const d = teammateDashed([
      { name: "Verstappen", team: "Red Bull" },
      { name: "Pérez", team: "Red Bull" },
      { name: "Norris", team: "McLaren" },
    ]);
    expect(d.has("Pérez")).toBe(true);
    expect(d.has("Verstappen")).toBe(false);
    expect(d.has("Norris")).toBe(false);
  });
});

describe("fallbackPalette + ensureVisible", () => {
  it("deterministic per team, no crash on many teams", () => {
    const a = fallbackPalette(["Red Bull", "Ferrari", "McLaren"]);
    const b = fallbackPalette(["McLaren", "Ferrari", "Red Bull"]);
    expect(a["Red Bull"]).toBe(b["Red Bull"]);
    expect(a["Ferrari"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("11 real 2026 teams return (regression: infinite probe hang)", () => {
    const teams = [
      "Alpine", "Aston Martin", "Audi", "Cadillac", "Ferrari", "Haas F1 Team",
      "McLaren", "Mercedes", "Racing Bulls", "Red Bull Racing", "Williams",
    ];
    const p = fallbackPalette(teams);
    expect(Object.keys(p)).toHaveLength(11);
    for (const t of teams) expect(FALLBACK_HUES).toContain(p[t]);
  });

  it("≤10 teams keep unique hues", () => {
    const p = fallbackPalette([
      "Alpine", "Aston Martin", "Audi", "Cadillac", "Ferrari",
      "Haas F1 Team", "McLaren", "Mercedes", "Racing Bulls", "Williams",
    ]);
    expect(new Set(Object.values(p)).size).toBe(10);
  });

  it("deterministic and order-independent", () => {
    const teams = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const a = fallbackPalette(teams);
    const b = fallbackPalette([...teams]);
    const c = fallbackPalette([...teams].reverse());
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("20 synthetic teams all mapped, terminates", () => {
    const teams = Array.from({ length: 20 }, (_, i) => `Team ${i}`);
    const p = fallbackPalette(teams);
    expect(Object.keys(p)).toHaveLength(20);
    for (const t of teams) expect(FALLBACK_HUES).toContain(p[t]);
  });

  it("duplicate team names collapse to one entry", () => {
    const p = fallbackPalette(["Ferrari", "McLaren", "Ferrari", "McLaren"]);
    expect(Object.keys(p)).toHaveLength(2);
    expect(Object.values(p).every((v) => FALLBACK_HUES.includes(v as never))).toBe(true);
  });

  it("near-black hex is lifted toward the stroke floor", () => {
    const lifted = ensureVisible("#000000");
    expect(lifted).toMatch(/^#[0-9a-f]{6}$/i);
    expect(lifted).not.toBe("#000000");
  });

  it("already-visible hex passes through normalized", () => {
    expect(ensureVisible("#3987e5")).toBe("#3987e5");
  });

  it("invalid hex → null", () => {
    expect(ensureVisible("not-a-hex")).toBeNull();
    expect(ensureVisible("")).toBeNull();
  });
});

// PF-05: keystrokes must not hit chartSelect live — Season filters on a
// debounced copy so the expensive tree re-render lands after typing pauses.
describe("PF-05: Season search debounce", () => {
  it("SEARCH_DEBOUNCE_MS is 150", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
  });

  it("Season.tsx filters on the debounced search, not raw keystrokes", () => {
    // node env, no jsdom — assert the wiring directly (regression on wiring)
    const src = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/setAppliedSearch\(chartSearch\), SEARCH_DEBOUNCE_MS\)/);
    expect(src).toMatch(/search:\s*appliedSearch/);
    expect(src).not.toMatch(/search:\s*chartSearch\b/);
    // raw state still drives the input + URL sync (responsive typing)
    expect(src).toMatch(/value=\{chartSearch\}/);
  });
});

// PF-06: static bar-chart row arrays are memoized — inline slice/map handed
// Recharts a fresh reference every render, restarting tweens on hover/resize.
describe("PF-06: bar chart rows are reference-stable", () => {
  it("Season constructors/strategies derive via useMemo", () => {
    const src = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const topTeams = useMemo\(/);
    expect(src).toMatch(/const topStrategies = useMemo\(/);
    expect(src).not.toMatch(/data=\{topTeams\./); // no per-render mapping at the chart
  });

  it("Race Pit rows derive via useMemo (no inline .map into BarChart)", () => {
    const src = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const pitRows = useMemo\(/);
    expect(src).toMatch(/const overtakeRows = useMemo\(/);
    expect(src).not.toMatch(/data=\{pitRows\.map\(/);
    expect(src).not.toMatch(/data=\{overtakeRows\.map\(/);
  });
});

// Responsive-390: the constructors chart was a vertical BarChart whose angled
// x-axis team labels collided (11 bbox-overlap pairs at 390px). It is now
// horizontal (layout="vertical" → team names on the category YAxis get full
// width). Pin the orientation so a regression back to vertical bars fails here.
// (Label *overlap* itself is a render concern — asserted via Playwright bbox
// measurement, not this node-env suite.)
describe("Responsive-390: constructors chart is horizontal", () => {
  const src = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");
  const constructorsBlock = src.slice(src.indexOf("Constructors' championship"));

  it("constructors BarChart uses layout=\"vertical\" (team names on YAxis)", () => {
    expect(constructorsBlock).toMatch(/<BarChart data=\{topTeams\} layout="vertical"/);
    // team names are the category axis, numeric points on X
    expect(constructorsBlock).toMatch(/<YAxis type="category" dataKey="team"/);
    expect(constructorsBlock).toMatch(/<XAxis type="number"/);
  });
});

// A2: charts expose an sr-only data table; the pure model decides headers,
// rows, cell formatting and the column cap (ChartCard renders it as JSX).
describe("srTableModel (A2)", () => {
  it("empty labels or empty series → null (no empty table in the DOM)", () => {
    expect(srTableModel([], [{ name: "A", data: [1] }])).toBeNull();
    expect(srTableModel(["L2"], [])).toBeNull();
  });

  it("headers align with every series' cells; values formatted", () => {
    const m = srTableModel(["L2", "L3"], [
      { name: "Sector 1", data: [30.123, 29.5] },
      { name: "Max Verstappen", data: [26, null] },
    ]);
    expect(m).not.toBeNull();
    expect(m!.headers).toEqual(["L2", "L3"]);
    expect(m!.rows).toEqual([
      { name: "Sector 1", cells: ["30.123", "29.500"] },
      { name: "Max Verstappen", cells: ["26", "—"] },
    ]);
  });

  it("NaN / undefined → '—' (never a fabricated number)", () => {
    const m = srTableModel(["t", "t2"], [{ name: "s", data: [NaN, undefined] }]);
    expect(m!.rows[0].cells).toEqual(["—", "—"]);
  });

  it("caps columns at maxCols so a 150-point gap spine stays 100 columns", () => {
    const labels = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const m = srTableModel(labels, [{ name: "gap", data: labels.map(() => 1.234) }]);
    expect(m!.headers).toHaveLength(100);
    expect(m!.rows[0].cells).toHaveLength(100);
    expect(m!.headers[99]).toBe("t99");
  });
});

// UX-02: Season range + search persist in the URL via useSearchParams,
// replace (not push), with q debounced through the appliedSearch copy.
describe("UX-02: Season URL state wiring", () => {
  const src = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");

  it("initial state derived from URL params once", () => {
    expect(src).toMatch(/useSearchParams\(\)/);
    expect(src).toMatch(/searchParams\.get\("range"\)/);
    expect(src).toMatch(/searchParams\.get\("q"\)/);
  });

  it("writes back with replace; q rides the debounced appliedSearch", () => {
    expect(src).toMatch(/setSearchParams\(next, \{ replace: true \}\)/);
    expect(src).toMatch(/next\.set\("q", appliedSearch\)/);
    expect(src).not.toMatch(/next\.set\("q", chartSearch\)/);
    expect(src).toMatch(/next\.set\("range", chartRange\)/);
  });

  it("defaults omitted from the URL (top10 + empty q delete their keys)", () => {
    expect(src).toMatch(/else next\.delete\("range"\)/);
    expect(src).toMatch(/else next\.delete\("q"\)/);
  });
});

// A4: Recharts paints legend TEXT in the series stroke, so #ed1c24 on the card
// (#121214) is 4.27:1 at 11 px — under the 4.5:1 floor. Swatches/strokes keep
// the brand hue; only the text is lifted.
describe("A4: legend ink contrast on --card", () => {
  it("reproduces the audit ratios and clears 4.5:1", () => {
    expect(CARD_BG).toBe("#121214");
    expect(contrast("#ed1c24", CARD_BG)).toBeCloseTo(4.27, 2); // fails, as audited
    expect(contrast(LEGEND_RED_INK, CARD_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LEGEND_RED_INK, CARD_BG)).toBeCloseTo(5.68, 2);
  });

  it("the other series already pass untouched", () => {
    expect(contrast("#f5c518", CARD_BG)).toBeCloseTo(11.48, 1); // chart-2
    expect(contrast("#34c759", CARD_BG)).toBeGreaterThanOrEqual(4.5); // chart-5
    expect(contrast("#4a7dff", CARD_BG)).toBeGreaterThanOrEqual(4.5); // chart-4
  });

  it("only the red series is remapped (both spellings Recharts can hand us)", () => {
    expect(legendInk("var(--chart-1)")).toBe(LEGEND_RED_INK);
    expect(legendInk("#ed1c24")).toBe(LEGEND_RED_INK);
    expect(legendInk("#ED1C24")).toBe(LEGEND_RED_INK);
    expect(legendInk("var(--chart-4)")).toBe("var(--chart-4)");
    expect(legendInk("var(--chart-2)")).toBe("var(--chart-2)");
    expect(legendInk("#4078c9")).toBe("#4078c9"); // API team colour untouched
  });

  it("Race legends route the text through legendInk; Season's legend is not red", () => {
    const race = readFileSync(new URL("../../src/views/Race.tsx", import.meta.url), "utf8");
    expect(race.match(/formatter=\{legendText\}/g)).toHaveLength(3);
    expect(race).toMatch(/legendInk\(String\(entry\.color/);
    // Season's championship legend labels are text-muted-foreground (#8a8a93
    // = 5.47:1 on the card) — colour appears only as the swatch, so it never
    // needed the tint. Assert it stays that way.
    const season = readFileSync(new URL("../../src/views/Season.tsx", import.meta.url), "utf8");
    const legendBtn = season.slice(
      season.indexOf('data-testid="champ-legend"'),
      season.indexOf("No drivers match"),
    );
    expect(legendBtn).toMatch(/text-\[11px\] transition-opacity hover:text-foreground/);
    expect(legendBtn).toMatch(/\? " text-foreground" : " text-muted-foreground"/);
    expect(contrast("#8a8a93", CARD_BG)).toBeGreaterThanOrEqual(4.5);
  });
});
