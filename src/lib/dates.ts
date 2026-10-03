// Circuit-local race dates — pure, React-free, testable.
//
// OpenF1 semantics (docs verified at openf1.org/docs; live verification
// pending the free-tier lockout): date_start/date_end are UTC ISO 8601
// instants; gmt_offset ("HH:MM:SS" or "HH:MM") is venue-local time minus GMT.
// Rendering always uses the UTC time zone on a shifted instant, so the
// viewer's own zone never changes the result.
//
// ponytail: when gmt_offset is absent/unparseable the UTC date is rendered
// (never viewer-local) — upgrade path: per-circuit fixed-offset table if the
// field proves unreliable in live data.

export const DATE_LOCALE = "en-GB";

// offset parsed as positive local offset (seconds component ignored), per spec
const offsetMs = (gmtOffset?: string | null): number | null => {
  if (!gmtOffset) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(gmtOffset.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 14 || min > 59) return null;
  return h * 3_600_000 + min * 60_000;
};

// shift the UTC instant into circuit-local wall time, then read the calendar
// date off it in UTC (so the viewer's zone can't leak in)
const shiftedParts = (iso: string | null | undefined, gmtOffset?: string): { day: string; month: string; year: string } | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const off = offsetMs(gmtOffset);
  const ms = off == null ? t : t + off;
  const parts = new Intl.DateTimeFormat(DATE_LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const year = get("year");
  if (!day || !month || !year) return null;
  return { day, month, year };
};

// "5 July 2026" — invalid/missing ISO → "—" (never crashes, never viewer-local)
export const formatRaceDate = (dateStartISO: string | null | undefined, gmtOffset?: string): string => {
  const p = shiftedParts(dateStartISO, gmtOffset);
  return p ? `${p.day} ${p.month} ${p.year}` : "—";
};

// "5–7 July 2026" (same month) / "30 June–2 July 2026" (month span) /
// "5 July 2026" (single day) / "31 December 2026–2 January 2027" (year span);
// either endpoint invalid → "—"
export const formatRaceDateRange = (
  startISO: string | null | undefined,
  endISO: string | null | undefined,
  gmtOffset?: string,
): string => {
  const a = shiftedParts(startISO, gmtOffset);
  const b = shiftedParts(endISO, gmtOffset);
  if (!a || !b) return "—";
  if (a.day === b.day && a.month === b.month && a.year === b.year) {
    return `${a.day} ${a.month} ${a.year}`;
  }
  if (a.month === b.month && a.year === b.year) {
    return `${a.day}–${b.day} ${a.month} ${a.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${a.month}–${b.day} ${b.month} ${a.year}`;
  }
  return `${a.day} ${a.month} ${a.year}–${b.day} ${b.month} ${b.year}`;
};
