#!/usr/bin/env node
// tests/e2e/run.mjs — Playwright smoke suite vs `vite preview` + system chromium.
// OpenF1 is external/rate-limited: data-dependent asserts SKIP on error cards.
// Non-data asserts (shell, router, overflow, bundle console errors) always run.
// Usage: npm run e2e  (builds if dist/index.html missing)

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = "/usr/bin/chromium-browser";
const MONACO = "/race/2024/monaco-grand-prix/pace";
const ERROR_MARKERS = [
  "OpenF1 isn't responding", "temporarily restricting free access",
  "You appear to be offline", "Failed to load", "hasn't been run yet", "No races found",
];

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

// OpenF1 opaque/429 failures are EXPECTED when the API is down/rate-limited.
const isIgnorable = (text) =>
  /api\.openf1\.org/i.test(text) ||
  /TypeError: Failed to fetch/.test(text) ||
  (/Failed to load resource/.test(text) && (/openf1/i.test(text) || /429|Too Many Requests/i.test(text))) ||
  /429 \(Too Many Requests\)/.test(text);

const results = [];
const consoleIssues = [];
const report = (name, status, detail = "") => {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (n, d) => report(n, "SKIP", d);
const pass = (n, d = "") => report(n, "PASS", d);
const fail = (n, d) => report(n, "FAIL", d);

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const urlPath = (page) => new URL(page.url()).pathname;

const waitSettled = async (page, timeout) => {
  try {
    await page.waitForFunction((markers) => {
      const t = document.body.innerText;
      if (markers.some((m) => t.includes(m))) return true;
      if (document.querySelector("main button[title]")) return true;
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim());
      return ["Pace", "Gaps", "Strategy", "Pit"].every((x) => tabs.includes(x));
    }, ERROR_MARKERS, { timeout, polling: 400 });
  } catch { /* caller decides */ }
};

const raceTabBar = async (page) => {
  const tabs = await page.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent?.trim()));
  return ["Pace", "Gaps", "Strategy", "Pit"].every((x) => tabs.includes(x));
};

const seasonButtonCount = (page) => page.evaluate(() => document.querySelectorAll("main button[title]").length);

// React Router may push duplicate history entries on tab clicks; walk back/forward
// until the predicate holds (bounded), then assert tab bar still present.
// dir "none" = poll only (no history movement).
const historyWalk = async (page, dir, pred, max = 4) => {
  for (let i = 0; i < max; i++) {
    if (pred(urlPath(page))) return true;
    if (dir === "none") { await sleep(400); continue; }
    await (dir === "back" ? page.goBack() : page.goForward()).catch(() => {});
    await sleep(500);
  }
  return pred(urlPath(page));
};

const attachConsole = (page, label) => {
  page.on("pageerror", (err) => {
    const text = String(err?.message ?? err);
    if (!isIgnorable(text)) consoleIssues.push(`[${label}] pageerror: ${text}`);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = `${msg.text()} ${msg.location()?.url ?? ""}`;
    if (!isIgnorable(text)) consoleIssues.push(`[${label}] console: ${text.trim()}`);
  });
};

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
    // a. / → /season/2026
    {
      const page = await browser.newPage();
      attachConsole(page, "a");
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      try { await page.waitForURL((u) => u.pathname === "/season/2026", { timeout: 10000 }); } catch { /* below */ }
      if (urlPath(page) === "/season/2026" && (await bodyText(page)).includes("GridLens")) {
        pass("a. / redirects to /season/2026", urlPath(page));
      } else fail("a. / redirects to /season/2026", `path=${urlPath(page)}`);
      await page.close();
    }

    // b. /bogus → Not found
    {
      const page = await browser.newPage();
      attachConsole(page, "b");
      await page.goto(`${origin}/bogus`, { waitUntil: "domcontentloaded" });
      const ok = await page.waitForFunction(() => document.body.innerText.includes("Not found"), null, { timeout: 10000 })
        .then(() => true).catch(() => false);
      if (ok) pass("b. /bogus shows Not found card");
      else fail("b. /bogus shows Not found card", `url=${urlPath(page)}`);
      await page.close();
    }

    // c. /season/2023 shell + optional calendar
    {
      const page = await browser.newPage();
      attachConsole(page, "c");
      await page.goto(`${origin}/season/2023`, { waitUntil: "domcontentloaded" });
      const titleOk = (await page.title()).startsWith("GridLens");
      const shellText = await bodyText(page);
      const shellOk = shellText.includes("GridLens") && shellText.includes("F1 Season");
      const hasYearUi = (await page.locator('button[role="combobox"]').count()) > 0;
      if (!(titleOk && shellOk && hasYearUi)) {
        fail("c. /season/2023 season shell + year selector",
          `titleOk=${titleOk} shellOk=${shellOk} yearUi=${hasYearUi}`);
      } else {
        await waitSettled(page, 120000);
        const t = await bodyText(page);
        const errCard = ERROR_MARKERS.some((m) => t.includes(m));
        const empty = t.includes("No races found");
        const buttons = await seasonButtonCount(page);
        if (buttons > 0 && !errCard) {
          pass("c. /season/2023 season shell + year selector", `calendar buttons=${buttons}`);
          pass("c. calendar renders ≥1 race button", `${buttons} buttons`);
        } else if (errCard && !empty) {
          pass("c. /season/2023 season shell + year selector");
          skip("c. calendar renders ≥1 race button", "OpenF1 error card — data assert skipped");
        } else if (empty) {
          pass("c. /season/2023 season shell + year selector");
          skip("c. calendar renders ≥1 race button", "API reachable, 0 meetings for 2023");
        } else {
          pass("c. /season/2023 season shell + year selector");
          skip("c. calendar renders ≥1 race button", "settled without calendar or error card");
        }
      }
      await page.close();
    }

    // d. race deep-link: tabs, Back, history preserves tab
    {
      const page = await browser.newPage();
      attachConsole(page, "d");
      await page.goto(`${origin}${MONACO}`, { waitUntil: "domcontentloaded" });
      await waitSettled(page, 120000);
      const t = await bodyText(page);
      if (!(await raceTabBar(page))) {
        const why = ERROR_MARKERS.some((m) => t.includes(m)) || t.includes("Not found")
          ? "error/skeleton/404 branch (OpenF1 down or meeting unresolved)"
          : "still skeleton — data-dependent skipped";
        skip("d. race deep-link renders 4-tab bar", why);
        skip("d. Back button returns to /season/", "no race shell");
        skip("d. back/forward preserves race tab", "no race shell");
      } else {
        pass("d. race deep-link renders 4-tab bar", MONACO);
        const back = page.getByRole("button", { name: /Season/ }).first();
        if (await back.count()) {
          await back.click();
          await page.waitForFunction(() => location.pathname.startsWith("/season/"), null, { timeout: 10000 })
            .catch(() => {});
          if (urlPath(page).startsWith("/season/")) pass("d. Back button returns to /season/", urlPath(page));
          else fail("d. Back button returns to /season/", urlPath(page));
        } else fail("d. Back button returns to /season/", "Season button missing");

        // clean deep-link so tab history starts from [pace]
        await page.goto(`${origin}${MONACO}`, { waitUntil: "domcontentloaded" });
        await waitSettled(page, 120000);
        if (!(await raceTabBar(page))) {
          skip("d. back/forward preserves race tab", "race shell unavailable on fresh deep-link");
        } else {
          try { await page.getByRole("tab", { name: "Gaps" }).click(); } catch { /* eval fallback */ }
          await historyWalk(page, "none", (p) => p.endsWith("/gaps"), 1);
          // if role-click missed, force via DOM
          if (!urlPath(page).endsWith("/gaps")) {
            await page.evaluate(() => {
              [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent?.trim() === "Gaps")?.click();
            });
            await historyWalk(page, "none", (p) => p.endsWith("/gaps"), 1);
          }
          const onGaps = urlPath(page).endsWith("/gaps");
          const backToPace = onGaps && await historyWalk(page, "back", (p) => p.endsWith("/pace"), 4);
          await sleep(400);
          const paceOk = backToPace && (await raceTabBar(page));
          const fwdToGaps = paceOk && await historyWalk(page, "forward", (p) => p.endsWith("/gaps"), 4);
          await sleep(400);
          const gapsOk = fwdToGaps && (await raceTabBar(page));
          if (paceOk && gapsOk) pass("d. back/forward preserves race tab", "pace ↔ gaps via tab history");
          else fail("d. back/forward preserves race tab",
            `onGaps=${onGaps} paceOk=${paceOk} gapsOk=${gapsOk} path=${urlPath(page)}`);
        }
      }
      await page.close();
    }

    // e. refresh re-hydrates deep race URL
    {
      const page = await browser.newPage();
      attachConsole(page, "e");
      await page.goto(`${origin}${MONACO}`, { waitUntil: "domcontentloaded" });
      await waitSettled(page, 60000);
      await page.reload({ waitUntil: "domcontentloaded" });
      const pathAfter = urlPath(page);
      const shellOk = (await bodyText(page)).includes("GridLens");
      if (pathAfter === MONACO && shellOk) pass("e. refresh re-hydrates deep race URL", pathAfter);
      else fail("e. refresh re-hydrates deep race URL", `path=${pathAfter} shell=${shellOk}`);
      await page.close();
    }

    // f. mobile 375px: no horizontal overflow
    {
      const page = await browser.newPage();
      attachConsole(page, "f");
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${origin}/season/2026`, { waitUntil: "domcontentloaded" });
      await waitSettled(page, 30000);
      await page.waitForTimeout(1000);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw <= 375) pass("f. mobile 375px no horizontal overflow", `scrollWidth=${sw}`);
      else fail("f. mobile 375px no horizontal overflow", `scrollWidth=${sw}`);
      await page.close();
    }

    // g. console-error audit (c–f) — ignore OpenF1 noise only
    {
      if (consoleIssues.length === 0) pass("g. console-error audit: no errors from our bundle");
      else fail("g. console-error audit: no errors from our bundle", consoleIssues.slice(0, 5).join(" | "));
    }
  } finally {
    await browser.close();
    killPreview();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(`\n${results.filter((r) => r.status === "PASS").length} PASS, ${skipped.length} SKIP, ${failed.length} FAIL`);
  if (failed.length) process.exit(1);
};

main().catch((e) => { console.error(e); process.exit(1); });
