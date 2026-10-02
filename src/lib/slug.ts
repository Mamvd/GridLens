import type { Meeting } from "../api/openf1";

// "São Paulo Grand Prix" → "sao-paulo-grand-prix": diacritics stripped,
// non-alphanumeric runs → single "-", "-trimmed", "grand prix" kept.
export const meetingSlug = (m: Meeting): string =>
  m.meeting_name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Deduped slug assignment: date_start order; first keeps the bare slug,
// later collisions get "-2", "-3"… deterministic for a given meetings list.
const buildSlugs = (meetings: Meeting[]) => {
  const forward = new Map<number, string>();
  const reverse = new Map<string, Meeting>();
  const seen = new Map<string, number>();
  [...meetings]
    .sort((a, b) => a.date_start.localeCompare(b.date_start))
    .forEach((m) => {
      const base = meetingSlug(m);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const slug = n === 1 ? base : `${base}-${n}`;
      forward.set(m.meeting_key, slug);
      reverse.set(slug, m);
    });
  return { forward, reverse };
};

export const slugForMeeting = (meetings: Meeting[], m: Meeting): string =>
  buildSlugs(meetings).forward.get(m.meeting_key) ?? meetingSlug(m);

export const meetingFor = (meetings: Meeting[], slug: string): Meeting | undefined =>
  buildSlugs(meetings).reverse.get(slug);
