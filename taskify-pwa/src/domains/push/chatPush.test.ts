import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LocalKeySigner } from "../../identity/signer";
import {
  CHAT_PUSH_RELAY_URL,
  advertisedInboxRelays,
  inboxPreferenceTemplate,
  inboxRelaysWithPushRelay,
  inboxRelaysWithoutPushRelay,
  nip98Authorization,
} from "./chatPush";

const PUSH = CHAT_PUSH_RELAY_URL;

describe("inbox preference changes", () => {
  it("adds the push relay to the advertised list, or to the relays read today when there is none", () => {
    expect(inboxRelaysWithPushRelay(["wss://a.example"], ["wss://b.example"])).toEqual(["wss://a.example", PUSH]);
    expect(inboxRelaysWithPushRelay([], ["wss://b.example/", PUSH])).toEqual(["wss://b.example", PUSH]);
    expect(inboxRelaysWithPushRelay(["wss://a.example", PUSH], [])).toBeNull();
  });

  it("removes the push relay unless that would leave no inbox", () => {
    expect(inboxRelaysWithoutPushRelay(["wss://a.example", PUSH])).toEqual(["wss://a.example"]);
    expect(inboxRelaysWithoutPushRelay([PUSH])).toBeNull();
    expect(inboxRelaysWithoutPushRelay(["wss://a.example"])).toBeNull();
  });

  it("reads only the account's own latest signed preference", () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const older = finalizeEvent({ ...inboxPreferenceTemplate(["wss://old.example"], 100) }, sk);
    const newer = finalizeEvent({ ...inboxPreferenceTemplate(["wss://a.example", PUSH], 200) }, sk);
    const someoneElse = finalizeEvent({ ...inboxPreferenceTemplate(["wss://evil.example"], 300) }, generateSecretKey());
    expect(advertisedInboxRelays([older, newer, someoneElse] as never, pubkey)).toEqual(["wss://a.example", PUSH]);
    expect(advertisedInboxRelays([], pubkey)).toEqual([]);
  });

  it("publishes relays as NIP-17 relay tags", () => {
    expect(inboxPreferenceTemplate(["wss://a.example"], 5)).toEqual({
      kind: 10050,
      created_at: 5,
      tags: [["relay", "wss://a.example"]],
      content: "",
    });
  });
});

describe("nip98Authorization", () => {
  it("signs the URL, method and body hash with the user's signer", async () => {
    const signer = new LocalKeySigner(bytesToHex(generateSecretKey()));
    const header = await nip98Authorization(signer, { url: "https://push.solife.me/v1/registrations/x", method: "put", body: "{}" }, 1000);
    expect(header.startsWith("Nostr ")).toBe(true);
    const event = JSON.parse(atob(header.slice(6)));
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(signer.pubkey);
    expect(event.kind).toBe(27235);
    expect(event.created_at).toBe(1000);
    expect(event.tags).toEqual(expect.arrayContaining([
      ["u", "https://push.solife.me/v1/registrations/x"],
      ["method", "PUT"],
      // SHA-256 of "{}"
      ["payload", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    ]));
    expect(event.tags.find((tag: string[]) => tag[0] === "nonce")?.[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
