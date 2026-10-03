#!/usr/bin/env node
// chart-select-check.mjs — championship chart selection + colours (#15).
// Recipe: tsc chart-select.ts → CJS (pure, no imports).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "/tmp/chartselect";
execFileSync("node_modules/.bin/tsc", [
  "src/lib/chart-select.ts",
  "--ignoreConfig", "--ignoreDeprecations", "6.0",
  "--module", "commonjs", "--target", "es2022",
  "--esModuleInterop", "--skipLibCheck",
  "--rootDir", "src", "--outDir", OUT,
], { cwd: ROOT, stdio: "pipe" });

const require = createRequire(import.meta.url);
const libPath = [`${OUT}/lib/chart-select.js`, `${OUT}/chart-select.js`].find(existsSync);
if (!libPath) throw new Error(`compiled chart-select.js not found under ${OUT}`);
const {
  rangeLimit, matchesSearch, chartSelect, teammateDashed, resolveTeamColours,
  fallbackPalette, ensureVisible, relativeLuminance, FALLBACK_HUES,
} = require(libPath);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

const ORDER = [
  "Max Verstappen", "Lando Norris", "Charles Leclerc", "Oscar Piastri",
  "George Russell", "Carlos Sainz", "Fernando Alonso", "Pierre Gasly",
  "Esteban Ocon", "Yuki Tsunoda", "José López", "Alex Albon",
];

// --- range limits ---
check("rangeLimit: top5→5, top10→10, all→Infinity", () => {
  assert.equal(rangeLimit("top5"), 5);
  assert.equal(rangeLimit("top10"), 10);
  assert.equal(rangeLimit("all"), Number.POSITIVE_INFINITY);
});

check("chartSelect: top5/top10/all cap the points-order pool", () => {
  const base = { search: "", hidden: new Set(), focus: null };
  const t5 = chartSelect({ ...base, order: ORDER, range: "top5" });
  assert.deepEqual(t5.visible, ORDER.slice(0, 5));
  const t10 = chartSelect({ ...base, order: ORDER, range: "top10" });
  assert.deepEqual(t10.visible, ORDER.slice(0, 10));
  const all = chartSelect({ ...base, order: ORDER, range: "all" });
  assert.deepEqual(all.visible, [...ORDER]);
});

// --- search: case + diacritic ---
check("matchesSearch: case-insensitive", () => {
  assert.equal(matchesSearch("Max Verstappen", "verst"), true);
  assert.equal(matchesSearch("Max Verstappen", "VERST"), true);
  assert.equal(matchesSearch("Max Verstappen", "norris"), false);
});

check("matchesSearch: diacritic-insensitive both directions", () => {
  assert.equal(matchesSearch("José López", "josé"), true);
  assert.equal(matchesSearch("José López", "JOSE"), true);
  assert.equal(matchesSearch("José Lopez", "jose"), true);
  assert.equal(matchesSearch("José López", "lo'pez"), false);
});

check("matchesSearch: empty/whitespace query matches everything", () => {
  assert.equal(matchesSearch("Anyone", ""), true);
  assert.equal(matchesSearch("Anyone", "   "), true);
});

check("chartSelect: search filters within range (out-of-range match stays out)", () => {
  const base = { range: "top5", hidden: new Set(), focus: null };
  const hit = chartSelect({ ...base, order: ORDER, search: "leclerc" });
  assert.deepEqual(hit.visible, ["Charles Leclerc"]);
  const outside = chartSelect({ ...base, order: ORDER, search: "josé" }); // rank 11
  assert.deepEqual(outside.visible, []);
  const none = chartSelect({ ...base, order: ORDER, search: "hamilton" });
  assert.deepEqual(none.visible, []);
});

// --- hidden persistence + focus isolation ---
check("chartSelect: hidden drivers stay out across range/search changes", () => {
  const hidden = new Set(["Lando Norris", "José López"]);
  const a = chartSelect({ order: ORDER, range: "top10", search: "", hidden, focus: null });
  assert.ok(!a.visible.includes("Lando Norris"), "hidden Norris out at top10");
  assert.ok(!a.visible.includes("José López"), "hidden López out at top10");
  const b = chartSelect({ order: ORDER, range: "all", search: "norris", hidden, focus: null });
  assert.deepEqual(b.visible, [], "search for hidden driver → empty, not a resurrection");
  const c = chartSelect({ order: ORDER, range: "all", search: "", hidden, focus: null });
  assert.ok(!c.visible.includes("Lando Norris"), "hidden persists at all-range");
  assert.ok(c.visible.includes("Max Verstappen"), "others unaffected");
});

check("chartSelect: focus isolation — focus kept only when visible", () => {
  const on = chartSelect({ order: ORDER, range: "top10", search: "", hidden: new Set(), focus: "George Russell" });
  assert.equal(on.focus, "George Russell");
  const hiddenFocus = chartSelect({ order: ORDER, range: "top5", search: "", hidden: new Set(["George Russell"]), focus: "George Russell" });
  assert.equal(hiddenFocus.focus, null, "hidden focus collapses to null");
  const outOfRange = chartSelect({ order: ORDER, range: "top5", search: "", hidden: new Set(), focus: "José López" });
  assert.equal(outOfRange.focus, null, "out-of-range focus collapses to null");
  const noFocus = chartSelect({ order: ORDER, range: "top10", search: "", hidden: new Set(), focus: null });
  assert.equal(noFocus.focus, null);
});

check("chartSelect: visible preserves points order", () => {
  const r = chartSelect({ order: ORDER, range: "all", search: "", hidden: new Set(["Oscar Piastri"]), focus: null });
  const expect = ORDER.filter((n) => n !== "Oscar Piastri");
  assert.deepEqual(r.visible, expect);
});

// --- teammate dash ---
check("teammateDashed: second driver per team dashed, first never", () => {
  const entries = [
    { name: "A1", team: "TeamX" }, { name: "B1", team: "TeamY" },
    { name: "A2", team: "TeamX" }, { name: "B2", team: "TeamY" },
    { name: "C1", team: "TeamZ" },
  ];
  const dashed = teammateDashed(entries);
  assert.deepEqual([...dashed].sort(), ["A2", "B2"]);
  assert.ok(!dashed.has("A1") && !dashed.has("B1") && !dashed.has("C1"));
});

// --- fallback palette ---
check("fallbackPalette: deterministic across input order", () => {
  const teams = ["Red Bull Racing", "Ferrari", "McLaren", "Mercedes", "Haas"];
  const a = fallbackPalette(teams);
  const b = fallbackPalette([...teams].reverse());
  assert.deepEqual(a, b, "same team set → same mapping regardless of order");
  assert.equal(fallbackPalette(teams)["Ferrari"], a["Ferrari"]);
});

check("fallbackPalette: ≤10 teams get unique hues from the validated set", () => {
  const teams = Array.from({ length: 10 }, (_, i) => `Team ${i}`);
  const p = fallbackPalette(teams);
  const hues = Object.values(p);
  assert.equal(new Set(hues).size, 10, "all 10 slots distinct");
  for (const h of hues) assert.ok([...FALLBACK_HUES].includes(h), `${h} not in FALLBACK_HUES`);
});

check("fallbackPalette: duplicate team names collapse to one entry", () => {
  const p = fallbackPalette(["Ferrari", "Ferrari", "McLaren"]);
  assert.equal(Object.keys(p).length, 2);
  assert.equal(p["Ferrari"], p["Ferrari"]);
});

// --- team colour resolution ---
check("resolveTeamColours: first points-order driver with a colour wins, teammates share", () => {
  const entries = [
    { name: "A1", team: "TeamX" }, { name: "A2", team: "TeamX" },
    { name: "B1", team: "TeamY" }, { name: "B2", team: "TeamY" },
  ];
  const cols = { A1: "3672E4", B2: "00A19B" }; // TeamY leader has no colour
  const out = resolveTeamColours(entries, cols);
  assert.equal(out["TeamX"], "3672E4");
  assert.equal(out["TeamY"], "00A19B", "falls to teammate's colour");
  assert.ok(!("TeamZ" in resolveTeamColours(entries, {})));
});

// --- ensureVisible / dark-surface floor ---
check("ensureVisible: near-black #000000 lifts above the dark-surface floor", () => {
  const out = ensureVisible("#000000");
  assert.ok(out, "must not be null");
  assert.notEqual(out, "#000000", "must be lightened");
  assert.match(out, /^#[0-9a-f]{6}$/i);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(out);
  const lum = relativeLuminance(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
  assert.ok(lum >= 0.17, `luminance ${lum.toFixed(3)} < 0.17 floor`);
});

check("ensureVisible: already-visible colours pass through untouched", () => {
  assert.equal(ensureVisible("#3987e5"), "#3987e5");
  assert.equal(ensureVisible("#e8002d"), "#e8002d"); // Ferrari red ≈0.175 ≥ floor
});

check("ensureVisible: RRGGBB without # normalized; invalid → null", () => {
  assert.equal(ensureVisible("3987e5"), "#3987e5");
  assert.equal(ensureVisible(""), null);
  assert.equal(ensureVisible("#fff"), null, "3-digit hex unsupported → fallback");
  assert.equal(ensureVisible("not-a-colour"), null);
  assert.equal(ensureVisible("#12345g"), null);
});

if (failed) {
  console.log(`\n${failed} scenario(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
