import { hexToBytes } from "@noble/hashes/utils";
import { nip19, nip44 } from "nostr-tools";
import type { Contact } from "../config.js";

export const NIP51_CONTACTS_KIND = 30000;
export const NIP51_PRIVATE_CONTACTS_D_TAG = "Chat-Friends";
export const NIP51_LEGACY_CONTACTS_D_TAG = "taskify-contacts";

export type Nip51ContactKeys = {
  privateKeyHex: string;
  publicKeyHex: string;
};

export type Nip51PrivateContact = {
  pubkey: string;
  relayHint?: string;
  petname?: string;
};

function ensureNip44V2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

function normalizePubkeyHex(value: string | undefined): string | null {
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

function selectRelayHint(contact: Contact): string | undefined {
  const relay = contact.relays?.find((entry) => typeof entry === "string" && entry.trim());
  return relay?.trim() || undefined;
}

function selectPetname(contact: Contact): string | undefined {
  return contact.name?.trim()
    || contact.displayName?.trim()
    || contact.username?.trim()
    || undefined;
}

export function buildNip51PrivateItems(contacts: Contact[]): string[][] {
  const seen = new Set<string>();
  const items: string[][] = [];
  for (const contact of contacts) {
    const pubkey = normalizePubkeyHex(contact.pubkey) ?? normalizePubkeyHex(contact.npub);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const relayHint = selectRelayHint(contact);
    const petname = selectPetname(contact);
    const tag = ["p", pubkey];
    if (relayHint || petname) tag.push(relayHint ?? "");
    if (petname) tag.push(petname);
    items.push(tag);
  }
  return items;
}

function normalizePrivateItems(raw: unknown): string[][] {
  if (!Array.isArray(raw)) throw new Error("Invalid NIP-51 contacts payload.");
  return raw.flatMap((entry) => (
    Array.isArray(entry)
      ? [entry.map((value) => (typeof value === "string" ? value : ""))]
      : []
  ));
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
  return normalizePrivateItems(JSON.parse(plaintext));
}

export function extractNip51PrivateContacts(items: string[][]): Nip51PrivateContact[] {
  const seen = new Set<string>();
  const contacts: Nip51PrivateContact[] = [];
  for (const tag of items) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    const pubkey = normalizePubkeyHex(tag[1]);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const relayHint = typeof tag[2] === "string" && tag[2].trim() ? tag[2].trim() : undefined;
    const petname = typeof tag[3] === "string" && tag[3].trim() ? tag[3].trim() : undefined;
    contacts.push({ pubkey, relayHint, petname });
  }
  return contacts;
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
