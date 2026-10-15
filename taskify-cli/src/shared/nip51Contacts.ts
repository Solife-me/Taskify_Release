import { hexToBytes } from "@noble/hashes/utils.js";
import { nip19, nip44 } from "nostr-tools";
import type { Contact } from "../config.js";

import {
  buildNip51PrivateItems as buildNip51PrivateItemsCore,
  extractNip51PrivateContacts as extractNip51PrivateContactsCore,
  normalizeNip51PrivateItems,
  type Nip51PrivateContact,
} from "taskify-core";

export {
  NIP51_CONTACTS_KIND,
  NIP51_LEGACY_CONTACTS_D_TAG,
  NIP51_PRIVATE_CONTACTS_D_TAG,
  type Nip51PrivateContact,
} from "taskify-core";

export type Nip51ContactKeys = {
  privateKeyHex: string;
  publicKeyHex: string;
};

function ensureNip44V2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

function normalizePubkeyHex(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/i.test(trimmed)) return trimmed.slice(-64).toLowerCase();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function buildNip51PrivateItems(contacts: Contact[]): string[][] {
  return buildNip51PrivateItemsCore(contacts, normalizePubkeyHex);
}

export async function encryptNip51PrivateItems(
  items: string[][],
  keys: Nip51ContactKeys,
): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(
    hexToBytes(keys.privateKeyHex),
    keys.publicKeyHex,
  );
  return Promise.resolve(nip44v2.encrypt(JSON.stringify(items), conversationKey));
}

export async function decryptNip51PrivateItems(
  content: string,
  keys: Nip51ContactKeys,
): Promise<string[][]> {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(
    hexToBytes(keys.privateKeyHex),
    keys.publicKeyHex,
  );
  const plaintext = await Promise.resolve(nip44v2.decrypt(trimmed, conversationKey));
  return normalizeNip51PrivateItems(JSON.parse(plaintext));
}

export function extractNip51PrivateContacts(items: string[][]): Nip51PrivateContact[] {
  return extractNip51PrivateContactsCore(items, normalizePubkeyHex);
}

export function mergeNip51PrivateContacts(
  contacts: Contact[],
  incoming: Nip51PrivateContact[],
  receivedAt: number,
): Contact[] {
  const merged = [...contacts];
  for (const item of incoming) {
    const idx = merged.findIndex((contact) => contact.pubkey === item.pubkey);
    if (idx >= 0) {
      const existing = merged[idx];
      const relays = item.relayHint && !existing.relays?.includes(item.relayHint)
        ? [...(existing.relays ?? []), item.relayHint]
        : existing.relays;
      merged[idx] = {
        ...existing,
        relays,
        name: existing.name ?? item.petname,
        updatedAt: receivedAt,
      };
      continue;
    }
    merged.push({
      pubkey: item.pubkey,
      npub: nip19.npubEncode(item.pubkey),
      name: item.petname,
      relays: item.relayHint ? [item.relayHint] : undefined,
      addedAt: receivedAt,
      updatedAt: receivedAt,
    });
  }
  return merged;
}
