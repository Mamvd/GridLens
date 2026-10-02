// Assert-based slug checks: determinism, round-trip, collision suffixes.
// Run: node scripts/slug-check.mjs (Node 22 strips TS types natively).
import assert from "node:assert";

const { meetingSlug, slugForMeeting, meetingFor } = await import("../src/lib/slug.ts");

const M = (meeting_key, meeting_name, date_start) => ({ meeting_key, meeting_name, date_start, year: 2026 });

// 1. determinism + exact expected strings (run twice, same output)
{
  const bahrain = M(1282, "Bahrain Grand Prix", "2026-04-10T00:00:00+00:00");
  const sao = M(1165, "São Paulo Grand Prix", "2026-11-06T00:00:00+00:00");
  const emilia = M(1147, "Emilia Romagna Grand Prix", "2026-05-01T00:00:00+00:00");
  assert.strictEqual(meetingSlug(bahrain), "bahrain-grand-prix");
  assert.strictEqual(meetingSlug(sao), "sao-paulo-grand-prix");
  assert.strictEqual(meetingSlug(emilia), "emilia-romagna-grand-prix");
  assert.strictEqual(meetingSlug(bahrain), meetingSlug(bahrain));
  console.log("PASS 1: determinism + exact slug strings");
}

// 2. round-trip meeting → slug → same meeting
{
  const list = [
    M(1279, "Bahrain Grand Prix", "2026-03-08T00:00:00+00:00"),
    M(1281, "Chinese Grand Prix", "2026-03-29T00:00:00+00:00"),
    M(1296, "Singapore Grand Prix", "2026-10-09T00:00:00+00:00"),
    M(1301, "São Paulo Grand Prix", "2026-11-27T00:00:00+00:00"),
  ];
  for (const m of list) {
    const slug = slugForMeeting(list, m);
    assert.strictEqual(meetingFor(list, slug), m, `round-trip failed for ${m.meeting_name} (${slug})`);
  }
  assert.strictEqual(meetingFor(list, "sao-paulo-grand-prix"), list[3]);
  assert.strictEqual(meetingFor(list, "nope"), undefined);
  console.log("PASS 2: round-trip + unknown slug → undefined");
}

// 3. collision: same name twice → bare + "-2", both resolvable
{
  const early = M(1282, "Bahrain Grand Prix", "2026-04-10T00:00:00+00:00");
  const late = M(1308, "Bahrain Grand Prix", "2026-10-02T00:00:00+00:00");
  const other = M(1284, "Miami Grand Prix", "2026-05-02T00:00:00+00:00");
  const list = [late, other, early]; // unsorted on purpose
  assert.strictEqual(slugForMeeting(list, early), "bahrain-grand-prix", "first by date keeps bare slug");
  assert.strictEqual(slugForMeeting(list, late), "bahrain-grand-prix-2", "later collision gets -2");
  assert.strictEqual(meetingFor(list, "bahrain-grand-prix"), early);
  assert.strictEqual(meetingFor(list, "bahrain-grand-prix-2"), late);
  assert.strictEqual(meetingFor(list, "miami-grand-prix"), other);
  // determinism regardless of input order
  const shuffled = [other, early, late];
  assert.strictEqual(slugForMeeting(shuffled, late), "bahrain-grand-prix-2");
  console.log("PASS 3: collision → -2 suffix, both resolvable, order-independent");
}

console.log("ALL SLUG CHECKS PASS");
