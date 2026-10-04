import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cached, cacheKey, getCachePolicy, classifySeason,
  CURRENT_SEASON_TTL_MS, LIVE_DATA_ENABLED, __resetCacheForTests,
} from "../../src/api/cache";
import { loadRaceBase } from "../../src/data/race";
import { lsStore, lsReset } from "./setup";

// NF-01/NF-02 exercise loadRaceBase against a mocked network — the rest of
// this file drives `cached` with local fetchers, so the mock is inert there.
const { getOpenF1Mock } = vi.hoisted(() => ({ getOpenF1Mock: vi.fn() }));
vi.mock("../../src/api/openf1", () => ({ getOpenF1: getOpenF1Mock }));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const completed = getCachePolicy(2023, "completed");
const inProgress = getCachePolicy(new Date().getFullYear(), "in-progress");
const ops = { session_key: 42 };

const mkFn = (tag: string) => {
  let n = 0;
  const fn = async () => { n++; await tick(2); return [{ tag, n }]; };
  return { fn, count: () => n };
};

const ageEntry = (key: string, ageMs: number) => {
  const raw = JSON.parse(lsStore.get(key)!);
  lsStore.set(key, JSON.stringify({ ...raw, f: Date.now() - ageMs }));
};

beforeEach(() => {
  __resetCacheForTests();
  lsReset();
});

describe("cached: basic policies", () => {
  it("fresh hit: second call does not refetch", async () => {
    const { fn, count } = mkFn("fresh");
    const a = await cached("drivers", ops, fn, completed);
    const b = await cached("drivers", ops, fn, completed);
    expect(count()).toBe(1);
    expect(a.stale).toBe(false);
    expect(b.data).toEqual(a.data);
  });

  it("current-season TTL: aged entry refetches", async () => {
    const { fn, count } = mkFn("ttl");
    await cached("laps", ops, fn, inProgress);
    expect(count()).toBe(1);
    __resetCacheForTests(); // fresh pageload: mem gone, LS remains
    ageEntry(cacheKey("laps", ops), CURRENT_SEASON_TTL_MS + 1000);
    await cached("laps", ops, fn, inProgress);
    expect(count()).toBe(2);
  });

  it("completed: never expires even when ancient", async () => {
    const { fn, count } = mkFn("done");
    await cached("pit", ops, fn, completed);
    __resetCacheForTests();
    ageEntry(cacheKey("pit", ops), 365 * 24 * 3600 * 1000);
    await cached("pit", ops, fn, completed);
    expect(count()).toBe(1);
  });

  it("live policy: refetches every call, never persists", async () => {
    const live = getCachePolicy(new Date().getFullYear(), "live");
    const { fn, count } = mkFn("live");
    await cached("drivers", ops, fn, live);
    await cached("drivers", ops, fn, live);
    expect(count()).toBe(2);
    expect(lsStore.size).toBe(0);
  });

  it("LIVE_DATA_ENABLED ships false", () => {
    expect(LIVE_DATA_ENABLED).toBe(false);
    expect(classifySeason(2023)).toBe("completed");
    expect(classifySeason(new Date().getFullYear())).toBe("in-progress");
    expect(classifySeason(new Date().getFullYear(), true)).toBe("live");
  });
});

describe("cached: per-resource localStorage budget (PF-04)", () => {
  it("laps (~564 KB) is allowed under raised per-entry cap", async () => {
    const ops = { session_key: 42 };
    // Return a large array simulating ~564 KB of lap data (~3800 laps with full precision)
    const largeLapsData = Array(3800).fill(null).map((_, i) => ({
      session_key: 42, driver_number: 1, lap_number: i + 1,
      lap_duration: 90.123, duration_sector_1: 30.123, duration_sector_2: 31.234, duration_sector_3: 28.789
    }));
    let count = 0;
    const countingFn = async () => { count++; return largeLapsData; };
    const r = await cached("laps", ops, countingFn, inProgress);
    expect(count).toBe(1);
    expect(r.stale).toBe(false);
    // Verify it was written to LS (key exists)
    const key = cacheKey("laps", ops);
    expect(lsStore.has(key)).toBe(true);
    const stored = JSON.parse(lsStore.get(key)!);
    expect(stored.d.length).toBe(3800);
  });

  it("intervals (~4 MB) stays memory-only regardless of cap", async () => {
    const ops = { session_key: 42 };
    const { fn, count } = mkFn("intervals-budget");
    const r = await cached("intervals", ops, fn, completed);
    expect(count()).toBe(1);
    // Must NOT be in localStorage
    const key = cacheKey("intervals", ops);
    expect(lsStore.has(key)).toBe(false);
    // But must be in memory
    expect(r.data).toBeDefined();
  });
});

describe("cached: failure paths", () => {
  it("corrupt LS entry → refetch, no crash, garbage replaced", async () => {
    lsStore.set(cacheKey("stints", ops), "{not json{{{");
    const { fn, count } = mkFn("corrupt");
    const r = await cached("stints", ops, fn, inProgress);
    expect(count()).toBe(1);
    expect(r.data[0].tag).toBe("corrupt");
    const parsed = JSON.parse(lsStore.get(cacheKey("stints", ops))!);
    expect(typeof parsed.f).toBe("number");
    expect(Array.isArray(parsed.d)).toBe(true);
  });

  it("stale-if-error: primed entry + reject → {data: stale, stale: true}", async () => {
    await cached("laps", ops, mkFn("stale").fn, inProgress);
    __resetCacheForTests();
    ageEntry(cacheKey("laps", ops), CURRENT_SEASON_TTL_MS + 1000);
    let calls = 0;
    const failing = async () => { calls++; throw new Error("network down"); };
    const r = await cached("laps", ops, failing, inProgress);
    expect(calls).toBe(1);
    expect(r.stale).toBe(true);
    expect(r.data[0].tag).toBe("stale");
  });

  it("stale-if-error: no entry + reject → throws", async () => {
    await expect(
      cached("pit", ops, async () => { throw new Error("boom"); }, inProgress),
    ).rejects.toThrow("boom");
  });

  it("AbortError rethrows even with a primed stale entry (owner path)", async () => {
    await cached("stints", ops, mkFn("abort").fn, inProgress);
    __resetCacheForTests();
    ageEntry(cacheKey("stints", ops), CURRENT_SEASON_TTL_MS + 1000);
    const aborted = async () => { throw new DOMException("Aborted", "AbortError"); };
    await expect(cached("stints", ops, aborted, inProgress)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("in-flight dedupe: concurrent same-key calls share one fetch", async () => {
    const { fn, count } = mkFn("c");
    const [a, b] = await Promise.all([
      cached("drivers", ops, fn, completed),
      cached("drivers", ops, fn, completed),
    ]);
    expect(count()).toBe(1);
    expect(a).toEqual(b);
  });
});

// T1 deferred finding — join/re-issue semantics of signal-bearing callers:
// (a) owner abort + live joiner re-issues once
// (b) both aborted → no re-issue
// (c) AbortError never hits stale rescue on the join path
describe("cached: signal join / re-issue", () => {
  it("(a) owner aborts, live joiner re-issues exactly once", async () => {
    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const fn = (signal?: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve([{ ok: calls }]);
    };
    const pOwner = cached("drivers", ops, fn, completed, { signal: ownerCtrl.signal });
    const pJoiner = cached("drivers", ops, fn, completed, { signal: joinerCtrl.signal });
    await tick();
    ownerCtrl.abort();
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
    const res = await pJoiner;
    expect(calls).toBe(2);
    expect(res.data).toEqual([{ ok: 2 }]);
    expect(res.stale).toBe(false);
  });

  it("(b1) pre-aborted joiner rejects immediately, no re-issue", async () => {
    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    joinerCtrl.abort();
    const fn = (signal?: AbortSignal) => {
      calls++;
      return new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    const pOwner = cached("drivers", ops, fn, completed, { signal: ownerCtrl.signal });
    const pJoiner = cached("drivers", ops, fn, completed, { signal: joinerCtrl.signal });
    await expect(pJoiner).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    ownerCtrl.abort();
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
  });

  it("(b2) both abort after join → no re-issue", async () => {
    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const fn = (signal?: AbortSignal) => {
      calls++;
      return new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    const pOwner = cached("drivers", ops, fn, completed, { signal: ownerCtrl.signal });
    const pJoiner = cached("drivers", ops, fn, completed, { signal: joinerCtrl.signal });
    await tick();
    joinerCtrl.abort();
    ownerCtrl.abort();
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
    await expect(pJoiner).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("(c) AbortError on the join re-issue path never falls back to stale data", async () => {
    // prime a stale entry so a buggy rescue would surface it
    await cached("laps", ops, mkFn("primed").fn, inProgress);
    __resetCacheForTests();
    ageEntry(cacheKey("laps", ops), CURRENT_SEASON_TTL_MS + 1000);

    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const fn = (signal?: AbortSignal) => {
      calls++;
      return new Promise<never>((_, reject) => {
        const fail = () => reject(new DOMException("Aborted", "AbortError"));
        if (calls === 1) signal?.addEventListener("abort", fail, { once: true });
        else joinerCtrl.signal.addEventListener("abort", fail, { once: true });
      });
    };
    const pOwner = cached("laps", ops, fn, inProgress, { signal: ownerCtrl.signal });
    const pJoiner = cached("laps", ops, fn, inProgress, { signal: joinerCtrl.signal });
    await tick();
    ownerCtrl.abort(); // owner dies → joiner re-issues (calls=2)
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
    await tick(20);
    expect(calls).toBe(2);
    joinerCtrl.abort(); // re-issued fetch aborts too
    await expect(pJoiner).rejects.toMatchObject({ name: "AbortError" });
  });

  it("network failure on the join re-issue: stale-if-error still applies (primed entry)", async () => {
    // The re-issue is a full cached() call — non-Abort failures there obey the
    // same stale-if-error policy as a first call. AbortError does not (test c).
    await cached("laps", ops, mkFn("primed").fn, inProgress);
    __resetCacheForTests();
    ageEntry(cacheKey("laps", ops), CURRENT_SEASON_TTL_MS + 1000);

    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const fn = (signal?: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.reject(new Error("network down"));
    };
    const pOwner = cached("laps", ops, fn, inProgress, { signal: ownerCtrl.signal });
    const pJoiner = cached("laps", ops, fn, inProgress, { signal: joinerCtrl.signal });
    await tick();
    ownerCtrl.abort();
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
    const res = await pJoiner;
    expect(calls).toBe(2);
    expect(res.stale).toBe(true);
    expect(res.data[0].tag).toBe("primed");
  });

  it("network failure on the join re-issue: no primed entry → rejects", async () => {
    let calls = 0;
    const ownerCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const fn = (signal?: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.reject(new Error("network down"));
    };
    const pOwner = cached("laps", ops, fn, inProgress, { signal: ownerCtrl.signal });
    const pJoiner = cached("laps", ops, fn, inProgress, { signal: joinerCtrl.signal });
    await tick();
    ownerCtrl.abort();
    await expect(pOwner).rejects.toMatchObject({ name: "AbortError" });
    await expect(pJoiner).rejects.toThrow("network down");
    expect(calls).toBe(2);
  });
});

// NF-01: season batches rows under {session_key:[...all]}; race reads
// single-key. A fresh batch entry must serve the single-key read with zero
// request starts (Season→Race), while cold direct-to-race still fetches.
describe("NF-01: batch key serves race single-key reads", () => {
  const resultRow = (sk: number) => ({ session_key: sk, position: 1 });
  const driverRow = (sk: number) => ({ session_key: sk, first_name: "Max", last_name: "Verstappen" });

  beforeEach(() => { getOpenF1Mock.mockReset(); });

  it("fresh season batch → loadRaceBase filters rows, 0 getOpenF1 calls", async () => {
    await cached("session_result", { session_key: [900, 901] },
      async () => [resultRow(900), resultRow(901)] as never, completed);
    await cached("drivers", { session_key: [900, 901] },
      async () => [driverRow(900), driverRow(901)] as never, completed);
    getOpenF1Mock.mockRejectedValue(new Error("must not fetch"));
    const b = await loadRaceBase(900, 2023);
    expect(getOpenF1Mock).not.toHaveBeenCalled();
    expect(b.results).toHaveLength(1);
    expect(b.results![0].session_key).toBe(900); // sibling session filtered out
    expect(b.drivers![0].first_name).toBe("Max");
    expect(b.stale).toBe(false);
    expect(b.resultsError).toBeUndefined();
    expect(b.driversError).toBeUndefined();
  });

  it("no batch entry → cold direct-to-race fetches single-key as before", async () => {
    getOpenF1Mock.mockImplementation(async (resource: string) =>
      resource === "session_result" ? [resultRow(900)] : [driverRow(900)]);
    const b = await loadRaceBase(900, 2023);
    expect(getOpenF1Mock).toHaveBeenCalledTimes(2);
    expect(b.results).toHaveLength(1);
    expect(b.drivers).toHaveLength(1);
  });

  it("batch entry under a different resource never leaks across", async () => {
    await cached("drivers", { session_key: [900] },
      async () => [driverRow(900)] as never, completed);
    getOpenF1Mock.mockImplementation(async (resource: string) =>
      resource === "session_result" ? [resultRow(900)] : [driverRow(900)]);
    const b = await loadRaceBase(900, 2023);
    // session_result had no batch + no single entry → fetched; drivers hit batch
    expect(getOpenF1Mock).toHaveBeenCalledTimes(1);
    expect(getOpenF1Mock.mock.calls[0][0]).toBe("session_result");
    expect(b.results).toHaveLength(1);
    expect(b.drivers).toHaveLength(1);
  });
});

// NF-02: one Promise.all member rejecting must fail only its own slice —
// the sibling's data survives (error titles never blame the healthy one).
describe("NF-02: loadRaceBase settles per resource", () => {
  const resultRow = (sk: number) => ({ session_key: sk, position: 1 });
  const driverRow = (sk: number) => ({ session_key: sk, first_name: "Max", last_name: "Verstappen" });

  beforeEach(() => { getOpenF1Mock.mockReset(); });

  it("session_result rejects → drivers keeps its data", async () => {
    getOpenF1Mock.mockImplementation(async (resource: string) => {
      if (resource === "session_result") throw new Error("result boom");
      return [driverRow(900)];
    });
    const b = await loadRaceBase(900, 2023);
    expect(b.results).toBeUndefined();
    expect(b.resultsError).toContain("result boom");
    expect(b.drivers).toHaveLength(1);
    expect(b.driversError).toBeUndefined();
  });

  it("drivers rejects → results keeps its data", async () => {
    getOpenF1Mock.mockImplementation(async (resource: string) => {
      if (resource === "drivers") throw new Error("drivers boom");
      return [resultRow(900)];
    });
    const b = await loadRaceBase(900, 2023);
    expect(b.drivers).toBeUndefined();
    expect(b.driversError).toContain("drivers boom");
    expect(b.results).toHaveLength(1);
    expect(b.resultsError).toBeUndefined();
  });

  it("both reject → both errors reported, no throw", async () => {
    getOpenF1Mock.mockRejectedValue(new Error("total failure"));
    const b = await loadRaceBase(900, 2023);
    expect(b.resultsError).toContain("total failure");
    expect(b.driversError).toContain("total failure");
    expect(b.results).toBeUndefined();
    expect(b.drivers).toBeUndefined();
  });

  it("AbortError still rethrows (aborted nav is not a slice error)", async () => {
    getOpenF1Mock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(loadRaceBase(900, 2023)).rejects.toMatchObject({ name: "AbortError" });
  });
});
