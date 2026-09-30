import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44, nip59 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { unwrapShareGiftWrap } from "./shareInbox";

const recipientSecret = generateSecretKey();
const recipient = getPublicKey(recipientSecret);
const envelope = JSON.stringify({
  v: 1,
  kind: "taskify-share",
  item: { type: "task-assignment-response", taskId: "t-1", status: "declined", respondedAt: "2026-09-30T12:00:00.000Z" },
});

function genuineWrap(senderSecret: Uint8Array, kind = 14) {
  const rumor = nip59.createRumor({ kind, content: envelope, tags: [["p", recipient]] }, senderSecret);
  const seal = nip59.createSeal(rumor, senderSecret, recipient);
  return nip59.createWrap(seal, recipient);
}

// A stranger seals, with their own key, a rumor that names someone else as its author.
function forgedWrap(attackerSecret: Uint8Array, claimedSender: string) {
  const rumorBase = { kind: 14, created_at: 1_790_000_000, tags: [["p", recipient]], content: envelope, pubkey: claimedSender };
  const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: 1_790_000_000,
      tags: [],
      content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(attackerSecret, recipient)),
    },
    attackerSecret,
  );
  return nip59.createWrap(seal, recipient);
}

describe("unwrapShareGiftWrap", () => {
  it("opens a share and reports the seal's author as the sender", () => {
    const senderSecret = generateSecretKey();
    const opened = unwrapShareGiftWrap(genuineWrap(senderSecret), bytesToHex(recipientSecret));
    expect(opened).toEqual({ content: envelope, senderPubkey: getPublicKey(senderSecret), tags: [["p", recipient]] });
  });

  it("rejects a share whose rumor claims a sender other than the one who sealed it", () => {
    const trustedContact = getPublicKey(generateSecretKey());
    const wrap = forgedWrap(generateSecretKey(), trustedContact);
    expect(unwrapShareGiftWrap(wrap, bytesToHex(recipientSecret))).toBeNull();
  });

  it("rejects a wrap addressed to someone else", () => {
    const wrap = genuineWrap(generateSecretKey());
    expect(unwrapShareGiftWrap(wrap, bytesToHex(generateSecretKey()))).toBeNull();
  });

  it("ignores rumors that are not chat messages and events that are not gift wraps", () => {
    const secretHex = bytesToHex(recipientSecret);
    expect(unwrapShareGiftWrap(genuineWrap(generateSecretKey(), 15), secretHex)).toBeNull();
    const notAWrap = finalizeEvent({ kind: 1, created_at: 1_790_000_000, tags: [], content: envelope }, generateSecretKey());
    expect(unwrapShareGiftWrap(notAWrap, secretHex)).toBeNull();
  });
});
