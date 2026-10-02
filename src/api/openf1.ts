// OpenF1 v1 client — pure browser, no backend.
// https://api.openf1.org/v1/{resource}?col<op>value — operators: = > < >= <=
// (multi-value: repeat the key, e.g. driver_number=44&driver_number=1)

const BASE = "https://api.openf1.org/v1";

export type Ops = Record<string, string | number | boolean | (string | number | boolean)[]>;

// --- global concurrency limiter + 429 backoff ---
// OpenF1 rate-limits aggressively (~429) when a season load fans out to ~96
// parallel requests. Cap in-flight requests and back off on 429.
// ponytail: tiny p-limit clone — cap concurrent in-flight requests at 4.
// Add jittered throttling (not just backoff) only if 429s persist at this cap.
const pLimit = (concurrency: number) => {
  let activeCount = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    activeCount--;
    queue.shift()?.();
  };
  return <R>(fn: () => Promise<R>): Promise<R> =>
    new Promise((resolve, reject) => {
      const run = () => {
        activeCount++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(next);
      };
      if (activeCount < concurrency) run();
      else queue.push(run);
    });
};
const runLimited = pLimit(4);

// Minimum spacing between request *starts* — OpenF1 rate-limits by
// requests/sec, so a pure concurrency cap still bursts into 429s.
const MIN_SPACING_MS = 500;
let lastStart = 0;
const spacingGate = async () => {
  const wait = lastStart + MIN_SPACING_MS - Date.now();
  if (wait > 0) await delay(wait);
  lastStart = Date.now();
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetchWithBackoff = async (url: string, attempt = 0): Promise<Response> => {
  const res = await fetch(url);
  if (res.status === 429 && attempt < 5) {
    const wait = 1500 * 2 ** attempt + Math.random() * 500;
    await delay(wait);
    return fetchWithBackoff(url, attempt + 1);
  }
  return res;
};

export const getOpenF1 = async <T>(resource: string, ops: Ops = {}): Promise<T[]> => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(ops)) {
    const values = Array.isArray(v) ? v : [v];
    values.forEach((val) => params.append(k, String(val)));
  }
  const qs = params.toString();
  const url = `${BASE}/${resource}${qs ? `?${qs}` : ""}`;

  // ponytail: requests are spaced out (one start per MIN_SPACING_MS) and
  // capped at pLimit(4), so a season-wide fan-out doesn't trip 429s.
  // Backoff in fetchWithBackoff absorbs any that still get throttled.
  const res = await runLimited(async () => {
    await spacingGate();
    return fetchWithBackoff(url);
  });
  if (res.status === 429) throw new Error(`OpenF1 rate-limited on ${resource}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenF1 ${res.status} on ${resource}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
};

// --- shared types (only fields we use) ---

export interface Meeting {
  meeting_key: number;
  meeting_name: string;
  meeting_official_name: string;
  location: string;
  country_name: string;
  country_code: string;
  country_flag: string;
  year: number;
  date_start: string;
  date_end: string;
  circuit_key: number;
  circuit_short_name: string;
  circuit_image: string;
}

export interface Session {
  session_key: number;
  meeting_key: number;
  session_name: string; // "Practice 1" | "Qualifying" | "Race"
  session_date: string;
}

export interface Driver {
  meeting_key: number;
  session_key: number;
  driver_number: number;
  first_name: string;
  last_name: string;
  full_name: string;
  broadcast_name: string;
  name_acronym: string;
  team_name: string;
  team_colour: string;
}
// ponytail: no composed display-name field on the API — build `first last` at call sites; upgrade: add `nameOfDriver` helper in data/race.ts once a second call site lands.

export interface Lap {
  meeting_key: number;
  session_key: number;
  driver_number: number;
  lap_number: number;
  date_start: string;
  lap_duration: number | null;
  is_valid_lap: number | null;
  is_pit_out_lap: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  segments_sector_1: number | null;
  segments_sector_2: number | null;
  segments_sector_3: number | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
}

export interface Interval {
  session_key: number;
  driver_number: number;
  date: string;
  interval: number | null;
}

export interface Stint {
  session_key: number;
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  tyre_age_at_start: number | null;
  compound: string | null; // 'SOFT' | 'MEDIUM' | 'HARD' | ...
}

export interface PitEvent {
  session_key: number;
  driver_number: number;
  lap_number: number;
  stop_duration: number | null;
  stop_speed: number | null;
}

export interface Position {
  meeting_key: number;
  driver_number: number;
  position: number;
  laps_completed: number | null;
}

export interface SessionResult {
  meeting_key: number;
  session_key: number;
  driver_number: number;
  position: number;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
  gap_to_leader: number | null;
  duration: number | null;
}

export interface Overtake {
  session_key: number;
  driver_number: number;
  overtaking_driver_number: number | null;
  overtaken_driver_number: number | null;
  position: number | null;
  overtake_lap: number | null;
}

export interface StartingGrid {
  session_key: number;
  driver_number: number;
  grid_position: number;
}

export interface TeamRadio {
  session_key: number;
  date: string;
  speaker: string | null;
  speaker_type: string | null;
  text: string | null;
  driver_number: number | null;
  team_key: number | null;
}
