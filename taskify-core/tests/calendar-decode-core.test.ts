import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCalendarCanonicalPayload,
  parseCalendarViewPayload,
  parseCalendarRsvpPayload,
} from "../dist/calendarDecode.js";

test("parseCalendarCanonicalPayload accepts valid payload", () => {
  const parsed = parseCalendarCanonicalPayload({
    v: 1,
    eventId: "ev1",
    eventKey: "abc",
    kind: "time",
    title: "Focus",
    startISO: "2026-03-12T15:00:00.000Z",
  });
  assert.equal(parsed?.eventId, "ev1");
  assert.equal(parsed?.kind, "time");
});

test("parseCalendarCanonicalPayload preserves recurrence cutoffs on deleted versions", () => {
  const recurrence = {
    type: "daily",
    untilISO: "2026-07-28T00:00:00.000Z",
  };
  const parsed = parseCalendarCanonicalPayload({
    v: 1,
    eventId: "recurrence:event-series:2026-07-29",
    eventKey: "abc",
    deleted: true,
    recurrence,
    seriesId: "event-series",
  });

  assert.deepEqual(parsed?.recurrence, recurrence);
  assert.equal(parsed?.seriesId, "event-series");
});

test("parseCalendarViewPayload rejects invalid payload", () => {
  assert.equal(parseCalendarViewPayload({ v: 1, eventId: "ev1" }), null);
});

test("parseCalendarRsvpPayload parses minimal valid envelope", () => {
  const parsed = parseCalendarRsvpPayload({
    v: 1,
    eventId: "ev1",
    inviteToken: "tok",
    status: "accepted",
  });
  assert.equal(parsed?.status, "accepted");
});
