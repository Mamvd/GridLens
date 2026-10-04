#!/usr/bin/env node
// tests/e2e/deterministic.mjs — Playwright suite with OpenF1 route fixtures.
// MUST pass with no network access to api.openf1.org.
// Usage: npm run e2e  (builds if dist/index.html missing)

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  YEAR, MONACO_SLUG, EXPECTED_CHAMPIONSHIP, installFixtures,
} from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = "/usr/bin/chromium-browser";

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitHttp = async (url, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* up? */ }
    await sleep(200);
  }
  return false;
};

const results = [];
const report = (name, status, detail = "") => {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pass = (n, d = "") => report(n, "PASS", d);
const fail = (n, d) => report(n, "FAIL", d);

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const urlPath = (page) => new URL(page.url()).pathname;

const waitText = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout, polling: 300 })
    .then(() => true).catch(() => false);

const main = async () => {
  if (!existsSync(path.join(ROOT, "dist/index.html"))) {
    console.log("dist/index.html missing — running npm run build…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const killPreview = () => { try { preview.kill("SIGTERM"); } catch { /* dead */ } };
  process.on("exit", killPreview);
  preview.on("error", (e) => { console.error("preview spawn failed:", e.message); process.exit(1); });
  if (!(await waitHttp(`${origin}/`, 30000))) {
    console.error(`vite preview did not come up on ${origin}`);
    killPreview();
    process.exit(1);
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

  try {
    // 1. season renders — championship numbers = fixture sums
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "domcontentloaded" });
      const ok = await waitText(page, "Verstappen");
      if (!ok) {
        fail("1. season championship table renders", `body: ${(await bodyText(page)).slice(0, 200)}`);
      } else {
        let allMatch = true;
        const bad = [];
        // A2 adds sr-only chart tables carrying driver names + numbers —
        // scope to the visible drivers table (skip .sr-only).
        const visibleTables = page.locator("table:not(.sr-only)");
        for (const row of EXPECTED_CHAMPIONSHIP) {
          const tr = visibleTables.locator("tbody tr", { hasText: row.name }).first();
          if (!(await tr.count())) { allMatch = false; bad.push(`${row.name}: missing`); continue; }
          const cells = await tr.locator("td").allInnerTexts();
          // Driver | Final team | Pts | Wins | Podiums | DNF
          if (cells[2] !== String(row.pts) || cells[3] !== String(row.wins) || cells[4] !== String(row.podiums)) {
            allMatch = false;
            bad.push(`${row.name}: got pts=${cells[2]} wins=${cells[3]} podiums=${cells[4]}`);
          }
        }
        if (allMatch) pass("1. season championship table renders", "pts/wins/podiums match fixtures");
        else fail("1. season championship table renders", bad.join("; "));
        // T5: column header renamed
        const header = await visibleTables.locator("thead").first().innerText();
        if (header.includes("Final team")) pass("1b. drivers table header is 'Final team'");
        else fail("1b. drivers table header is 'Final team'", header.replace(/\n/g, "|"));
        // T4: "All" range shows every driver (6), not a 20-cap leftover
        await page.getByRole("button", { name: "All", exact: true }).click();
        await sleep(400);
        const legendCount = await page.locator('[data-testid="champ-legend"] button').count();
        if (legendCount === EXPECTED_CHAMPIONSHIP.length) pass("1c. 'All' range lists every driver", `${legendCount} legend buttons`);
        else fail("1c. 'All' range lists every driver", `legend=${legendCount}`);
        // T10: sr-only chart summaries reach the DOM
        const srCount = await page.locator("p.sr-only").count();
        const srText = await page.locator("p.sr-only").allInnerTexts();
        if (srCount >= 3 && srText.some((t) => /championship points/i.test(t))) {
          pass("1d. sr-only chart summaries present in DOM", `${srCount} sr-only paragraphs`);
        } else fail("1d. sr-only chart summaries present in DOM", `count=${srCount}`);
        // T5 sprint note
        const t = await bodyText(page);
        if (/Sprint points merged/i.test(t)) pass("1e. sprint-merge note on championship chart");
        else fail("1e. sprint-merge note on championship chart");
      }
      await ctx.close();
    }

    // 2. race tabs render from fixtures
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();
      const base = `${origin}/race/${YEAR}/${MONACO_SLUG}`;

      await page.goto(`${base}/pace`, { waitUntil: "domcontentloaded" });
      const paceOk = (await waitText(page, "Verstappen")) && (await waitText(page, "Sector"));
      if (paceOk) pass("2a. Pace tab renders from fixtures");
      else fail("2a. Pace tab renders from fixtures", (await bodyText(page)).slice(0, 200));

      await page.goto(`${base}/gaps`, { waitUntil: "domcontentloaded" });
      const gapsOk = (await waitText(page, "Gap to Car Ahead")) && (await waitText(page, "Leclerc"));
      if (gapsOk) pass("2b. Gaps tab renders from fixtures");
      else fail("2b. Gaps tab renders from fixtures", (await bodyText(page)).slice(0, 200));

      await page.goto(`${base}/strategy`, { waitUntil: "domcontentloaded" });
      const stratOk = (await waitText(page, "Driver Strategies")) && (await waitText(page, "SOFT"));
      if (stratOk) pass("2c. Strategy tab renders stint compounds");
      else fail("2c. Strategy tab renders stint compounds", (await bodyText(page)).slice(0, 200));

      // expanded detail loads on demand — scope to the strategy row button
      // (a bare button[aria-expanded] can hit Radix Select triggers)
      await page.getByRole("button", { name: /Verstappen/ }).first().click();
      const detailOk = await waitText(page, "Fastest lap");
      if (detailOk) pass("2d. strategy detail panel loads on expand");
      else fail("2d. strategy detail panel loads on expand", (await bodyText(page)).slice(0, 300));

      await page.goto(`${base}/pit`, { waitUntil: "domcontentloaded" });
      const pitOk = (await waitText(page, "Pit Stop Times")) && (await waitText(page, "Overtakes Made"));
      if (pitOk) pass("2e. Pit tab renders from fixtures");
      else fail("2e. Pit tab renders from fixtures", (await bodyText(page)).slice(0, 200));

      await ctx.close();
    }

    // 3. routing — deep links, invalid route, tab redirect
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();

      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      // `/` is now the Landing page (no redirect) — season is reached via its CTA (9b)
      const landed = await waitText(page, "built on OpenF1 data", 10000);
      if (urlPath(page) === "/" && landed) pass("3a. / renders Landing (no redirect)");
      else fail("3a. / renders Landing (no redirect)", `${urlPath(page)} landed=${landed}`);

      await page.goto(`${origin}/bogus`, { waitUntil: "domcontentloaded" });
      if (await waitText(page, "Not found")) pass("3b. /bogus shows Not found");
      else fail("3b. /bogus shows Not found", urlPath(page));

      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}`, { waitUntil: "domcontentloaded" });
      try { await page.waitForURL((u) => u.pathname.endsWith("/pace"), { timeout: 10000 }); } catch { /* below */ }
      if (urlPath(page).endsWith("/pace")) pass("3c. race URL without tab redirects to /pace");
      else fail("3c. race URL without tab redirects to /pace", urlPath(page));

      await page.goto(`${origin}/race/${YEAR}/not-a-gp/pace`, { waitUntil: "domcontentloaded" });
      if (await waitText(page, "Not found")) pass("3d. unknown race slug → Not found");
      else fail("3d. unknown race slug → Not found", (await bodyText(page)).slice(0, 150));

      await ctx.close();
    }

    // 4. loading → ready transition (slow first meetings response)
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx, { delayFirstMs: 1200 });
      const page = await ctx.newPage();
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "domcontentloaded" });
      const sawLoading = await waitText(page, "loading", 3000);
      const ready = await waitText(page, "Bahrain Grand Prix", 20000);
      if (sawLoading && ready) pass("4. loading status then calendar ready");
      else fail("4. loading status then calendar ready", `loading=${sawLoading} ready=${ready}`);
      await ctx.close();
    }

    // 5. error state — intervals 500 once → Gaps error card + Retry succeeds
    {
      const ctx = await browser.newContext();
      const failFirst = new Map([["intervals", 1]]);
      await installFixtures(ctx, { failFirst });
      const page = await ctx.newPage();
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/gaps`, { waitUntil: "domcontentloaded" });
      const errShown = await waitText(page, "Failed to load gap intervals", 20000);
      if (!errShown) {
        fail("5. gaps error card after 500", (await bodyText(page)).slice(0, 200));
      } else {
        pass("5a. gaps error card after 500");
        await page.getByRole("button", { name: "Retry" }).first().click();
        const recovered = await waitText(page, "Gap to Car Ahead", 20000);
        if (recovered) pass("5b. Retry recovers gaps tab");
        else fail("5b. Retry recovers gaps tab", (await bodyText(page)).slice(0, 200));
      }
      await ctx.close();
    }

    // 6. empty state — session_result rows absent → "No results yet."
    {
      const ctx = await browser.newContext();
      await ctx.route("**/api.openf1.org/**", async (route) => {
        const url = route.request().url();
        const resource = new URL(url).pathname.split("/").filter(Boolean).pop();
        if (resource === "session_result") {
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          return;
        }
        const { resolveFixture } = await import("./fixtures.mjs");
        const { status, body } = resolveFixture(url);
        await route.fulfill({ status, contentType: "application/json", body });
      });
      const page = await ctx.newPage();
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "domcontentloaded" });
      const ok = await waitText(page, "No results yet", 20000);
      if (ok) pass("6. empty session_result → 'No results yet.'");
      else fail("6. empty session_result → 'No results yet.'", (await bodyText(page)).slice(0, 200));
      await ctx.close();
    }

    // 7. console-error audit — fixtures are valid; no bundle errors allowed
    {
      const issues = [];
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();
      page.on("pageerror", (err) => issues.push(String(err?.message ?? err)));
      page.on("console", (msg) => { if (msg.type() === "error") issues.push(msg.text()); });
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Verstappen", 20000);
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/strategy`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Driver Strategies", 20000);
      if (issues.length === 0) pass("7. console clean on fixture-driven season + race");
      else fail("7. console clean on fixture-driven season + race", issues.slice(0, 5).join(" | "));
      await ctx.close();
    }

    // 8. URL state (UX-02) + accessible names (A1) + legends/copy (UX-06/07)
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();

      // 8a. season deep link: range=top5 → 5 legend buttons; q=lec → only Leclerc
      await page.goto(`${origin}/season/${YEAR}?range=top5`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Verstappen", 20000);
      await sleep(400);
      let legendCount = await page.locator('[data-testid="champ-legend"] button').count();
      if (legendCount === 5) pass("8a. ?range=top5 deep link caps legend at 5");
      else fail("8a. ?range=top5 deep link caps legend at 5", `legend=${legendCount}`);

      await page.goto(`${origin}/season/${YEAR}?range=all&q=lecl`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Verstappen", 20000);
      await sleep(400);
      const legendText = await page.locator('[data-testid="champ-legend"]').innerText();
      if (legendText.includes("Leclerc") && !legendText.includes("Norris")) {
        pass("8b. ?q=lecl deep link filters the legend");
      } else fail("8b. ?q=lecl deep link filters the legend", legendText.replace(/\n/g, "|"));

      // 8c. race deep link: ?driver=55 selects Sainz (not the P1 default)
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace?driver=55`, { waitUntil: "domcontentloaded" });
      const sawSainz = await waitText(page, "Carlos Sainz", 20000);
      const driverTrigger = page.getByRole("combobox", { name: "Driver" }).first();
      const triggerText = await driverTrigger.innerText().catch(() => "");
      if (sawSainz && triggerText.includes("Sainz")) {
        pass("8c. ?driver=55 deep link selects Sainz on Pace");
      } else fail("8c. ?driver=55 deep link selects Sainz on Pace", `trigger="${triggerText}"`);

      // 8d. invalid ?driver=999 → P1 default (Verstappen) on load
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace?driver=999`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Verstappen", 20000);
      await sleep(400);
      const invalidTrigger = await page.getByRole("combobox", { name: "Driver" }).first().innerText().catch(() => "");
      if (invalidTrigger.includes("Verstappen")) {
        pass("8d. invalid ?driver falls back to P1 default");
      } else fail("8d. invalid ?driver falls back to P1 default", `trigger="${invalidTrigger}"`);

      // 8e. tab switch carries ?driver= in the URL (shareable across tabs)
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace?driver=55&compare=4`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Carlos Sainz", 20000);
      await page.getByRole("tab", { name: "Gaps" }).click();
      await page.waitForURL((u) => u.pathname.endsWith("/gaps"), { timeout: 10000 });
      await waitText(page, "Gap to Car Ahead", 20000);
      const gapsUrl = page.url();
      if (gapsUrl.includes("driver=55") && gapsUrl.includes("compare=4")) {
        pass("8e. tab change preserves driver/compare query params");
      } else fail("8e. tab change preserves driver/compare query params", gapsUrl);

      // 8f. A1: named comboboxes (Gaps: Driver + Compare driver; header Season)
      const named = await Promise.all([
        page.getByRole("combobox", { name: "Driver" }).count(),
        page.getByRole("combobox", { name: "Compare driver" }).count(),
        page.getByRole("combobox", { name: "Season" }).count(),
      ]);
      if (named[0] >= 1 && named[1] >= 1 && named[2] === 1) {
        pass("8f. A1 named comboboxes (Driver, Compare driver, Season)", named.join("/"));
      } else fail("8f. A1 named comboboxes (Driver, Compare driver, Season)", named.join("/"));

      // 8g. UX-07: fastest-lap text names the driver
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace`, { waitUntil: "domcontentloaded" });
      await waitText(page, "fastest lap", 20000);
      const paceText = await bodyText(page);
      if (/Verstappen fastest lap \d/.test(paceText)) pass("8g. UX-07 fastest lap names the driver");
      else fail("8g. UX-07 fastest lap names the driver", paceText.slice(0, 300));

      // 8h. UX-06: overtakes chart exposes a legend (Made / Lost swatches)
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pit`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Overtakes Made", 20000);
      await sleep(400);
      const legends = await page.locator(".recharts-legend-wrapper").count();
      const legendItems = await page.locator(".recharts-legend-item").allInnerTexts();
      if (legends >= 1 && legendItems.includes("Made") && legendItems.includes("Lost")) {
        pass("8h. UX-06 overtakes legend visible (Made/Lost)", legendItems.join("|"));
      } else fail("8h. UX-06 overtakes legend visible (Made/Lost)", `wrappers=${legends} items=${legendItems.join("|")}`);

      // 8i. A2: sr-only chart data table exposes driver names + values
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Sector Times", 20000);
      await sleep(400);
      const srTables = await page.locator('table.sr-only[aria-label="Chart data table"]').count();
      // innerText lies for clipped (sr-only) nodes — read textContent
      const srTableText = srTables > 0
        ? await page.locator('table.sr-only[aria-label="Chart data table"]').first().evaluate((el) => el.textContent ?? "")
        : "";
      if (srTables >= 1 && /Sector 1/.test(srTableText) && /\d+\.\d{3}/.test(srTableText)) {
        pass("8i. A2 sr-only data table exposes series + values", `${srTables} table(s)`);
      } else fail("8i. A2 sr-only data table exposes series + values", `tables=${srTables} text=${srTableText.slice(0, 120)}`);

      // 8j. UX-02 write direction: selection → URL → reload reproduces the view
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Sector Times", 20000);
      await page.getByRole("combobox", { name: "Driver" }).first().click();
      await page.getByRole("option", { name: "Carlos Sainz" }).click();
      await sleep(400);
      const afterSelect = page.url();
      if (!afterSelect.includes("driver=55")) {
        fail("8j. driver selection writes ?driver= to the URL", afterSelect);
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
        const reloadedOk = await waitText(page, "Carlos Sainz", 20000);
        await sleep(300);
        const reTrigger = await page.getByRole("combobox", { name: "Driver" }).first().innerText().catch(() => "");
        if (reloadedOk && reTrigger.includes("Sainz")) {
          pass("8j. selection → URL → reload reproduces the view");
        } else fail("8j. selection → URL → reload reproduces the view", `trigger="${reTrigger}"`);
      }

      // 8k. UX-02 season: range click → URL → reload keeps the range
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Verstappen", 20000);
      await page.getByRole("button", { name: "Top 5", exact: true }).click();
      await sleep(500); // debounced URL write
      if (!page.url().includes("range=top5")) {
        fail("8k. range click writes ?range= to the URL", page.url());
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitText(page, "Verstappen", 20000);
        await sleep(400);
        const rc = await page.locator('[data-testid="champ-legend"] button').count();
        if (rc === 5) pass("8k. range click → URL → reload keeps range=top5");
        else fail("8k. range click → URL → reload keeps range=top5", `legend=${rc}`);
      }

      await ctx.close();
    }

    // 9. landing page: zero API traffic, single h1, CTA → season, Back → landing
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx);
      const page = await ctx.newPage();
      let apiHits = 0;
      const issues = [];
      page.on("request", (r) => { if (r.url().includes("api.openf1.org")) apiHits++; });
      page.on("pageerror", (err) => issues.push(String(err?.message ?? err)));
      page.on("console", (msg) => { if (msg.type() === "error") issues.push(msg.text()); });

      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      const heroOk = await waitText(page, "built on OpenF1 data", 10000);
      await sleep(800); // give an eager fetch time to appear in the counter
      const h1c = await page.locator("h1").count();
      if (heroOk && apiHits === 0 && h1c === 1) {
        pass("9a. landing hero + 0 openf1 requests + exactly one h1", `hits=${apiHits} h1=${h1c}`);
      } else {
        fail("9a. landing hero + 0 openf1 requests + exactly one h1", `hero=${heroOk} hits=${apiHits} h1=${h1c}`);
      }

      // primary CTA → first available year (2026) → Season renders
      await page.getByRole("link", { name: /Explore 2026 season/ }).click();
      let ctaOk = false;
      try { await page.waitForURL((u) => u.pathname === "/season/2026", { timeout: 10000 }); ctaOk = true; } catch { /* below */ }
      const seasonOk = ctaOk && (await waitText(page, "No races found for 2026.", 20000));
      if (seasonOk) pass("9b. primary CTA → /season/2026, Season renders");
      else fail("9b. primary CTA → /season/2026, Season renders", `url=${urlPath(page)} cta=${ctaOk} season=${seasonOk}`);

      // browser Back → landing, still no API traffic
      const before = apiHits;
      await page.goBack({ waitUntil: "domcontentloaded" });
      const backOk = await waitText(page, "built on OpenF1 data", 10000);
      await sleep(500);
      if (backOk && urlPath(page) === "/" && apiHits === before) {
        pass("9c. Back → landing visible, 0 new openf1 requests", `hits=${apiHits}`);
      } else {
        fail("9c. Back → landing visible, 0 new openf1 requests", `path=${urlPath(page)} back=${backOk} hits=${apiHits} (was ${before})`);
      }

      // direct deep link + refresh (fixtures YEAR=2024)
      await page.goto(`${origin}/season/2024`, { waitUntil: "domcontentloaded" });
      const deep1 = await waitText(page, "Bahrain Grand Prix", 20000);
      await page.reload({ waitUntil: "domcontentloaded" });
      const deep2 = await waitText(page, "Bahrain Grand Prix", 20000);
      if (deep1 && deep2) pass("9d. /season/2024 deep link + refresh");
      else fail("9d. /season/2024 deep link + refresh", `load=${deep1} refresh=${deep2}`);

      if (issues.length === 0) pass("9e. console clean on landing + season + back");
      else fail("9e. console clean on landing + season + back", issues.slice(0, 5).join(" | "));
      await ctx.close();
    }
  } finally {
    await browser.close();
    killPreview();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.filter((r) => r.status === "PASS").length} PASS, ${failed.length} FAIL (deterministic, no live API)`);
  // always exit explicitly — the spawned vite preview keeps stdio handles open,
  // so a clean natural exit never drains the event loop
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
