// Two-tier cache for OpenF1 responses.
// - in-memory Map: always, session lifetime
// - localStorage: only when persist && serialized under the per-resource cap
//   (~600 KB; "intervals" excluded — memory-only), entry shape {d,f}
// Keys are versioned (gridlens:v2:…) so old openf1:* / v1 entries never mix
// with the new shape — legacy keys are purged on module init.
// ponytail: revalidate-on-expiry only (no SWR) — fits the bundle-load +
// skeleton architecture; add stale-while-revalidate if skeleton flashes annoy.

const LS_PREFIX = "gridlens:v2:openf1:";
const LEGACY_PREFIXES = ["openf1:", "gridlens:"]; // anything not LS_PREFIX

export const CURRENT_SEASON_TTL_MS = 15 * 60 * 1000;
export const LIVE_DATA_ENABLED = false; // ponytail: OpenF1 free tier serves no real-time data — flip only when a paid real-time source exists.

export type CacheStatus = "completed" | "in-progress" | "live";
export interface CachePolicy {
  ttlMs: number; // 0 = never expires
  persist: boolean; // false = memory-only, refetch every call
}

// Caller-side classification — no hardcoded years in the policy itself.
// Invariant: App's year selector is [2026,2025,2024,2023] capped by
// new Date().getFullYear(), so future seasons are unreachable — the
// "future-year" status state cannot occur from the UI.
export const classifySeason = (year: number, live = false): CacheStatus =>
  live ? "live" : year >= new Date().getFullYear() ? "in-progress" : "completed";

export const getCachePolicy = (_year: number, status: CacheStatus): CachePolicy => {
  if (status === "live") return { ttlMs: 0, persist: false };
  if (status === "in-progress") return { ttlMs: CURRENT_SEASON_TTL_MS, persist: true };
  return { ttlMs: 0, persist: true };
};

const mem = new Map<string, { d: unknown; f: number }>();
const inflight = new Map<string, Promise<unknown>>();

// Purge unversioned openf1:* and v1 gridlens:* keys once per load.
const purgeLegacyKeys = () => {
  try {
    if (typeof localStorage === "undefined") return;
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.startsWith(LS_PREFIX)) continue;
      if (LEGACY_PREFIXES.some((p) => k.startsWith(p))) dead.push(k);
    }
    dead.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* no-op when localStorage absent/broken */
  }
};
purgeLegacyKeys();

export const cacheKey = (resource: string, ops: Record<string, string | number | boolean | any[]>) => {
  const sorted = Object.entries(ops)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
    .sort()
    .join("&");
  return `${LS_PREFIX}${resource}?${sorted}`;
};

const isFresh = (e: { f: number }, ttlMs: number) => ttlMs === 0 || Date.now() - e.f < ttlMs;

const getCachedEntry = <T>(resource: string, ops: Record<string, string | number | boolean | any[]>, ttlMs: number): T[] | undefined => {
  const key = cacheKey(resource, ops);
  const m = mem.get(key);
  if (m && isFresh(m, ttlMs)) return m.d as T[];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { d: T[]; f: number };
      if (parsed && typeof parsed.f === "number" && "d" in parsed) {
        if (isFresh(parsed, ttlMs)) {
          mem.set(key, parsed);
          return parsed.d;
        }
        // stale — leave LS entry; setCached overwrites after refetch
        mem.delete(key);
        return undefined;
      }
    }
  } catch {
    // corrupt — purge so the next write starts clean; never throw
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  mem.delete(key);
  return undefined;
};

export interface CachedResult<T> { data: T[]; stale: boolean }

// --- NF-01: cache-only reads (no fetch) for the single↔batch key bridge ---
// The season pipeline batches rows under {session_key:[...all]}; race views
// read single-key {session_key:sk}. On a single-key miss the race loader may
// serve from a fresh batch entry instead of refetching. ponytail: upgrade =
// query-side join / key aliases inside cached() so callers need no bridge.

// "gridlens:v2:openf1:resource?k=v&…" → { resource, ops } (string values)
const parseCacheKey = (key: string): { resource: string; ops: Record<string, string> } | null => {
  if (!key.startsWith(LS_PREFIX)) return null;
  const body = key.slice(LS_PREFIX.length);
  const q = body.indexOf("?");
  if (q < 0) return null;
  const ops: Record<string, string> = {};
  for (const pair of body.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) ops[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { resource: body.slice(0, q), ops };
};

// array ops are joined with "|" in cacheKey — session_key lists only (numbers)
const sessionKeyList = (ops: Record<string, string>): number[] | null =>
  ops.session_key == null
    ? null
    : ops.session_key.split("|").map(Number).filter((n) => Number.isFinite(n));

// fresh single-key entry, cache-only — same freshness rules as cached() but
// NON-destructive: a stale mem entry must stay put for cached()'s
// stale-if-error rescue (it is the only copy of memory-only payloads).
export const peekCached = <T>(
  resource: string,
  ops: Record<string, string | number | boolean | any[]>,
  ttlMs: number,
): T[] | undefined => {
  const key = cacheKey(resource, ops);
  const m = mem.get(key);
  if (m && isFresh(m, ttlMs)) return m.d as T[];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { d: T[]; f: number };
      if (parsed && typeof parsed.f === "number" && "d" in parsed && isFresh(parsed, ttlMs)) {
        mem.set(key, parsed); // same LS→mem promotion as getCachedEntry
        return parsed.d;
      }
    }
  } catch { /* corrupt — treat as absent, leave cleanup to cached() */ }
  return undefined;
};

// fresh BATCH entry (any session_key list containing sessionKey) in mem or LS.
// Scans only this resource's keys; stale entries are treated as absent.
export const peekCachedBatch = <T>(resource: string, sessionKey: number, ttlMs: number): T[] | undefined => {
  for (const [key, m] of mem) {
    if (!isFresh(m, ttlMs)) continue;
    const p = parseCacheKey(key);
    if (p && p.resource === resource && sessionKeyList(p.ops)?.includes(sessionKey)) return m.d as T[];
  }
  try {
    const prefix = `${LS_PREFIX}${resource}?`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const p = parseCacheKey(key);
      if (!p || !sessionKeyList(p.ops)?.includes(sessionKey)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { d: T[]; f: number };
      if (parsed && typeof parsed.f === "number" && "d" in parsed && isFresh(parsed, ttlMs)) return parsed.d;
    }
  } catch { /* corrupt/absent — treat as miss */ }
  return undefined;
};

// Any-age entry for stale-if-error rescue. mem first: memory-only payloads
// (intervals > 500 KB) never reach localStorage, and mem can be newer when a
// quota-blocked LS write silently failed.
const getStaleEntry = <T>(resource: string, ops: Record<string, string | number | boolean | any[]>): T[] | undefined => {
  const key = cacheKey(resource, ops);
  const m = mem.get(key);
  if (m) return m.d as T[];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { d: T[]; f: number };
      if (parsed && typeof parsed.f === "number" && "d" in parsed) return parsed.d;
    }
  } catch { /* corrupt — treat as absent */ }
  return undefined;
};

// Cached fetcher: fresh hit → return; otherwise one shared request per key
// (in-flight dedupe protects StrictMode double-invokes + concurrent callers).
// live policy skips both tiers and refetches every call (dedupe concurrent only).
// stale-if-error: revalidation fails + persisted entry exists → {stale: true}
// instead of throwing; AbortError always rethrows (aborted year-swap must not
// fall back to the previous year's data).
export const cached = async <T>(
  resource: string,
  ops: Record<string, string | number | boolean | any[]>,
  fn: (signal?: AbortSignal) => Promise<T[]>,
  policy: CachePolicy,
  opts?: { signal?: AbortSignal },
): Promise<CachedResult<T>> => {
  const key = cacheKey(resource, ops);
  let staleEntry: T[] | undefined;
  if (policy.persist) {
    // capture BEFORE getCachedEntry — it deletes stale mem entries, which would
    // destroy the only copy of a memory-only payload before the rescue runs.
    staleEntry = getStaleEntry<T>(resource, ops);
    const hit = getCachedEntry<T>(resource, ops, policy.ttlMs);
    if (hit) return { data: hit, stale: false };
  }
  const pending = inflight.get(key) as Promise<CachedResult<T>> | undefined;
  if (pending) {
    const s = opts?.signal;
    if (!s) return pending;
    // ponytail: a signal-bearing caller joins the shared in-flight request —
    // its own abort rejects ITS handle, the shared fetch keeps running. If the
    // SHARED request is aborted (owner's signal fires first) and our signal
    // is still live, re-issue once so the caller is not stranded; true
    // network failures still propagate. Upgrade: refcounted per-signal
    // abort so the fetch dies when its last caller drops.
    if (s.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return pending.then((v) => {
      if (s.aborted) throw new DOMException("Aborted", "AbortError");
      return v;
    }, (e: unknown) => {
      if ((e as Error)?.name === "AbortError" && !s.aborted) return cached(resource, ops, fn, policy, opts);
      throw e;
    });
  }
  const p = (async (): Promise<CachedResult<T>> => {
    try {
      const data = await fn(opts?.signal);
      if (policy.persist) {
        const f = Date.now();
        mem.set(key, { d: data, f });
        const json = JSON.stringify({ d: data, f });
        // ponytail: heavy resources (intervals ≈ 4 MB/race) stay memory-only;
        // they'd otherwise eat the whole ~5 MB localStorage quota on the first race.
        // laps (~564 KB) exceeds the old 500 KB gate but fits the raised ~600 KB
        // per-entry cap; total LS stays protected by the quota fallback below.
        if (resource !== "intervals" && json.length < 600_000) {
          try { localStorage.setItem(key, json); } catch { /* quota exceeded — mem still works */ }
        }
      }
      return { data, stale: false };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      if (staleEntry) return { data: staleEntry, stale: true };
      throw e;
    }
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
};

// test-only: scripts/cache-check.mjs — clears mem + inflight between scenarios
export const __resetCacheForTests = () => { mem.clear(); inflight.clear(); };
