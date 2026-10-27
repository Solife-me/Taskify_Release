import test from "node:test";
import assert from "node:assert/strict";
import { nip19 } from "nostr-tools";
import { eventInvitationSecrets, participantPubkeyHex, withInvitee } from "../src/shared/eventInvite.ts";

/** The CLI keeps calendar invite tokens in step with participants, by the shared core rule. */

const A = "a".repeat(64);
const B = "b".repeat(64);
const SENDER = "d".repeat(64);
const KEY = btoa("k".repeat(32));

function generators() {
  let n = 0;
  return { eventKey: () => "new-key", inviteToken: () => `token-${++n}` };
}

test("participant keys may be npubs or hex in any case", () => {
  assert.equal(participantPubkeyHex(nip19.npubEncode(A)), A);
  assert.equal(participantPubkeyHex(A.toUpperCase()), A);
  assert.equal(participantPubkeyHex("npub1notvalid"), null);
  assert.equal(participantPubkeyHex("nope"), null);
});

test("an invitee is added once, whichever spelling the event already has", () => {
  assert.deepEqual(withInvitee([{ pubkey: nip19.npubEncode(A), role: "attendee" }], A), [{ pubkey: nip19.npubEncode(A), role: "attendee" }]);
  assert.deepEqual(withInvitee([{ pubkey: A }], B), [{ pubkey: A }, { pubkey: B }]);
  assert.deepEqual(withInvitee(undefined, B), [{ pubkey: B }]);
});

test("each invitee gets a token, existing ones are kept, and the sender gets none", () => {
  const secrets = eventInvitationSecrets(
    { eventKey: KEY, inviteTokens: { [A]: "kept-a" } },
    [{ pubkey: nip19.npubEncode(A) }, { pubkey: B }, { pubkey: SENDER }],
    SENDER,
    generators(),
  );
  assert.deepEqual(secrets, { eventKey: KEY, inviteTokens: { [A]: "kept-a", [B]: "token-1" } });
});

test("a new event gets a key, and an event with nobody invited carries no tokens", () => {
  assert.deepEqual(eventInvitationSecrets({}, [{ pubkey: A }], SENDER, generators()), { eventKey: "new-key", inviteTokens: { [A]: "token-1" } });
  assert.deepEqual(eventInvitationSecrets({ eventKey: KEY, inviteTokens: { [A]: "old" } }, [], SENDER, generators()), { eventKey: KEY, inviteTokens: undefined });
});
