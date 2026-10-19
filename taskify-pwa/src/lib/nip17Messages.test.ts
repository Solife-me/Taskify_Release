import { describe, expect, test, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44, nip59 } from "nostr-tools";
import { createNip17Rumor, openNip17GiftWrap } from "taskify-core";
import { nip17Crypto } from "taskify-runtime-nostr";
import { LocalKeySigner } from "../identity/signer";
import { giftWrapNip17Rumor, nip17TimestampSource } from "./nip17Messages";

// Signing for relays mines proof of work over the network; here it just signs.
vi.mock("../nostr/prepareRelayEvent", () => ({
  prepareRelayEvent: async (template: Parameters<typeof finalizeEvent>[0], secretKey: Uint8Array) =>
    finalizeEvent(template, secretKey),
}));

describe("giftWrapNip17Rumor", () => {
  test("wraps once per recipient and once for the sender, each opening to the same message", async () => {
    const sender = new LocalKeySigner(bytesToHex(generateSecretKey()));
    const bobSecret = generateSecretKey();
    const bob = new LocalKeySigner(bytesToHex(bobSecret));
    const rumor = createNip17Rumor({ sender: sender.pubkey, recipients: [bob.pubkey], content: "hi", createdAt: 1_790_000_000 }, nip17Crypto);

    const wraps = await giftWrapNip17Rumor(rumor, sender, ["wss://relay.example"], nip17TimestampSource("now"));

    expect(wraps.map((w) => w.recipient).sort()).toEqual([bob.pubkey, sender.pubkey].sort());
    expect(new Set(wraps.map((w) => w.wrap.pubkey)).size).toBe(2); // distinct one-time keys
    expect(wraps.every((w) => w.wrap.pubkey !== sender.pubkey)).toBe(true);
    for (const { recipient, wrap } of wraps) {
      const opened = await openNip17GiftWrap(wrap, recipient === bob.pubkey ? bob : sender, nip17Crypto);
      expect(opened).toMatchObject({ senderPubkey: sender.pubkey, rumor: { id: rumor.id, content: "hi" } });
    }
    expect(getPublicKey(bobSecret)).toBe(bob.pubkey);
  });

  test("random timestamps fall within the last two days", () => {
    const now = Date.now() / 1000;
    const stamp = nip17TimestampSource("random")();
    expect(stamp).toBeLessThanOrEqual(now);
    expect(stamp).toBeGreaterThan(now - 2 * 86_400 - 1);
  });
});

describe("opening wraps built by nostr-tools' NIP-59", () => {
  const recipientSecret = generateSecretKey();
  const recipient = new LocalKeySigner(bytesToHex(recipientSecret));
  const content = JSON.stringify({ v: 1, kind: "taskify-share", item: { type: "task", title: "x" } });

  function genuineWrap(senderSecret: Uint8Array) {
    const rumor = nip59.createRumor({ kind: 14, content, tags: [["p", recipient.pubkey]] }, senderSecret);
    return nip59.createWrap(nip59.createSeal(rumor, senderSecret, recipient.pubkey), recipient.pubkey);
  }

  test("opens, reporting the seal's author as the sender", async () => {
    const senderSecret = generateSecretKey();
    const opened = await openNip17GiftWrap(genuineWrap(senderSecret), recipient, nip17Crypto);
    expect(opened).toMatchObject({ senderPubkey: getPublicKey(senderSecret), rumor: { content, tags: [["p", recipient.pubkey]] } });
  });

  test("rejects a stranger's seal around a rumor naming someone else", async () => {
    const attacker = generateSecretKey();
    const rumorBase = { kind: 14, created_at: 1_790_000_000, tags: [["p", recipient.pubkey]], content, pubkey: getPublicKey(generateSecretKey()) };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    const seal = finalizeEvent(
      { kind: 13, created_at: 1_790_000_000, tags: [], content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(attacker, recipient.pubkey)) },
      attacker,
    );
    expect(await openNip17GiftWrap(nip59.createWrap(seal, recipient.pubkey), recipient, nip17Crypto)).toBeNull();
  });

  test("rejects a wrap addressed to someone else", async () => {
    const other = new LocalKeySigner(bytesToHex(generateSecretKey()));
    expect(await openNip17GiftWrap(genuineWrap(generateSecretKey()), other, nip17Crypto)).toBeNull();
  });
});
