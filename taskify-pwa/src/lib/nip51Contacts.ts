import { prepareRelayEvent } from "../nostr/prepareRelayEvent";
import { hexToBytes } from "@noble/hashes/utils.js";
import { nip44, type Event as NostrEvent, type EventTemplate } from "nostr-tools";

import type { Contact } from "./contacts";
import { normalizeNostrPubkey } from "./nostr";
import { SessionPool } from "../nostr/SessionPool";

import {
  buildNip51PrivateItems as buildNip51PrivateItemsCore,
  extractNip51PrivateContacts as extractNip51PrivateContactsCore,
  normalizeNip51PrivateItems,
  NIP51_CONTACTS_KIND,
  NIP51_PRIVATE_CONTACTS_D_TAG,
  type Nip51PrivateContact,
} from "taskify-core";

export { NIP51_CONTACTS_KIND, NIP51_PRIVATE_CONTACTS_D_TAG as NIP51_CONTACTS_D_TAG };
export type { Nip51PrivateContact };

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

function normalizeToRawPubkeyHex(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/i.test(trimmed)) return trimmed.slice(-64).toLowerCase();
  const normalized = normalizeNostrPubkey(trimmed);
  if (!normalized) return null;
  return normalized.slice(-64).toLowerCase();
}

export function buildNip51PrivateItems(contacts: Contact[]): string[][] {
  return buildNip51PrivateItemsCore(contacts, normalizeToRawPubkeyHex);
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
  return normalizeNip51PrivateItems(JSON.parse(plaintext));
}

export function extractNip51PrivateContacts(items: string[][]): Nip51PrivateContact[] {
  return extractNip51PrivateContactsCore(items, normalizeToRawPubkeyHex);
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
  tags.unshift(["d", NIP51_PRIVATE_CONTACTS_D_TAG]);
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
  const signed = await prepareRelayEvent(template, hexToBytes(keys.privateKeyHex), relays);
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
    "#d": [NIP51_PRIVATE_CONTACTS_D_TAG],
  });
  if (!event) return { event: null, contacts: [] };
  const items = await decryptNip51PrivateItems(event.content, keys);
  const contacts = extractNip51PrivateContacts(items);
  return { event, contacts };
}
