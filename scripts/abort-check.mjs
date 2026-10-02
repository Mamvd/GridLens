// Assert-based check for AbortSignal threading in src/api/openf1.ts + the
// alive/year-scoped pattern used by App/Season/Race effects. No framework:
// run with `node scripts/abort-check.mjs` (Node 22 strips types natively).
import assert from "node:assert";

let unhandled = 0;
process.on("unhandledRejection", (e) => { unhandled++; console.error("UNHANDLED", e); });

// --- controllable fetch mock: every call parks until we settle it ---
const calls = [];
const pending = [];
globalThis.fetch = (url, opts = {}) =>
  new Promise((resolve, reject) => {
    const call = { url, opts, resolve, reject, settled: false };
    const settle = (fn, v) => { if (!call.settled) { call.settle = true; call.settled = true; fn(v); } };
    if (opts.signal) {
      if (opts.signal.aborted) { reject(new DOMException("Aborted", "AbortError")); call.settled = true; return; }
      opts.signal.addEventListener("abort", () => settle(reject, new DOMException("Aborted", "AbortError")), { once: true });
    }
    calls.push(call);
    pending.push(call);
  });

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
// fetch is reached after pLimit + the 500ms spacing gate — poll up to 3s
const takeCall = async () => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const c = pending.shift();
    if (c) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  return assert.fail("expected a pending fetch within 3s");
};
const { getOpenF1 } = await import("../src/api/openf1.ts");

// 1. pre-aborted signal: rejects without ever reaching fetch
{
  const c = new AbortController();
  c.abort();
  const before = calls.length;
  await assert.rejects(
    () => getOpenF1("meetings", { year: 2023 }, { signal: c.signal }),
    (e) => e.name === "AbortError",
  );
  assert.strictEqual(calls.length, before, "pre-aborted call must not fetch");
  console.log("PASS 1: pre-aborted → AbortError, no fetch");
}

// 2. in-flight abort rejects with AbortError AND frees the pLimit slot
{
  const c = new AbortController();
  const p = getOpenF1("meetings", { year: 2023 }, { signal: c.signal });
  await takeCall(); // in-flight
  c.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  // slot must be free: a fresh request reaches fetch immediately after
  const p2 = getOpenF1("sessions", { year: 2024 });
  const call2 = await takeCall();
  call2.resolve(ok([{ session_key: 1 }]));
  assert.deepStrictEqual(await p2, [{ session_key: 1 }]);
  console.log("PASS 2: in-flight abort → AbortError, pLimit slot released");
}

// 3. abort during the 500ms spacingGate wait cancels fast (<350ms)
{
  const c = new AbortController();
  const t0 = Date.now();
  const p = getOpenF1("stints", { year: 2024 }, { signal: c.signal }); // queued behind nothing → waits ~500ms for spacing
  setTimeout(() => c.abort(), 50);
  await assert.rejects(p, (e) => e.name === "AbortError");
  const dt = Date.now() - t0;
  assert(dt < 350, `spacing cancel took ${dt}ms, expected <350ms`);
  console.log(`PASS 3: spacingGate abort cancels in ${dt}ms (<350)`);
}

// 4. abort during 429 backoff sleep stops retrying without another request
{
  const c = new AbortController();
  const before = calls.length;
  const p = getOpenF1("laps", { year: 2024 }, { signal: c.signal });
  const call = await takeCall();
  call.resolve(new Response("", { status: 429 })); // enters ≥1500ms backoff sleep
  await new Promise((r) => setTimeout(r, 80));     // now sleeping in backoff
  c.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls.length, before + 1, "abort during backoff must not issue a retry");
  console.log("PASS 4: backoff sleep aborts, no retry request");
}

// 5. overlapping years, older resolves LAST → only newer year's data applied
//    (models App.tsx effect: cleanup flips alive + aborts, new effect runs)
{
  let applied = null;
  let aliveA = true;

  // effect for 2023 (slow) — data will arrive late; alive flips when year changes
  const pA = getOpenF1("meetings", { year: 2023 })
    .then((rows) => { if (aliveA) applied = { year: 2023, rows }; })
    .catch((e) => { if (e.name !== "AbortError") throw e; });
  const callA = await takeCall();

  // year changes to 2024: cleanup sets alive=false, new effect starts
  aliveA = false;
  const pB = getOpenF1("meetings", { year: 2024 })
    .then((rows) => { applied = { year: 2024, rows }; })
    .catch((e) => { if (e.name !== "AbortError") throw e; });
  const callB = await takeCall();

  callB.resolve(ok([{ meeting_key: 1, year: 2024 }]));
  await pB;
  assert.strictEqual(applied?.year, 2024, "newer year must be applied first");

  // older call settles LAST with real data — alive=false must drop it
  callA.resolve(ok([{ meeting_key: 9, year: 2023 }]));
  await pA;
  assert.strictEqual(applied?.year, 2024, "stale older-year response must NOT clobber newer data");
  assert.strictEqual(applied?.rows[0].meeting_key, 1);
  console.log("PASS 5: out-of-order resolution → newer year wins, stale dropped");
}

// 6. year-scoped payload guard (Season.tsx pattern): render only if year matches
{
  const loaded = { year: 2023, stats: { championship: [] } };
  const year = 2024;
  const stats = loaded && loaded.year === year ? loaded.stats : null;
  assert.strictEqual(stats, null, "mismatched year must expose no stats");
  const matched = loaded && loaded.year === 2023 ? loaded.stats : null;
  assert(matched, "matching year exposes stats");
  console.log("PASS 6: year-scoped payload guard");
}

await new Promise((r) => setTimeout(r, 50));
assert.strictEqual(unhandled, 0, "no unhandled rejections allowed");
console.log("ALL ABORT CHECKS PASS");
