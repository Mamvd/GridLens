import { describe, it, expect } from "vitest";
import { meetingSlug, slugForMeeting, meetingFor } from "../../src/lib/slug";
import type { Meeting } from "../../src/api/openf1";

const m = (over: Partial<Meeting>): Meeting =>
  ({
    meeting_key: 1,
    meeting_name: "Monaco Grand Prix",
    meeting_official_name: "Monaco Grand Prix",
    location: "Monte Carlo",
    country_name: "Monaco",
    country_code: "MON",
    country_flag: "https://example/mon.png",
    year: 2024,
    date_start: "2024-05-26",
    date_end: "2024-05-26",
    circuit_key: 6,
    circuit_short_name: "Monaco",
    circuit_image: "https://example/monaco.png",
    ...over,
  }) as Meeting;

describe("meetingSlug", () => {
  it("strips diacritics and normalises separators", () => {
    expect(meetingSlug(m({ meeting_name: "São Paulo Grand Prix" }))).toBe("sao-paulo-grand-prix");
  });
  it("keeps 'grand prix', trims edges", () => {
    expect(meetingSlug(m({ meeting_name: "  Bahrain Grand Prix " }))).toBe("bahrain-grand-prix");
  });
  it("collapses non-alphanumeric runs to single dashes", () => {
    expect(meetingSlug(m({ meeting_name: "Emilia-Romagna  Grand   Prix" }))).toBe("emilia-romagna-grand-prix");
  });
});

describe("slugForMeeting / meetingFor", () => {
  it("first-by-date keeps bare slug; later collision gets -2", () => {
    const early = m({ meeting_key: 10, meeting_name: "Grand Prix", date_start: "2024-03-01" });
    const late = m({ meeting_key: 20, meeting_name: "Grand Prix", date_start: "2024-09-01" });
    const meetings = [late, early]; // input order deliberately unsorted
    expect(slugForMeeting(meetings, early)).toBe("grand-prix");
    expect(slugForMeeting(meetings, late)).toBe("grand-prix-2");
  });

  it("meetingFor resolves the reverse map", () => {
    const meetings = [
      m({ meeting_key: 1, meeting_name: "Monaco Grand Prix", date_start: "2024-05-26" }),
      m({ meeting_key: 2, meeting_name: "Monaco Grand Prix", date_start: "2025-05-25" }),
    ];
    expect(meetingFor(meetings, "monaco-grand-prix")?.meeting_key).toBe(1);
    expect(meetingFor(meetings, "monaco-grand-prix-2")?.meeting_key).toBe(2);
    expect(meetingFor(meetings, "nope")).toBeUndefined();
  });
});
