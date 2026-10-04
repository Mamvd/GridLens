#!/usr/bin/env node
// ad-hoc visual/measurement proof for PF-08 / PF-03 / UX-03 / UX-04 / NF-03
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { YEAR, MONACO_SLUG, installFixtures, resolveFixture } from "./fixtures.mjs";

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
const waitText = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout, polling: 300 })
    .then(() => true).catch(() => false);

const main = async () => {
  if (!existsSync(path.join(ROOT, "dist/index.html"))) {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }

  // PF-08: vercel.json config inspection
  {
    const v = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
    const assets = v.headers?.find((h) => h.source === "/assets/(.*)");
    const imm = assets?.headers?.find((x) => x.key === "Cache-Control")?.value;
    const root = v.headers?.find((h) => h.source === "/(.*)");
    const rootCC = root?.headers?.find((x) => x.key === "Cache-Control")?.value;
    const rewrite = v.rewrites?.some((r) => r.source === "/(.*)" && r.destination === "/index.html");
    if (imm === "public, max-age=31536000, immutable" && rootCC === "public, max-age=0, must-revalidate" && rewrite) {
      pass("PF-08 vercel.json headers", `assets=${imm}; html=${rootCC}; rewrite kept`);
    } else {
      fail("PF-08 vercel.json headers", JSON.stringify({ imm, rootCC, rewrite }));
    }
  }

  // PF-03: chunk split measurement
  {
    const assetsDir = path.join(ROOT, "dist/assets");
    const js = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    const gz = (f) => gzipSync(readFileSync(path.join(assetsDir, f))).length;
    const main = js.map((f) => ({ f, raw: readFileSync(path.join(assetsDir, f)).length, gz: gz(f) }))
      .sort((a, b) => b.raw - a.raw);
    const hasRace = js.some((f) => f.startsWith("Race-"));
    const hasSeason = js.some((f) => f.startsWith("Season-"));
    // initial chunk = what index.html's modulepreload/main script loads
    const html = readFileSync(path.join(ROOT, "dist/index.html"), "utf8");
    const entry = html.match(/assets\/(index-[^"]+\.js)/)?.[1];
    const entryGz = entry ? gz(entry) : Infinity;
    if (js.length > 2 && hasRace && hasSeason) {
      pass("PF-03 route code-split", js.length + " JS files; " + main.map((m) => `${m.f} ${m.raw}B gz ${m.gz}B`).join(", "));
    } else {
      fail("PF-03 route code-split", js.join(", "));
    }
    if (entryGz < 150 * 1024) pass("PF-03 initial chunk gzip <150 KB", `${entry} gz ${entryGz} B`);
    else fail("PF-03 initial chunk gzip <150 KB", `${entry} gz ${entryGz} B`);
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const killPreview = () => { try { preview.kill("SIGTERM"); } catch { /* dead */ } };
  process.on("exit", killPreview);
  if (!(await waitHttp(`${origin}/`, 30000))) { console.error("preview down"); process.exit(1); }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

  try {
    // UX-03: cold load at t≈1s shows "Loading calendar…" + year-switch label
    {
      const ctx = await browser.newContext();
      // delay EVERY meetings response so both cold load and year-switch hold the skeleton
      await ctx.route("**/api.openf1.org/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/meetings")) await new Promise((r) => setTimeout(r, 2500));
        const { status, body } = resolveFixture(url);
        await route.fulfill({ status, contentType: "application/json", body });
      });
      const page = await ctx.newPage();
      await page.goto(`${origin}/season/${YEAR}`, { waitUntil: "commit" });
      await sleep(1000);
      const txt = await bodyText(page);
      const role = await page.locator('[role="status"]').count();
      if (txt.includes("Loading calendar…") && role > 0) {
        pass("UX-03 cold load label at t=1s", `role=status x${role}: "Loading calendar…"`);
        await page.screenshot({ path: "/tmp/ux03-cold-load.png" });
      } else {
        fail("UX-03 cold load label at t=1s", txt.slice(0, 150));
      }
      // wait ready, then SPA year-switch via header Select → skeleton label again
      const ready = await waitText(page, "Grand Prix", 30000);
      let switchLabel = false;
      if (ready) {
        const otherYear = YEAR === 2024 ? 2026 : 2024;
        await page.locator('header button[role="combobox"]').click();
        await page.locator(`[role="option"]:has-text("${otherYear}")`).first().click();
        switchLabel = await waitText(page, "Loading calendar…", 5000);
        if (switchLabel) await page.screenshot({ path: "/tmp/ux03-year-switch.png" });
      }
      if (switchLabel) pass("UX-03 year-switch label");
      else fail("UX-03 year-switch label", `ready=${ready}`);
      await ctx.close();
    }

    // UX-04: race base failure keeps header + tabs + error + Retry
    {
      const ctx = await browser.newContext();
      const failFirst = new Map([["session_result", 99], ["drivers", 99]]);
      await installFixtures(ctx, { failFirst });
      const page = await ctx.newPage();
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace`, { waitUntil: "domcontentloaded" });
      const ok = await waitText(page, "Failed to load", 30000);
      const txt = ok ? await bodyText(page) : "";
      const tabs = await page.getByRole("tab").count();
      const retry = await page.getByRole("button", { name: "Retry" }).count();
      const back = txt.includes("← Season") || await page.getByRole("button", { name: "← Season" }).count() > 0;
      if (ok && tabs === 4 && retry >= 1 && back) {
        pass("UX-04 base error keeps chrome", `tabs=${tabs}, Retry x${retry}, back-nav present`);
        await page.screenshot({ path: "/tmp/ux04-base-error.png" });
      } else {
        fail("UX-04 base error keeps chrome", `ok=${ok} tabs=${tabs} retry=${retry} back=${back} txt=${txt.slice(0, 200)}`);
      }
      // tab nav during error still works
      if (ok) {
        await page.getByRole("tab", { name: "Gaps" }).click();
        await sleep(600);
        const pathAfter = new URL(page.url()).pathname;
        if (pathAfter.endsWith("/gaps")) pass("UX-04 tab nav during error", pathAfter);
        else fail("UX-04 tab nav during error", pathAfter);
        // Retry recovers once failures burn out — flip: fresh context normal fixtures
      }
      await ctx.close();
    }

    // UX-04b: Retry recovers (failBase once, then 200)
    {
      const ctx = await browser.newContext();
      const failFirst = new Map([["session_result", 1]]);
      await installFixtures(ctx, { failFirst });
      const page = await ctx.newPage();
      await page.goto(`${origin}/race/${YEAR}/${MONACO_SLUG}/pace`, { waitUntil: "domcontentloaded" });
      const ok = await waitText(page, "Failed to load", 30000);
      let recovered = false;
      if (ok) {
        await page.getByRole("button", { name: "Retry" }).click();
        recovered = await waitText(page, "Sector Times", 30000) || await waitText(page, "Driver Strategies", 5000);
      }
      if (ok && recovered) pass("UX-04 Retry recovers");
      else fail("UX-04 Retry recovers", `ok=${ok} recovered=${recovered}`);
      await ctx.close();
    }

    // NF-03: rapid year-switch aborts old meetings request
    {
      const ctx = await browser.newContext();
      await installFixtures(ctx, { delayFirstMs: 4000 });
      const page = await ctx.newPage();
      const failures = [];
      page.on("requestfailed", (r) => {
        if (r.url().includes("/meetings")) failures.push(r.failure()?.errorText ?? "unknown");
      });
      await page.goto(`${origin}/season/2024`, { waitUntil: "commit" });
      await sleep(500);
      // SPA year-switch (header Select) → effect cleanup must abort in-flight meetings
      await page.locator('header button[role="combobox"]').click();
      await page.locator('[role="option"]:has-text("2026")').first().click();
      await sleep(1500);
      const aborted = failures.some((f) => /abort|ERR_ABORTED/i.test(f));
      if (aborted) pass("NF-03 year-switch aborts old meetings request", failures.join("; "));
      else fail("NF-03 year-switch aborts old meetings request", JSON.stringify(failures));
      await ctx.close();
    }
  } finally {
    await browser.close();
    killPreview();
  }

  const bad = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - bad.length} PASS/NOTE, ${bad.length} FAIL`);
  process.exit(bad.length ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
