import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, type NostrEvent } from "nostr-tools";
import { calendarAddress, deriveBoardRsvpToken } from "taskify-core";
import type { MockRelay } from "../../taskify-runtime-nostr/tests/helpers/mockRelay.ts";
import { boardEvents, boardTagHash, deriveBoardKeyPair, runtimeHarness, START, tag, userPubkey } from "./helpers/runtimeHarness.ts";
import { runCli } from "../dist/cli.js";
import { captureConsole, harnessConfig, harnessDependencies } from "./helpers/cliHarness.ts";

/**
 * C12-4 step 3: the runtime's calendar behaviour, through a real session on a loopback relay.
 * Each event is a board-key copy (30310, board-encrypted) and an invitees' view (30311, under
 * the event's own key). These pin both so moving the calendar code can't change them. Payloads
 * are read with NIP-44 itself, as the PWA and iOS read them, not with the CLI's own helpers.
 */

const BOARD = "board-lists-1";
const WEEK = "board-week-1";
const CANONICAL = 30310;
const VIEW = 30311;
const friend = "ab".repeat(32);
const stranger = "cd".repeat(32);
const seconds = (ms: number) => Math.floor(ms / 1000);

const dinner = {
  boardId: BOARD,
  title: "Dinner",
  kind: "time" as const,
  startISO: "2026-10-26T18:00:00.000Z",
  endISO: "2026-10-26T19:00:00.000Z",
  startTzid: "Europe/London",
  description: "At home",
};

/** NIP-44 between the board's key and itself: what the board's members can read. */
function boardConversationKey(boardId: string): Uint8Array {
  const keys = deriveBoardKeyPair(boardId);
  return nip44.v2.utils.getConversationKey(Buffer.from(keys.skHex, "hex"), keys.pk);
}

function canonicalPayload(event: NostrEvent, boardId: string): Record<string, any> {
  return JSON.parse(nip44.v2.decrypt(event.content, boardConversationKey(boardId)));
}

/** NIP-44 under the event's own key (32 bytes, base64): what invitees can read. */
function viewPayload(event: NostrEvent, eventKey: string): Record<string, any> {
  return JSON.parse(nip44.v2.decrypt(event.content, Buffer.from(eventKey, "base64")));
}

/** The relay's invitee views of `eventId`, newest first. */
function viewEvents(relay: MockRelay, boardId: string, eventId: string): NostrEvent[] {
  const author = deriveBoardKeyPair(boardId).pk;
  return relay.events
    .filter((event) => event.kind === VIEW && event.pubkey === author && tag(event, "d") === eventId)
    .sort((a, b) => b.created_at - a.created_at);
}

test("creating an event publishes the board's copy and the invitees' view", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent({ ...dinner, participants: [{ pubkey: friend }], reminders: ["1h"] });
    assert.equal(created.id, "00000000-0000-4000-8000-000000000001");
    assert.equal(created.columnId, "todo", "a list board's first list when none is given");
    assert.equal(created.createdBy, userPubkey);
    assert.equal(created.createdAt, seconds(START));
    assert.deepEqual(Object.keys(created.inviteTokens ?? {}), [friend], "a token for each invitee, none for the sender");
    assert.ok(created.eventKey);

    const { pk } = deriveBoardKeyPair(BOARD);
    const [canonical, ...others] = boardEvents(h.relay, BOARD, CANONICAL);
    assert.equal(others.length, 0);
    assert.equal(canonical.pubkey, pk);
    assert.equal(canonical.created_at, seconds(START));
    assert.deepEqual(canonical.tags, [["d", created.id], ["b", boardTagHash(BOARD)], ["col", "todo"], ["status", "open"], ["entity", "event"]]);
    const payload = canonicalPayload(canonical, BOARD);
    assert.equal(payload.v, 1);
    assert.equal(payload.eventId, created.id);
    assert.equal(payload.eventKey, created.eventKey);
    assert.equal(payload.title, "Dinner");
    assert.equal(payload.kind, "time");
    assert.equal(payload.startISO, dinner.startISO);
    assert.equal(payload.description, "At home");
    assert.deepEqual(payload.participants, [{ pubkey: friend }]);
    assert.deepEqual(payload.inviteTokens, created.inviteTokens);
    assert.deepEqual(payload.reminders, ["1h"]);

    const [view, ...otherViews] = viewEvents(h.relay, BOARD, created.id);
    assert.equal(otherViews.length, 0);
    assert.equal(view.created_at, canonical.created_at);
    assert.deepEqual(view.tags, [["d", created.id], ["a", calendarAddress(CANONICAL, pk, created.id)]]);
    const viewed = viewPayload(view, created.eventKey);
    assert.equal(viewed.v, 1);
    assert.equal(viewed.eventId, created.id);
    assert.equal(viewed.title, "Dinner");
    for (const secret of ["eventKey", "inviteTokens", "participants"]) assert.equal(secret in viewed, false, `the view leaves out ${secret}`);
  } finally {
    await h.close();
  }
});

test("an event goes in the list it's given, and a week board's in no column", async () => {
  const h = await runtimeHarness();
  try {
    const later = await h.runtime.createEvent({ ...dinner, columnId: "later" });
    assert.equal(tag(boardEvents(h.relay, BOARD, CANONICAL)[0], "col"), "later");
    assert.equal(later.columnId, "later");
    const gym = await h.runtime.createEvent({ ...dinner, boardId: WEEK, title: "Gym" });
    assert.equal(tag(boardEvents(h.relay, WEEK, CANONICAL)[0], "col"), "");
    assert.equal(gym.columnId, undefined);
  } finally {
    await h.close();
  }
});

test("listing returns every board's events newest first, and getting finds one by id prefix", async () => {
  const h = await runtimeHarness();
  try {
    const first = await h.runtime.createEvent(dinner);
    h.advance(60_000);
    const second = await h.runtime.createEvent({ ...dinner, title: "Lunch" });
    h.advance(60_000);
    const gym = await h.runtime.createEvent({ ...dinner, boardId: WEEK, title: "Gym" });

    const onBoard = await h.runtime.listEvents({ boardId: "Groceries" });
    assert.deepEqual(onBoard.map((event) => event.title), ["Lunch", "Dinner"]);
    assert.equal(onBoard[0].boardName, "Groceries");
    assert.deepEqual((await h.runtime.listEvents({})).map((event) => event.id), [gym.id, second.id, first.id]);
    assert.deepEqual(await h.runtime.listEvents({ boardId: "Nowhere" }), []);

    const found = await h.runtime.getEvent(gym.id.slice(0, 8), WEEK);
    assert.equal(found?.title, "Gym");
    assert.equal(found?.startISO, dinner.startISO);
    assert.equal(found?.startTzid, "Europe/London");
    assert.equal(await h.runtime.getEvent("ffffffff", BOARD), null);
  } finally {
    await h.close();
  }
});

test("an id that matches events on two boards needs a board", async () => {
  const h = await runtimeHarness();
  try {
    await h.runtime.createEvent(dinner);
    const gym = await h.runtime.createEvent({ ...dinner, boardId: WEEK, title: "Gym" });
    const prefix = "00000000";
    await assert.rejects(h.runtime.getEvent(prefix), /Event id matches multiple boards; specify --board \(matches: Groceries, Week\)/);
    await assert.rejects(h.runtime.updateEvent(prefix, undefined, { title: "X" }), /matches multiple boards/);
    await assert.rejects(h.runtime.deleteEvent(prefix, undefined), /matches multiple boards/);
    assert.equal((await h.runtime.getEvent(prefix, WEEK))?.id, gym.id);
  } finally {
    await h.close();
  }
});

test("an update republishes both copies later, keeping what it didn't change", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent({ ...dinner, participants: [{ pubkey: friend }] });
    h.advance(60_000);
    const updated = await h.runtime.updateEvent(created.id, BOARD, { title: "Late dinner" });
    assert.equal(updated?.title, "Late dinner");
    assert.equal(updated?.description, "At home");
    assert.equal(updated?.eventKey, created.eventKey);
    assert.deepEqual(updated?.inviteTokens, created.inviteTokens);
    assert.equal(updated?.columnId, "todo");
    assert.equal(updated?.createdAt, seconds(START + 60_000));

    const [canonical] = boardEvents(h.relay, BOARD, CANONICAL);
    assert.equal(canonical.created_at, seconds(START + 60_000));
    assert.equal(tag(canonical, "col"), "todo");
    const payload = canonicalPayload(canonical, BOARD);
    assert.equal(payload.title, "Late dinner");
    assert.equal(payload.startISO, dinner.startISO);
    assert.equal(payload.createdBy, userPubkey);
    assert.deepEqual(payload.participants, [{ pubkey: friend }]);
    const [view] = viewEvents(h.relay, BOARD, created.id);
    assert.equal(view.created_at, canonical.created_at);
    assert.equal(viewPayload(view, created.eventKey).title, "Late dinner");

    // In the same second: still a later version.
    await h.runtime.updateEvent(created.id, BOARD, { description: "At Sam's" });
    assert.equal(boardEvents(h.relay, BOARD, CANONICAL)[0].created_at, seconds(START + 60_000) + 1);
  } finally {
    await h.close();
  }
});

test("invite tokens follow the participants", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent({ ...dinner, participants: [{ pubkey: friend }] });
    h.advance(60_000);
    const updated = await h.runtime.updateEvent(created.id, BOARD, { participants: [{ pubkey: stranger }] });
    assert.deepEqual(Object.keys(updated?.inviteTokens ?? {}), [stranger]);
    assert.notEqual(updated?.inviteTokens?.[stranger], created.inviteTokens?.[friend]);
    assert.equal(updated?.eventKey, created.eventKey);
    assert.deepEqual((canonicalPayload(boardEvents(h.relay, BOARD, CANONICAL)[0], BOARD)).inviteTokens, updated?.inviteTokens);
  } finally {
    await h.close();
  }
});

test("inviting adds the invitee with a token and returns where the event is", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent(dinner);
    h.advance(60_000);
    const invitation = await h.runtime.inviteToEvent(created.id.slice(0, 8), BOARD, friend);
    const { pk } = deriveBoardKeyPair(BOARD);
    assert.ok(invitation?.inviteToken);
    assert.equal(invitation?.event.inviteTokens?.[friend], invitation?.inviteToken);
    assert.equal(invitation?.canonical, calendarAddress(CANONICAL, pk, created.id));
    assert.equal(invitation?.view, calendarAddress(VIEW, pk, created.id));
    assert.deepEqual(invitation?.relays, [h.relay.url]);
    assert.deepEqual((canonicalPayload(boardEvents(h.relay, BOARD, CANONICAL)[0], BOARD)).participants, [{ pubkey: friend }]);

    h.advance(60_000);
    const again = await h.runtime.inviteToEvent(created.id, BOARD, friend);
    assert.equal(again?.inviteToken, invitation?.inviteToken, "inviting twice keeps the token");
    assert.deepEqual(again?.event.participants, [{ pubkey: friend }]);

    await assert.rejects(h.runtime.inviteToEvent(created.id, BOARD, userPubkey), /You can't invite yourself/);
    assert.equal(await h.runtime.inviteToEvent("ffffffff", BOARD, friend), null);
  } finally {
    await h.close();
  }
});

test("deleting publishes deleted copies that listing and getting leave out", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent(dinner);
    h.advance(60_000);
    const deleted = await h.runtime.deleteEvent(created.id, BOARD);
    assert.equal(deleted?.deleted, true);
    assert.equal(deleted?.title, "Dinner");

    const [canonical] = boardEvents(h.relay, BOARD, CANONICAL);
    assert.equal(canonical.created_at, seconds(START + 60_000));
    assert.deepEqual(canonical.tags, [["d", created.id], ["b", boardTagHash(BOARD)], ["col", ""], ["status", "deleted"], ["entity", "event"]]);
    const payload = canonicalPayload(canonical, BOARD);
    assert.equal(payload.deleted, true);
    assert.equal(payload.eventKey, created.eventKey);
    const [view] = viewEvents(h.relay, BOARD, created.id);
    assert.equal(viewPayload(view, created.eventKey).deleted, true);

    assert.deepEqual(await h.runtime.listEvents({ boardId: BOARD }), []);
    assert.equal(await h.runtime.getEvent(created.id, BOARD), null);
    assert.equal(await h.runtime.deleteEvent(created.id, BOARD), null);
    assert.equal(await h.runtime.updateEvent(created.id, BOARD, { title: "Back" }), null);
  } finally {
    await h.close();
  }
});

/** An attendee's kind 30312 answer as the PWA and iOS publish it: NIP-44 to the board's key. */
function rsvpEvent(attendee: Uint8Array, boardId: string, eventId: string, payload: Record<string, unknown>, createdAt: number, address?: string): NostrEvent {
  const board = deriveBoardKeyPair(boardId).pk;
  const canonical = address ?? calendarAddress(CANONICAL, board, eventId);
  return finalizeEvent({
    kind: 30312,
    created_at: createdAt,
    content: nip44.v2.encrypt(JSON.stringify(payload), nip44.v2.utils.getConversationKey(attendee, board)),
    tags: [["d", `${eventId}:${getPublicKey(attendee)}`], ["a", canonical]],
  }, attendee);
}

test("an organizer reads each attendee's newest RSVP from their own events", async () => {
  const h = await runtimeHarness();
  try {
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const member = generateSecretKey();
    const intruder = generateSecretKey();
    const created = await h.runtime.createEvent({ ...dinner, participants: [{ pubkey: getPublicKey(alice) }, { pubkey: getPublicKey(bob) }] });
    const tokens = created.inviteTokens ?? {};
    const answer = (status: string, inviteToken: string, extra: Record<string, unknown> = {}) => ({ v: 1, eventId: created.id, status, inviteToken, ...extra });
    const t = seconds(START);
    const before = h.relay.events.length;
    h.relay.events.push(
      rsvpEvent(alice, BOARD, created.id, answer("tentative", tokens[getPublicKey(alice)]), t + 10),
      rsvpEvent(alice, BOARD, created.id, answer("accepted", tokens[getPublicKey(alice)], { fb: "busy", note: "Bringing dessert" }), t + 20),
      rsvpEvent(bob, BOARD, created.id, answer("declined", tokens[getPublicKey(bob)]), t + 15),
      // A board member who wasn't invited answers with the token derived for them.
      rsvpEvent(member, BOARD, created.id, answer("accepted", await deriveBoardRsvpToken(BOARD, getPublicKey(member))), t + 5),
      // No invitation's token; another event's answer filed under this address.
      rsvpEvent(intruder, BOARD, created.id, answer("accepted", "guessed"), t + 30),
      rsvpEvent(bob, BOARD, created.id, { ...answer("accepted", tokens[getPublicKey(bob)]), eventId: "another-event" }, t + 40),
    );

    const rsvps = await h.runtime.listEventRsvps(created.id.slice(0, 8), BOARD);
    const byAttendee = Object.fromEntries((rsvps ?? []).map((r) => [r.attendeePubkey, r]));
    assert.deepEqual(Object.keys(byAttendee).sort(), [getPublicKey(alice), getPublicKey(bob), getPublicKey(member)].sort());
    assert.equal(byAttendee[getPublicKey(alice)].status, "accepted");
    assert.equal(byAttendee[getPublicKey(alice)].fb, "busy");
    assert.equal(byAttendee[getPublicKey(alice)].note, "Bringing dessert");
    assert.equal(byAttendee[getPublicKey(alice)].createdAt, t + 20);
    assert.equal(byAttendee[getPublicKey(bob)].status, "declined");
    assert.equal(byAttendee[getPublicKey(member)].status, "accepted");

    assert.equal(h.relay.events.length, before + 6, "reading answers publishes nothing");
    assert.equal(boardEvents(h.relay, BOARD, CANONICAL).length, 1);
    assert.equal(await h.runtime.listEventRsvps("ffffffff", BOARD), null);
  } finally {
    await h.close();
  }
});

test("an invitee's `event rsvp` reaches the organizer through the relay", async () => {
  const h = await runtimeHarness();
  try {
    const attendee = generateSecretKey();
    const attendeePubkey = getPublicKey(attendee);
    const created = await h.runtime.createEvent(dinner);
    const invitation = await h.runtime.inviteToEvent(created.id, BOARD, attendeePubkey);
    assert.ok(invitation);

    // The invitee's own CLI: their key, the invitation in their inbox, and a real standalone
    // session publishing to the loopback relay.
    const config = structuredClone(harnessConfig);
    config.nsec = nip19.nsecEncode(attendee);
    config.relays = [h.relay.url];
    config.profiles.test = { ...config.profiles.test, nsec: config.nsec, relays: config.relays };
    const { dependencies } = harnessDependencies({}, {
      now: () => new Date(START + 120_000),
      shareTransport: {
        send: async () => { throw new Error("no message should be sent"); },
        fetchInbox: async () => [{
          wrapId: "w", rumorId: "r", senderPubkey: userPubkey, createdAt: seconds(START), raw: "",
          envelope: { v: 1, kind: "taskify-share", item: {
            type: "event", eventId: invitation.event.id, canonical: invitation.canonical, view: invitation.view,
            eventKey: invitation.event.eventKey, inviteToken: invitation.inviteToken, relays: invitation.relays,
          } },
        }] as never,
      },
    }, config);
    const answered = await captureConsole(() => runCli(["node", "taskify", "event", "rsvp", created.id, "accepted", "--note", "See you there"], dependencies));
    assert.equal(answered.status, 0, answered.stderr.join("\n"));

    const rsvps = await h.runtime.listEventRsvps(created.id, BOARD);
    assert.deepEqual(rsvps?.map((r) => [r.attendeePubkey, r.status, r.note, r.createdAt]), [[attendeePubkey, "accepted", "See you there", seconds(START + 120_000)]]);
    assert.equal(boardEvents(h.relay, BOARD, CANONICAL).length, 1, "the board's copy is untouched");
  } finally {
    await h.close();
  }
});

test("an RSVP an older CLI wrote onto the board's copy is no one's answer", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent(dinner);
    const keys = deriveBoardKeyPair(BOARD);
    const [canonical] = boardEvents(h.relay, BOARD, CANONICAL);
    const stale = { ...canonicalPayload(canonical, BOARD), rsvpStatus: "accepted", rsvpCreatedAt: seconds(START) };
    h.relay.events.push(finalizeEvent({
      kind: CANONICAL,
      created_at: seconds(START) + 60,
      content: nip44.v2.encrypt(JSON.stringify(stale), boardConversationKey(BOARD)),
      tags: canonical.tags,
    }, Buffer.from(keys.skHex, "hex")));

    const event = await h.runtime.getEvent(created.id, BOARD);
    assert.equal(event?.title, "Dinner");
    assert.equal("rsvpStatus" in (event ?? {}), false);
    assert.deepEqual(await h.runtime.listEventRsvps(created.id, BOARD), []);
  } finally {
    await h.close();
  }
});

test("calendar events not signed with the board's key are ignored", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent(dinner);
    const intruder = generateSecretKey();
    const forge = (id: string, title: string, createdAt: number) => finalizeEvent({
      kind: CANONICAL,
      created_at: createdAt,
      content: nip44.v2.encrypt(JSON.stringify({ v: 1, eventId: id, eventKey: created.eventKey, kind: "date", title, startDate: "2026-10-26" }), boardConversationKey(BOARD)),
      tags: [["d", id], ["b", boardTagHash(BOARD)], ["col", ""], ["status", "open"], ["entity", "event"]],
    }, intruder);
    h.relay.events.push(forge("forged-1", "Pay me", seconds(START)), forge(created.id, "Hijacked", seconds(START) + 600));

    assert.deepEqual((await h.runtime.listEvents({ boardId: BOARD })).map((event) => event.title), ["Dinner"]);
    assert.equal(await h.runtime.getEvent("forged-1", BOARD), null);
    assert.equal((await h.runtime.getEvent(created.id, BOARD))?.title, "Dinner");
  } finally {
    await h.close();
  }
});

test("calendar changes build on the newest version when a relay still serves an older one", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent(dinner);
    const [first] = boardEvents(h.relay, BOARD, CANONICAL);
    h.advance(60_000);
    await h.runtime.updateEvent(created.id, BOARD, { title: "Late dinner" });
    h.relay.events.push(first);

    assert.equal((await h.runtime.getEvent(created.id, BOARD))?.title, "Late dinner");
    assert.deepEqual((await h.runtime.listEvents({ boardId: BOARD })).map((event) => event.title), ["Late dinner"]);
    h.advance(60_000);
    await h.runtime.updateEvent(created.id, BOARD, { description: "At Sam's" });
    const payload = canonicalPayload(boardEvents(h.relay, BOARD, CANONICAL)[0], BOARD);
    assert.equal(payload.title, "Late dinner");
    assert.equal(payload.description, "At Sam's");
  } finally {
    await h.close();
  }
});

test("an event is created on a board given by name, and an unknown board is refused", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createEvent({ ...dinner, boardId: "Groceries" });
    assert.equal(created.boardId, BOARD);
    assert.equal(created.boardName, "Groceries");
    assert.equal(created.columnId, "todo");
    const [canonical] = boardEvents(h.relay, BOARD, CANONICAL);
    assert.equal(canonical?.pubkey, deriveBoardKeyPair(BOARD).pk);
    assert.equal(canonicalPayload(canonical, BOARD).eventId, created.id);

    const before = h.relay.events.length;
    await assert.rejects(h.runtime.createEvent({ ...dinner, boardId: "Nowhere" }), /Board not found in config: "Nowhere"/);
    assert.equal(h.relay.events.length, before, "nothing published");
  } finally {
    await h.close();
  }
});
