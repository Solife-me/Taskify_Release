/**
 * The shared NIP-17 vectors (taskify-core/fixtures/nip17-vectors.json), opened with the code chat
 * and the share inbox use. Swift checks the same file (NIP17VectorTests).
 */
import { describe, expect, test } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { nip17MessageRecipients, openNip17GiftWrap, type Nip17SignedEvent } from "taskify-core";
import { nip17Crypto, nip17KeyParty } from "taskify-runtime-nostr";
import vectorFile from "../../../taskify-core/fixtures/nip17-vectors.json";

type Accounts = Record<string, { secretKey: string; pubkey: string }>;
const accounts = vectorFile.accounts as Accounts;

describe("NIP-17 shared vectors", () => {
  test("cover both opening and rejection", () => {
    expect(vectorFile.vectors.some((v) => v.expected)).toBe(true);
    expect(vectorFile.vectors.some((v) => !v.expected)).toBe(true);
  });

  for (const vector of vectorFile.vectors) {
    test(vector.name, async () => {
      const receiver = nip17KeyParty(hexToBytes(accounts[vector.receiver].secretKey));
      const opened = await openNip17GiftWrap(vector.wrap as Nip17SignedEvent, receiver, nip17Crypto);
      if (!vector.expected) {
        expect(opened).toBeNull();
        return;
      }
      expect(opened).not.toBeNull();
      expect({
        senderPubkey: opened!.senderPubkey,
        rumorId: opened!.rumor.id,
        kind: opened!.rumor.kind,
        content: opened!.rumor.content,
        tags: opened!.rumor.tags,
        createdAt: opened!.rumor.created_at,
        recipients: nip17MessageRecipients(opened!, receiver.pubkey),
      }).toEqual(vector.expected);
    });
  }
});
