import type { Meeting } from "../api/openf1";

// #9: meetings load state machine — pure, importable without React.
// Distinguishes "API failed" from "year has no races" so a down OpenF1 never
// renders as "No races found".
export type FailureKind = "offline" | "restricted" | "unreachable";

export type MeetingsLoadState =
  | { status: "loading" }
  | { status: "success"; year: number; meetings: Meeting[]; stale: boolean }
  | { status: "error"; year: number; restricted?: boolean; kind?: FailureKind };

export type MeetingsEvent =
  | { type: "start"; year: number }
  | { type: "success"; year: number; meetings: Meeting[]; stale?: boolean }
  | { type: "staleFallback"; year: number; meetings: Meeting[] }
  | { type: "error"; year: number; restricted?: boolean; kind?: FailureKind }
  | { type: "abort" }; // effect cleanup — state untouched

// Live F1 session → free tier 401s every endpoint (reachable, just restricted).
// Message match on the API's own body; "unable to reach" copy would be wrong.
// ponytail: in the browser the 401 is usually CORS-opaque (body never arrives),
// so "restricted" fires only when the body is readable — the error card's
// "unreachable" copy covers that case instead.
export const isRestrictedOpenF1Error = (e: unknown): boolean =>
  (e as Error)?.message?.includes("Live F1 session in progress") ?? false;

// Failure category for the error card. Offline wins: no network explains the
// fetch failure regardless of what the error message says.
export const describeFailure = (e: unknown, online: boolean): FailureKind => {
  if (!online) return "offline";
  if (isRestrictedOpenF1Error(e)) return "restricted";
  return "unreachable";
};

// Auto-retry only opaque network failures. Typed "OpenF1 NNN" errors mean the
// server answered (retrying a 4xx is pointless; 429 already has in-request
// backoff). AbortError is a caller-cancelled request, never a failure.
// Bounded at 2 retries — beyond that the error card (with manual Retry) owns it.
export const shouldAutoRetry = (e: unknown, attempt: number): boolean => {
  if (attempt >= 2) return false;
  const err = e as Error;
  if (err?.name === "AbortError") return false;
  if (/OpenF1 \d{3}/.test(err?.message ?? "")) return false;
  return true;
};

// exponential backoff + jitter: ~1.2s, ~2.4s, ~4.8s (capped), + 0–400ms
export const retryDelayMs = (attempt: number): number =>
  Math.min(6000, 1200 * 2 ** attempt) + Math.random() * 400;

export const initialMeetingsState: MeetingsLoadState = { status: "loading" };

export const resolveMeetingsState = (
  prev: MeetingsLoadState,
  ev: MeetingsEvent,
): MeetingsLoadState => {
  switch (ev.type) {
    case "start":
      return { status: "loading" };
    case "success":
      return { status: "success", year: ev.year, meetings: ev.meetings, stale: ev.stale ?? false };
    case "staleFallback":
      return { status: "success", year: ev.year, meetings: ev.meetings, stale: true };
    case "error":
      return { status: "error", year: ev.year, restricted: ev.restricted, kind: ev.kind };
    case "abort":
      return prev;
  }
};
