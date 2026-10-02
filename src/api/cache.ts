// Two-tier cache: cheap resources (meetings, sessions, drivers, laps...) go to
// localStorage per key; heavy/derived stuff stays in-memory per session lifetime.
// ponytail: no TTL — OpenF1 data is immutable once a season ends. Upgrade:
// version the key or add a max-rows guard if localStorage approaches 5MB.

const LS_PREFIX = "openf1:";

const mem = new Map<string, unknown>();

export const cacheKey = (resource: string, ops: Record<string, string | number | boolean | any[]>) => {
  const sorted = Object.entries(ops)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
    .sort()
    .join("&");
  return `${LS_PREFIX}${resource}?${sorted}`;
};

export const getCached = <T>(resource: string, ops: Record<string, string | number | boolean | any[]>) => {
  const key = cacheKey(resource, ops);
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as T;
      mem.set(key, parsed);
      return parsed;
    }
  } catch {
    /* corrupt entry — fall through to network */
  }
  return undefined;
};

export const setCached = (resource: string, ops: Record<string, string | number | boolean | any[]>, data: unknown) => {
  const key = cacheKey(resource, ops);
  mem.set(key, data);
  const json = JSON.stringify(data);
  // ponytail: heavy resources (e.g. intervals ≈ 4MB/race) stay in-memory only;
  // they'd otherwise eat the whole ~5MB localStorage quota on the first race.
  if (json.length < 500_000) {
    try {
      localStorage.setItem(key, json);
    } catch {
      /* quota exceeded — memory cache still works */
    }
  }
};
