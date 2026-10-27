/**
 * Event RSVPs (C12-7): the attendee's kind 30312 event, the organizer's acceptance check, the
 * board-derived token and the newest response per attendee. The fixture is written from the core
 * rule (WRITE_CALENDAR_RSVP_VECTORS=1) and checked here and by Swift `CalendarRsvpVectorTests`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { acceptCalendarRsvp, deriveBoardRsvpToken, latestCalendarRsvps, planCalendarRsvp } from "../dist/index.js";

const FIXTURE = new URL("../fixtures/calendar-rsvp-vectors.json", import.meta.url);
const A = "a".repeat(64);
const B = "b".repeat(64);
const ORGANIZER = "c".repeat(64);
const EVENT = "event-1";
const CANONICAL = `30310:${ORGANIZER}:${EVENT}`;

const boardTokenCases = [
  { name: "a board member's token", input: { boardId: "board-1", attendeePubkey: A } },
  { name: "the board id is trimmed and the key lowercased", input: { boardId: " board-1 ", attendeePubkey: A.toUpperCase() } },
  { name: "another board and member", input: { boardId: "calendar-board-secret", attendeePubkey: B } },
];

const planBase = { canonical: CANONICAL, eventId: EVENT, attendeePubkey: A, status: "accepted", inviteToken: "token-a" };
const planCases = [
  { name: "an acceptance", input: planBase },
  { name: "a tentative answer with free/busy and a note, normalized",
    input: { canonical: `30310:${ORGANIZER.toUpperCase()}:event:part`, eventId: "event:part", attendeePubkey: A.toUpperCase(), status: "tentative", inviteToken: "  token  ", fb: "busy", note: "  Running late  " } },
  { name: "an unknown free/busy value and a blank note are left out", input: { ...planBase, status: "declined", fb: "maybe", note: "   " } },
  { name: "not a calendar address", input: { ...planBase, canonical: "bad" } },
  { name: "the invitees' view address is not the event's", input: { ...planBase, canonical: `30311:${ORGANIZER}:${EVENT}` } },
  { name: "the address names another event", input: { ...planBase, eventId: "event-2" } },
  { name: "no attendee key", input: { ...planBase, attendeePubkey: "not-a-key" } },
  { name: "not an RSVP status", input: { ...planBase, status: "maybe" } },
  { name: "no invite token", input: { ...planBase, inviteToken: "  " } },
  { name: "a missing invite token", input: { ...planBase, inviteToken: null } },
];

const acceptBase = {
  rsvp: { kind: 30312, pubkey: A, created_at: 1_785_775_200, tags: [["d", `${EVENT}:${A}`], ["a", CANONICAL]] },
  payload: { v: 1, eventId: EVENT, status: "accepted", inviteToken: "token-a" } as Record<string, unknown>,
  event: { id: EVENT, canonicalAddress: CANONICAL, inviteTokens: { [A]: "token-a", [B]: "token-b" } as Record<string, string> | null },
  boardToken: "board-token-a",
};
const withPayload = (changes: Record<string, unknown>) => ({ ...acceptBase, payload: { ...acceptBase.payload, ...changes } });
const withRsvp = (changes: Record<string, unknown>) => ({ ...acceptBase, rsvp: { ...acceptBase.rsvp, ...changes } });
const acceptCases = [
  { name: "the attendee's own token", input: acceptBase },
  { name: "free/busy and a note are kept", input: withPayload({ status: "tentative", fb: "free", note: "Bringing dessert" }) },
  { name: "another invitee's token counts too", input: withPayload({ inviteToken: "token-b" }) },
  { name: "a board member's derived token", input: withPayload({ inviteToken: "board-token-a" }) },
  { name: "the author's key is lowercased", input: withRsvp({ pubkey: A.toUpperCase() }) },
  { name: "not an RSVP event", input: withRsvp({ kind: 30311 }) },
  { name: "no author key", input: withRsvp({ pubkey: "not-a-key" }) },
  { name: "no address", input: withRsvp({ tags: [["d", `${EVENT}:${A}`]] }) },
  { name: "another event's address", input: withRsvp({ tags: [["d", `${EVENT}:${A}`], ["a", `30310:${ORGANIZER}:event-2`]] }) },
  { name: "another payload version", input: withPayload({ v: 2 }) },
  { name: "not an RSVP status", input: withPayload({ status: "maybe" }) },
  { name: "an empty token", input: withPayload({ inviteToken: "" }) },
  { name: "a payload for another event", input: withPayload({ eventId: "event-2" }) },
  { name: "a token the event doesn't have", input: withPayload({ inviteToken: "token-z" }) },
  { name: "an event with no tokens takes only the board-derived one", input: { ...acceptBase, event: { ...acceptBase.event, inviteTokens: null } } },
];

const response = (attendeePubkey: string, createdAt: number, status: string, inviteToken: string) => ({ eventId: EVENT, attendeePubkey, createdAt, status, inviteToken });
const latestCases = [
  { name: "the newest per attendee, ordered by attendee",
    input: [response(B, 100, "declined", "token-b"), response(A, 200, "accepted", "token-a"), response(A, 100, "tentative", "token-a"), response(B, 50, "accepted", "token-b")] },
  { name: "on a tie, the larger token", input: [response(A, 100, "accepted", "token-a"), response(A, 100, "declined", "token-c"), response(A, 100, "tentative", "token-b")] },
  { name: "nothing", input: [] },
];

async function buildVectors() {
  return {
    description:
      "Event RSVPs: an attendee's kind 30312 event (`d` <eventId>:<attendee>, `a` the event's canonical address, payload {v, eventId, status, inviteToken, fb?, note?}, NIP-44 to the board's key); the organizer's acceptance check (kind, author, address, payload, event id, then a token of the event's or the attendee's board-derived token, in that order); the board-derived token, base64(sha256(\"taskify-board-rsvp-token-v1\" ‖ \"<boardId>:<attendee>\")); and the newest response per attendee (on a tie the larger token), ordered by attendee. Written by taskify-core tests/calendar-rsvp-vectors.test.ts (WRITE_CALENDAR_RSVP_VECTORS=1); checked there and by Swift CalendarRsvpVectorTests.",
    boardTokens: await Promise.all(boardTokenCases.map(async ({ name, input }) => ({ name, input, expected: await deriveBoardRsvpToken(input.boardId, input.attendeePubkey) }))),
    plans: planCases.map(({ name, input }) => ({ name, input, expected: planCalendarRsvp(input as never) })),
    acceptance: acceptCases.map(({ name, input }) => ({ name, input, expected: acceptCalendarRsvp(input as never) })),
    latest: latestCases.map(({ name, input }) => ({ name, input, expected: latestCalendarRsvps(input as never) })),
  };
}

if (process.env.WRITE_CALENDAR_RSVP_VECTORS === "1") {
  writeFileSync(FIXTURE, `${JSON.stringify(await buildVectors(), null, 2)}\n`);
}

test("the calendar RSVP fixture matches the core rule", async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(fixture, await buildVectors());
});

test("the board-derived token is sha256 of the label, board id and attendee, in base64", async () => {
  const expected = createHash("sha256").update(`taskify-board-rsvp-token-v1board-1:${A}`).digest("base64");
  assert.equal(await deriveBoardRsvpToken("board-1", A), expected);
});

test("every acceptance vector either accepts or names one reason", async () => {
  const { acceptance } = await buildVectors();
  const reasons = new Set(acceptance.filter((vector) => !vector.expected.accepted).map((vector) => (vector.expected as { reason: string }).reason));
  assert.deepEqual([...reasons].sort(), ["address", "author", "event", "kind", "payload", "token"]);
});
