/**
 * Private contact list (NIP-51 kind 30000, d-tag "Chat-Friends"). The `p` items are NIP-44
 * encrypted to the owner, so encryption stays in each client; building and reading the items
 * lives here so every client writes the same tags.
 */
export declare const NIP51_CONTACTS_KIND = 30000;
export declare const NIP51_PRIVATE_CONTACTS_D_TAG = "Chat-Friends";
/** An earlier d-tag some lists were published under; read, never written. */
export declare const NIP51_LEGACY_CONTACTS_D_TAG = "taskify-contacts";
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
/**
 * One `["p", pubkey, relay, petname]` item per distinct contact. The relay slot is written empty
 * when only a petname is known, so the petname always sits at index 3.
 */
export declare function buildNip51PrivateItems(contacts: readonly Nip51ContactLike[], toPubkeyHex?: PubkeyHexNormalizer): string[][];
/** The decrypted payload as string arrays; throws when it is not an array. */
export declare function normalizeNip51PrivateItems(raw: unknown): string[][];
/**
 * Contacts from decrypted `p` items, first occurrence of each key winning. PWA builds before
 * October 2026 wrote a relay-less petname one slot late (`["p", pk, "", "", name]`), so a missing
 * index-3 petname falls back to the last non-empty value after it, as iOS does.
 */
export declare function extractNip51PrivateContacts(items: readonly unknown[], toPubkeyHex?: PubkeyHexNormalizer): Nip51PrivateContact[];
