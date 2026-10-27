/**
 * Calendar invitation secrets (C12-2 follow-up): which invitees get a token, which tokens are kept,
 * and when the event key is replaced. The fixture is written from `planEventInvitations`
 * (WRITE_EVENT_INVITATION_VECTORS=1) and checked here and by Swift `EventInvitationVectorTests`.
 * Generated tokens come from the sequence token-1, token-2, …; a generated event key is recorded
 * as "generated" since iOS can't inject its key generator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isValidEventKey, planEventInvitations } from "../dist/index.js";

const FIXTURE = new URL("../fixtures/event-invitation-vectors.json", import.meta.url);
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SENDER = "d".repeat(64);

const cases = [
  { name: "a new event gets a key and a token per invitee",
    input: { eventKey: null, inviteTokens: null, participantPubkeys: [A, B], previousPubkeys: [], senderPubkey: SENDER } },
  { name: "existing tokens are kept, a new invitee gets one, a removed one loses theirs",
    input: { eventKey: KEY, inviteTokens: { [A]: "kept-a", [B]: "kept-b" }, participantPubkeys: [A, C], previousPubkeys: [A, B], senderPubkey: SENDER } },
  { name: "the sender is never their own invitee",
    input: { eventKey: KEY, inviteTokens: { [A]: "kept-a" }, participantPubkeys: [SENDER, A], previousPubkeys: [A], senderPubkey: SENDER } },
  { name: "two spellings of one key are one invitee, and the canonical spelling's token wins",
    input: { eventKey: KEY, inviteTokens: { [A.toUpperCase()]: "upper", [A]: "lower" }, participantPubkeys: [A.toUpperCase(), A], previousPubkeys: [A], senderPubkey: null } },
  { name: "invalid keys are not invitees",
    input: { eventKey: KEY, inviteTokens: null, participantPubkeys: ["not-a-key", "", B], previousPubkeys: [], senderPubkey: null } },
  { name: "a malformed event key is replaced",
    input: { eventKey: "short", inviteTokens: { [A]: "kept-a" }, participantPubkeys: [A], previousPubkeys: [A], senderPubkey: null } },
  { name: "with nobody invited the tokens go",
    input: { eventKey: KEY, inviteTokens: { [A]: "kept-a" }, participantPubkeys: [], previousPubkeys: [A], senderPubkey: null } },
  { name: "nothing to change",
    input: { eventKey: KEY, inviteTokens: { [A]: "kept-a" }, participantPubkeys: [A], previousPubkeys: [A], senderPubkey: SENDER } },
];

function run(input: (typeof cases)[number]["input"]) {
  let n = 0;
  const plan = planEventInvitations(input, {
    eventKey: () => "generated-key",
    inviteToken: () => `token-${++n}`,
  });
  return {
    eventKey: plan.eventKey === "generated-key" ? "generated" : "kept",
    inviteTokens: plan.inviteTokens ?? null,
    inviteePubkeys: plan.inviteePubkeys,
    addedPubkeys: plan.addedPubkeys,
    changed: plan.changed,
  };
}

function buildVectors() {
  return {
    description:
      "Calendar invitation secrets: tokens per invitee (sender excluded, duplicates merged, removed invitees dropped, existing tokens kept; between two spellings of one key, the lowercase-hex spelling's token, then the smallest), and the event key kept unless missing or not 32 bytes of base64. Generated tokens are token-1, token-2, … in invitee order; eventKey is \"kept\" or \"generated\". Written by taskify-core tests/event-invitation-vectors.test.ts (WRITE_EVENT_INVITATION_VECTORS=1); checked there and by Swift EventInvitationVectorTests.",
    vectors: cases.map(({ name, input }) => ({ name, input, expected: run(input) })),
  };
}

if (process.env.WRITE_EVENT_INVITATION_VECTORS === "1") {
  writeFileSync(FIXTURE, `${JSON.stringify(buildVectors(), null, 2)}\n`);
}

test("the event invitation fixture matches planEventInvitations", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReturnType<typeof buildVectors>;
  assert.deepEqual(fixture, buildVectors());
});

test("event keys are 32 bytes of base64", () => {
  assert.equal(isValidEventKey(KEY), true);
  assert.equal(isValidEventKey("short"), false);
  assert.equal(isValidEventKey(btoa("x".repeat(16))), false);
  assert.equal(isValidEventKey(null), false);
});
