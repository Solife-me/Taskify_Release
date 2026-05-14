import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, nip44, type Event as NostrEvent, type EventTemplate } from "nostr-tools";

import type { Contact } from "./contacts";
import { normalizeNostrPubkey } from "./nostr";
import { SessionPool } from "../nostr/SessionPool";

export const NIP51_CONTACTS_KIND = 30000;
export const NIP51_CONTACTS_D_TAG = "Chat-Friends";

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

function normalizeToRawPubkeyHex(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/i.test(trimmed)) return trimmed.slice(-64).toLowerCase();
  const normalized = normalizeNostrPubkey(trimmed);
  if (!normalized) return null;
  return normalized.slice(-64).toLowerCase();
}

function selectRelayHint(relays: Contact["relays"]): string | null {
  if (!Array.isArray(relays)) return null;
  const relay = relays.find((entry) => typeof entry === "string" && entry.trim().length > 0);
  return relay ? relay.trim() : null;
}

function selectPetname(contact: Contact): string | null {
  const name = (contact.name || "").trim();
  if (name) return name;
  const displayName = (contact.displayName || "").trim();
  if (displayName) return displayName;
  const username = (contact.username || "").trim();
  return username || null;
}

export function buildNip51PrivateItems(contacts: Contact[]): string[][] {
  const seen = new Set<string>();
  const items: string[][] = [];

  (Array.isArray(contacts) ? contacts : []).forEach((contact) => {
    const pubkey = normalizeToRawPubkeyHex(contact.npub || "");
    if (!pubkey) return;
    if (seen.has(pubkey)) return;
    seen.add(pubkey);
    const relayHint = selectRelayHint(contact.relays);
    const petname = selectPetname(contact);
    const tag: string[] = ["p", pubkey];
    if (relayHint || petname) {
      tag.push(relayHint || "");
    }
    if (petname) {
      if (!relayHint) {
        tag.push("");
      }
      tag.push(petname);
    }
    items.push(tag);
  });

  return items;
}

function normalizePrivateItems(raw: unknown): string[][] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid NIP-51 contacts payload.");
  }
  const normalized: string[][] = [];
  raw.forEach((entry) => {
    if (!Array.isArray(entry)) return;
    normalized.push(entry.map((value) => (typeof value === "string" ? value : "")));
  });
  return normalized;
}

export async function encryptNip51PrivateItems(items: string[][], keys: Nip51ContactKeys): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(keys.privateKeyHex), keys.publicKeyHex);
  return nip44v2.encrypt(JSON.stringify(items), conversationKey);
}

export async function decryptNip51PrivateItems(content: string, keys: Nip51ContactKeys): Promise<string[][]> {
  const nip44v2 = ensureNip44V2();
  const trimmed = (content || "").trim();
  if (!trimmed) return [];
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(keys.privateKeyHex), keys.publicKeyHex);
  const plaintext = await nip44v2.decrypt(trimmed, conversationKey);
  return normalizePrivateItems(JSON.parse(plaintext));
}

export function extractNip51PrivateContacts(items: string[][]): Nip51PrivateContact[] {
  const contacts: Nip51PrivateContact[] = [];
  const seen = new Set<string>();

  (Array.isArray(items) ? items : []).forEach((tag) => {
    if (!Array.isArray(tag) || tag[0] !== "p") return;
    const pubkey = normalizeToRawPubkeyHex(tag[1]);
    if (!pubkey) return;
    if (seen.has(pubkey)) return;
    seen.add(pubkey);
    const relayHint = typeof tag[2] === "string" ? tag[2].trim() : "";
    const petname = typeof tag[3] === "string" ? tag[3].trim() : "";
    contacts.push({
      pubkey,
      relayHint: relayHint || undefined,
      petname: petname || undefined,
    });
  });

  return contacts;
}

export async function buildNip51PrivateContactsEvent(
  contacts: Contact[],
  keys: Nip51ContactKeys,
  options?: { createdAt?: number; tags?: string[][] },
): Promise<EventTemplate> {
  const privateItems = buildNip51PrivateItems(contacts);
  const content = await encryptNip51PrivateItems(privateItems, keys);
  const tags: string[][] = [];
  const incomingTags = Array.isArray(options?.tags) ? options?.tags : [];
  incomingTags.forEach((tag) => {
    if (!Array.isArray(tag) || tag.length < 2) return;
    if (tag[0] === "d") return;
    tags.push(tag);
  });
  tags.unshift(["d", NIP51_CONTACTS_D_TAG]);
  return {
    kind: NIP51_CONTACTS_KIND,
    content,
    tags,
    created_at: options?.createdAt ?? Math.floor(Date.now() / 1000),
  };
}

function isReplaceableRejection(err: unknown): boolean {
  const msg = typeof (err as any)?.message === "string" ? (err as any).message : "";
  return /have newer event/i.test(msg) || /already exists/i.test(msg) || /duplicate/i.test(msg);
}

export async function publishNip51PrivateContactsList(
  pool: SessionPool,
  relays: string[],
  contacts: Contact[],
  keys: Nip51ContactKeys,
  options?: { createdAt?: number; tags?: string[][] },
): Promise<NostrEvent> {
  const template = await buildNip51PrivateContactsEvent(contacts, keys, options);
  const signed = finalizeEvent(template, hexToBytes(keys.privateKeyHex));
  const result = pool.publish(relays, signed);
  try {
    await Promise.resolve(result);
  } catch (err) {
    if (!isReplaceableRejection(err)) {
      throw err;
    }
  }
  return signed;
}

export async function fetchLatestPrivateContactsList(
  pool: SessionPool,
  relays: string[],
  pubkey: string,
  keys: Nip51ContactKeys,
): Promise<{ event: NostrEvent | null; contacts: Nip51PrivateContact[] }> {
  const event = await pool.get(relays, {
    kinds: [NIP51_CONTACTS_KIND],
    authors: [pubkey],
    "#d": [NIP51_CONTACTS_D_TAG],
  });
  if (!event) return { event: null, contacts: [] };
  const items = await decryptNip51PrivateItems(event.content, keys);
  const contacts = extractNip51PrivateContacts(items);
  return { event, contacts };
}
