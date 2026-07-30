import test from "node:test";
import assert from "node:assert/strict";
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  TASKIFY_CALENDAR_RSVP_KIND,
  calendarAddress,
  calendarRecurrenceSyncFields,
  parseCalendarAddress,
} from "../dist/calendarProtocol.js";

test("calendar protocol constants are stable", () => {
  assert.equal(TASKIFY_CALENDAR_EVENT_KIND, 30310);
  assert.equal(TASKIFY_CALENDAR_VIEW_KIND, 30311);
  assert.equal(TASKIFY_CALENDAR_RSVP_KIND, 30312);
});

test("calendarAddress + parseCalendarAddress round-trip", () => {
  const pubkey = "a".repeat(64);
  const coord = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, pubkey, "board:my:event");
  const parsed = parseCalendarAddress(coord);

  assert.deepEqual(parsed, {
    kind: TASKIFY_CALENDAR_EVENT_KIND,
    pubkey,
    d: "board:my:event",
  });
});

test("parseCalendarAddress rejects invalid inputs", () => {
  assert.equal(parseCalendarAddress(""), null);
  assert.equal(parseCalendarAddress("30310:short:abc"), null);
  assert.equal(parseCalendarAddress("nan:" + "a".repeat(64) + ":abc"), null);
  assert.equal(parseCalendarAddress("30310:" + "a".repeat(64) + ":"), null);
});

test("calendarRecurrenceSyncFields carries the stable series cutoff into tombstones", () => {
  const recurrence = {
    type: "daily",
    untilISO: "2026-07-28T00:00:00.000Z",
  };
  assert.deepEqual(
    calendarRecurrenceSyncFields({
      id: "recurrence:event-series:2026-07-29",
      recurrence,
      seriesId: "event-series",
    }),
    {
      recurrence,
      seriesId: "event-series",
    },
  );
  assert.deepEqual(
    calendarRecurrenceSyncFields({ id: "one-off" }),
    {},
  );
});
