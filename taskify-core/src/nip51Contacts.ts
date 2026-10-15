import { normalizeNostrPubkeyHex } from "./contactContracts.js";

/**
 * Private contact list (NIP-51 kind 30000, d-tag "Chat-Friends"). The `p` items are NIP-44
 * encrypted to the owner, so encryption stays in each client; building and reading the items
 * lives here so every client writes the same tags.
 */
export const NIP51_CONTACTS_KIND = 30000;
export const NIP51_PRIVATE_CONTACTS_D_TAG = "Chat-Friends";
/** An earlier d-tag some lists were published under; read, never written. */
export const NIP51_LEGACY_CONTACTS_D_TAG = "taskify-contacts";

export type Nip51PrivateContact = {
  pubkey: string;
  relayHint?: string;
  petname?: string;
};

export type Nip51ContactLike = {
  pubkey?: string | null;
  npub?: string | null;
  relays?: readonly unknown[] | null;
  name?: string | null;
  displayName?: string | null;
  username?: string | null;
};

/** Turns a stored key (hex, compressed hex, or npub when the client can decode it) into raw hex. */
export type PubkeyHexNormalizer = (value: string | null | undefined) => string | null;

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * One `["p", pubkey, relay, petname]` item per distinct contact. The relay slot is written empty
 * when only a petname is known, so the petname always sits at index 3.
 */
export function buildNip51PrivateItems(
  contacts: readonly Nip51ContactLike[],
  toPubkeyHex: PubkeyHexNormalizer = normalizeNostrPubkeyHex,
): string[][] {
  const seen = new Set<string>();
  const items: string[][] = [];
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const pubkey = toPubkeyHex(contact.pubkey) ?? toPubkeyHex(contact.npub);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const relayHint = (contact.relays ?? []).map(trimmed).find(Boolean);
    const petname = trimmed(contact.name) ?? trimmed(contact.displayName) ?? trimmed(contact.username);
    const tag = ["p", pubkey];
    if (relayHint || petname) tag.push(relayHint ?? "");
    if (petname) tag.push(petname);
    items.push(tag);
  }
  return items;
}

/** The decrypted payload as string arrays; throws when it is not an array. */
export function normalizeNip51PrivateItems(raw: unknown): string[][] {
  if (!Array.isArray(raw)) throw new Error("Invalid NIP-51 contacts payload.");
  return raw.flatMap((entry) =>
    Array.isArray(entry) ? [entry.map((value) => (typeof value === "string" ? value : ""))] : [],
  );
}

/**
 * Contacts from decrypted `p` items, first occurrence of each key winning. PWA builds before
 * October 2026 wrote a relay-less petname one slot late (`["p", pk, "", "", name]`), so a missing
 * index-3 petname falls back to the last non-empty value after it, as iOS does.
 */
export function extractNip51PrivateContacts(
  items: readonly unknown[],
  toPubkeyHex: PubkeyHexNormalizer = normalizeNostrPubkeyHex,
): Nip51PrivateContact[] {
  const seen = new Set<string>();
  const contacts: Nip51PrivateContact[] = [];
  for (const tag of Array.isArray(items) ? items : []) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    const pubkey = toPubkeyHex(typeof tag[1] === "string" ? tag[1] : null);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const petname = trimmed(tag[3]) ?? tag.slice(4).map(trimmed).filter(Boolean).pop();
    contacts.push({ pubkey, relayHint: trimmed(tag[2]), petname });
  }
  return contacts;
}
