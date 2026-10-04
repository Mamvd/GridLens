import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Source-level asserts (node env, no renderer): the Landing view must derive
// its season links from lib/years, cover only real features, and carry the
// attribution footer; App.tsx must route `/` to it with zero API traffic.
const landingSrc = () =>
  readFileSync(new URL("../../src/views/Landing.tsx", import.meta.url), "utf8");
const appSrc = () =>
  readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

describe("Landing: season links derive from lib/years", () => {
  it("imports availableYears + MIN_DATA_YEAR (no hardcoded year floor)", () => {
    const src = landingSrc();
    expect(src).toMatch(/import \{ availableYears, MIN_DATA_YEAR \} from "\.\.\/lib\/years"/);
    expect(src).toMatch(/MIN_DATA_YEAR/);
  });

  it("no hardcoded year in any season href", () => {
    const src = landingSrc();
    expect(src).toMatch(/availableYears\(\)/);
    expect(src).toMatch(/YEARS\[0\]/); // primary CTA target
    expect(src).not.toMatch(/["'`]\/season\/20\d{2}["'`]/);
    expect(src).not.toMatch(/to=\{`\/season\/20\d{2}`\}/);
  });
});

describe("Landing: only existing features", () => {
  it("covers the six explore areas with real UI labels", () => {
    const src = landingSrc();
    for (const label of [
      "Championship standings",
      "Calendar",
      "Tyre strategy",
      "Pace",
      "Gaps",
      "Pit stops",
    ]) {
      expect(src).toContain(label);
    }
    // real chart/tab wording from Season.tsx / Race.tsx
    expect(src).toMatch(/Sprint points merged into their weekend's column/);
    expect(src).toMatch(/Sector Times/);
    expect(src).toMatch(/Interval to the car ahead/);
    expect(src).toMatch(/Pit Stop Times/);
  });

  it("links the season picker anchor used by the secondary CTA", () => {
    const src = landingSrc();
    expect(src).toMatch(/href="#seasons"/);
    expect(src).toMatch(/id="seasons"/);
  });
});

describe("Landing: attribution, disclaimer, a11y", () => {
  it("OpenF1 + GitHub links and the unofficial disclaimer", () => {
    const src = landingSrc();
    expect(src).toMatch(/href="https:\/\/openf1\.org"/);
    expect(src).toMatch(/href="https:\/\/github\.com\/Mamvd\/GridLens"/);
    expect(src).toMatch(/Not affiliated with Formula 1, the FIA, or any team\./);
  });

  it("exactly one h1 (hero), decorative SVG dimensioned + aria-hidden", () => {
    const src = landingSrc();
    expect(src.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(src).toMatch(/aria-hidden="true"/);
    expect(src).toMatch(/width="320"\s+height="72"/);
  });

  it("CTAs and season links clear the 40px touch target", () => {
    const src = landingSrc();
    expect(src.match(/min-h-11/g)!.length).toBeGreaterThanOrEqual(3); // 2 CTAs + season links
  });

  it("no lazy imports of Season/Race (landing ships in the entry chunk)", () => {
    const src = landingSrc();
    expect(src).not.toMatch(/lazy\(/);
    expect(src).not.toMatch(/views\/(Season|Race)/);
  });
});

describe("App: `/` wiring", () => {
  it("`/` renders Landing, season/race routes untouched", () => {
    const src = appSrc();
    expect(src).toMatch(/<Route path="\/" element=\{<Landing \/>} \/>/);
    expect(src).not.toMatch(/path="\/" element=\{<Navigate/);
    expect(src).toMatch(/<Route path="\/season\/:year"/);
    expect(src).toMatch(/path="\/race\/:year\/:slug\/:tab"/);
  });

  it("meetings effect skips on `/` and re-runs via the onLanding dep", () => {
    const src = appSrc();
    expect(src).toMatch(/location\.pathname === "\/"/); // pathname guard
    expect(src).toMatch(/if \(onLanding\) return;/);
    expect(src).toMatch(/\[onLanding, year, reloadKey\]/); // load on `/` → season
  });

  it("header brand is a Link to `/`; h1 only when not on the landing page", () => {
    const src = appSrc();
    expect(src).toMatch(/<Link to="\/" className=/);
    expect(src).toMatch(/onLanding \? \(/);
    expect(src).toMatch(/onLanding \? \([\s\S]*?<h1 className="text-\[17px\]/);
  });

  it("metadata effect sets title + description + canonical per route", () => {
    const src = appSrc();
    expect(src).toMatch(/meta\[name="description"\]/);
    expect(src).toMatch(/link\[rel="canonical"\]/);
    expect(src).toMatch(/\$\{window\.location\.origin\}\$\{path\}/);
    expect(src).toMatch(/GridLens — F1 Season & Race Explorer/);
    // season/race title outcomes unchanged
    expect(src).toMatch(/document\.title = title/);
  });
});
