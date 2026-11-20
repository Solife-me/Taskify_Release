import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey, type NostrEvent } from "nostr-tools";
import { openNip17GiftWrap } from "taskify-core";
import { nip17Crypto } from "taskify-runtime-nostr";
import { afterEach, expect, test, vi } from "vitest";
import { LocalKeySigner } from "../identity/signer";
import { buildBoardShareEnvelope, parseShareEnvelope, sendShareMessage } from "./shareInbox";

const { publishRaw, recipientInboxRelays } = vi.hoisted(() => ({
  publishRaw: vi.fn(),
  recipientInboxRelays: vi.fn(async (key: string) => [`wss://${key.slice(0, 16)}.test`]),
}));
vi.mock("../nostr/NostrSession", () => ({ NostrSession: { init: vi.fn(async () => ({ publishRaw })) } }));
vi.mock("./nip17Messages", async (original) => ({
  ...await original<typeof import("./nip17Messages")>(),
  recipientInboxRelays,
}));

afterEach(() => vi.clearAllMocks());

test("sends the same encrypted board share to each group member and to the sender", async () => {
  const secret = bytesToHex(generateSecretKey());
  const sender = new LocalKeySigner(secret);
  const members = [sender, ...Array.from({ length: 2 }, () => new LocalKeySigner(bytesToHex(generateSecretKey())))];
  const group = { name: "Project Crew", members: members.map((member) => member.pubkey) };
  const envelope = buildBoardShareEnvelope("fixture-board", "Plans", ["wss://board.test"]);

  await sendShareMessage(envelope, group, secret, ["wss://fallback.test"]);

  expect(publishRaw).toHaveBeenCalledTimes(members.length);
  const rumorIds = new Set<string>();
  for (const [wrap, options] of publishRaw.mock.calls as [NostrEvent, { relayUrls: string[] }][]) {
    const recipient = members.find((member) => member.pubkey === wrap.tags[0]?.[1]);
    if (!recipient) throw new Error("Unexpected gift-wrap recipient");
    expect(options.relayUrls).toEqual(await recipientInboxRelays(recipient.pubkey));
    const opened = await openNip17GiftWrap(wrap, recipient, nip17Crypto);
    expect(opened?.senderPubkey).toBe(sender.pubkey);
    expect(opened?.rumor.tags).toEqual([
      ...group.members.map((key) => ["p", key]),
      ["subject", group.name],
    ]);
    expect(parseShareEnvelope(opened!.rumor.content)).toEqual(envelope);
    rumorIds.add(opened!.rumor.id);
  }
  expect(rumorIds.size).toBe(1);
});

test("rejects a group the current account is not a member of", async () => {
  const secret = bytesToHex(generateSecretKey());
  const members = Array.from({ length: 3 }, () => new LocalKeySigner(bytesToHex(generateSecretKey())).pubkey);
  const envelope = buildBoardShareEnvelope("fixture-board", "Plans", ["wss://board.test"]);

  await expect(sendShareMessage(envelope, { name: "Old account", members }, secret, ["wss://fallback.test"]))
    .rejects.toThrow("unavailable for the sending account");
  expect(publishRaw).not.toHaveBeenCalled();
});
