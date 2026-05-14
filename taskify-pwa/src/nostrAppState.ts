import { hexToBytes } from "@noble/hashes/utils.js";
import { nip44 } from "nostr-tools";

export const NOSTR_APP_STATE_KIND = 30078;
export const NOSTR_APP_STATE_CLIENT_TAG = "taskify.app";

export const NOSTR_BIBLE_TRACKER_D_TAG = "taskify-bible-tracker";
export const NOSTR_SCRIPTURE_MEMORY_D_TAG = "taskify-scripture-memory";

export type NostrBibleTrackerSyncPayload = {
  version: 1;
  timestamp: number;
  bibleTracker: unknown;
};

export type NostrScriptureMemorySyncPayload = {
  version: 1;
  timestamp: number;
  scriptureMemory: unknown;
};

function ensureNip44v2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

export async function encryptNostrSyncPayload(payload: unknown, skHex: string, pkHex: string): Promise<string> {
  const nip44v2 = ensureNip44v2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(skHex), pkHex);
  return nip44v2.encrypt(JSON.stringify(payload), conversationKey);
}

export async function decryptNostrSyncPayload(content: string, skHex: string, pkHex: string): Promise<unknown> {
  const nip44v2 = ensureNip44v2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(skHex), pkHex);
  const plaintext = await nip44v2.decrypt(content, conversationKey);
  return JSON.parse(plaintext);
}
