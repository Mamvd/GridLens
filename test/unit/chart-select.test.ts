import { describe, it, expect } from "vitest";
import {
  rangeLimit, matchesSearch, chartSelect, teammateDashed, fallbackPalette, ensureVisible,
} from "../../src/lib/chart-select";

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
