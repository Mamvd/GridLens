import type { Meeting } from "../api/openf1";

// #9: meetings load state machine — pure, importable without React.
// Distinguishes "API failed" from "year has no races" so a down OpenF1 never
// renders as "No races found".
export type MeetingsLoadState =
  | { status: "loading" }
  | { status: "success"; year: number; meetings: Meeting[]; stale: boolean }
  | { status: "error"; year: number; restricted?: boolean };

export type MeetingsEvent =
  | { type: "start"; year: number }
  | { type: "success"; year: number; meetings: Meeting[]; stale?: boolean }
  | { type: "staleFallback"; year: number; meetings: Meeting[] }
  | { type: "error"; year: number; restricted?: boolean }
  | { type: "abort" }; // effect cleanup — state untouched

// Live F1 session → free tier 401s every endpoint (reachable, just restricted).
// Message match on the API's own body; "unable to reach" copy would be wrong.
export const isRestrictedOpenF1Error = (e: unknown): boolean =>
  (e as Error)?.message?.includes("Live F1 session in progress") ?? false;

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
      return { status: "error", year: ev.year, restricted: ev.restricted };
    case "abort":
      return prev;
  }
};
