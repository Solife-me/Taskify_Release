import test from "node:test";
import assert from "node:assert/strict";
import { parseCalendarCanonicalPayload, parseCalendarViewPayload } from "taskify-core";
import {
  buildCalendarCanonicalEnvelope,
  buildCalendarViewEnvelope,
} from "../src/shared/calendarEnvelope.ts";

const EVENT_KEY = Buffer.alloc(32, 7).toString("base64");

test("CLI calendar create payload is accepted by the canonical PWA/core decoder", () => {
  const canonical = buildCalendarCanonicalEnvelope("event-1", EVENT_KEY, {
    kind: "date",
    title: "Offsite",
    startDate: "2026-07-20",
    createdBy: "a".repeat(64),
  });

  const decoded = parseCalendarCanonicalPayload(canonical);
  assert.ok(decoded);
  assert.equal(decoded.eventId, "event-1");
  assert.equal(decoded.eventKey, EVENT_KEY);
  assert.equal(decoded.title, "Offsite");
});

test("calendar updates and deletes preserve the original event key", () => {
  const created = buildCalendarCanonicalEnvelope("event-1", EVENT_KEY, {
    kind: "time",
    title: "Standup",
    startISO: "2026-07-20T14:00:00.000Z",
  });
  const updated = buildCalendarCanonicalEnvelope(created.eventId, created.eventKey, {
    ...created,
    title: "Updated standup",
  });
  const deleted = buildCalendarCanonicalEnvelope(updated.eventId, updated.eventKey, {
    deleted: true,
  });

  assert.equal(parseCalendarCanonicalPayload(updated)?.eventKey, EVENT_KEY);
  assert.equal(parseCalendarCanonicalPayload(deleted)?.eventKey, EVENT_KEY);
  assert.equal(parseCalendarCanonicalPayload(deleted)?.deleted, true);
});

test("calendar view envelope omits board-only event secrets", () => {
  const canonical = buildCalendarCanonicalEnvelope("event-1", EVENT_KEY, {
    kind: "date",
    title: "Offsite",
    startDate: "2026-07-20",
    participants: [{ pubkey: "b".repeat(64) }],
    inviteTokens: { ["b".repeat(64)]: "invite-secret" },
  });
  const view = buildCalendarViewEnvelope(canonical);

  assert.ok(parseCalendarViewPayload(view));
  assert.equal("eventKey" in view, false);
  assert.equal("inviteTokens" in view, false);
  assert.equal("participants" in view, false);
});
