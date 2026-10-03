import { describe, it, expect } from "vitest";
import { formatRaceDate, formatRaceDateRange } from "../../src/lib/dates";

describe("formatRaceDate", () => {
  it("renders a plain UTC date when offset absent", () => {
    expect(formatRaceDate("2026-07-05T14:00:00Z")).toBe("5 July 2026");
  });

  it("applies gmt_offset shift across a day boundary", () => {
    // 23:30 UTC + 02:00 → 01:30 next day local
    expect(formatRaceDate("2026-07-05T23:30:00Z", "02:00:00")).toBe("6 July 2026");
  });

  it("does not shift when offset is zero", () => {
    expect(formatRaceDate("2026-07-05T14:00:00Z", "00:00:00")).toBe("5 July 2026");
  });

  it("invalid ISO → '—'", () => {
    expect(formatRaceDate("not-a-date")).toBe("—");
    expect(formatRaceDate(null)).toBe("—");
    expect(formatRaceDate(undefined)).toBe("—");
    expect(formatRaceDate("")).toBe("—");
  });

  it("unparseable offset falls back to UTC date (never crashes)", () => {
    expect(formatRaceDate("2026-07-05T14:00:00Z", "garbage")).toBe("5 July 2026");
    expect(formatRaceDate("2026-07-05T14:00:00Z", "99:99")).toBe("5 July 2026");
  });
});

describe("formatRaceDateRange", () => {
  it("single day → one date", () => {
    expect(formatRaceDateRange("2026-07-05T14:00:00Z", "2026-07-05T16:00:00Z")).toBe("5 July 2026");
  });

  it("same month → en dash range", () => {
    expect(formatRaceDateRange("2026-07-05T14:00:00Z", "2026-07-07T16:00:00Z")).toBe("5–7 July 2026");
  });

  it("month span, same year", () => {
    expect(formatRaceDateRange("2026-06-30T14:00:00Z", "2026-07-02T16:00:00Z")).toBe("30 June–2 July 2026");
  });

  it("year span", () => {
    expect(formatRaceDateRange("2026-12-31T14:00:00Z", "2027-01-02T16:00:00Z")).toBe("31 December 2026–2 January 2027");
  });

  it("either endpoint invalid → '—'", () => {
    expect(formatRaceDateRange("nope", "2026-07-07T16:00:00Z")).toBe("—");
    expect(formatRaceDateRange("2026-07-05T14:00:00Z", "nope")).toBe("—");
  });

  it("offset shifts both endpoints before range math", () => {
    // start 23:30Z +02 → 6 July; end 01:00Z 7 July +02 → 7 July → "6–7 July 2026"
    expect(
      formatRaceDateRange("2026-07-05T23:30:00Z", "2026-07-07T01:00:00Z", "02:00:00"),
    ).toBe("6–7 July 2026");
  });
});
