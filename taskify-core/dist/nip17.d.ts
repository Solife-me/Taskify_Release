/**
 * NIP-17 private messages: an unsigned rumor (kind 14 chat, 15 file, 7 reaction, ...) sealed by
 * its author (kind 13) and gift-wrapped (kind 1059) once per recipient, plus once for the
 * author's own inbox, each wrap under a one-time key.
 *
 * Every Taskify client builds and opens these the same way; the rules here match iOS
 * (`NIP17GiftWrap`) and are checked against shared vectors (`fixtures/nip17-vectors.json`).
 * Crypto is injected: the account half comes from a signer (a local key now, NIP-07 or NIP-46
 * later), so nothing here touches a secret key.
 */
export declare const NIP17_WRAP_KIND = 1059;
export declare const NIP17_SEAL_KIND = 13;
export declare const NIP17_CHAT_KIND = 14;
export declare const NIP17_FILE_KIND = 15;
/** NIP-59: seal and wrap timestamps are randomized up to two days into the past. */
export declare const NIP17_TIMESTAMP_JITTER_SECONDS: number;
export type Nip17EventTemplate = {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
};
export type Nip17SignedEvent = Nip17EventTemplate & {
    id: string;
    pubkey: string;
    sig: string;
};
/** An unsigned event with its id: the message itself, identical in every recipient's wrap. */
export type Nip17Rumor = Nip17EventTemplate & {
    id: string;
    pubkey: string;
};
/** The account sending or receiving (a signer). */
export interface Nip17Account {
    readonly pubkey: string;
    sign(template: Nip17EventTemplate): Promise<Nip17SignedEvent>;
    nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}
/** A one-time wrap key. The caller signs the wrap with it (mining proof of work if needed). */
export interface Nip17WrapKey {
    readonly pubkey: string;
    nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
}
export interface Nip17Crypto {
    /** NIP-01 event id (sha256 of the serialized event), hex. */
    eventId(event: Nip17EventTemplate & {
        pubkey: string;
    }): string;
    /** Checks id and signature. */
    verifyEvent(event: Nip17SignedEvent): boolean;
}
/** A seal or wrap timestamp: now, or (the NIP-59 default) a random moment up to two days ago. */
export declare function nip17Timestamp(nowSeconds: number, random?: (() => number) | null): number;
/**
 * The message. Direct messages tag their recipient; group messages tag every member, the
 * sender first (0xchat counts `p` tags to tell groups from direct messages).
 */
export declare function createNip17Rumor(input: {
    sender: string;
    recipients: string[];
    content: string;
    createdAt: number;
    kind?: number;
    group?: boolean;
    extraTags?: string[][];
}, crypto: Pick<Nip17Crypto, "eventId">): Nip17Rumor;
/** Who gets a wrap: everyone the rumor tags, and the sender (for their other devices). */
export declare function nip17WrapRecipients(rumor: Nip17Rumor): string[];
/** The author seals the rumor to one recipient. */
export declare function sealNip17Rumor(rumor: Nip17Rumor, recipient: string, account: Nip17Account, createdAt: number): Promise<Nip17SignedEvent>;
/** The wrap template for one recipient; sign it with the same one-time key. */
export declare function wrapNip17Seal(seal: Nip17SignedEvent, recipient: string, wrapKey: Nip17WrapKey, createdAt: number): Promise<Nip17EventTemplate>;
export type OpenedNip17Message = {
    /** The outer event's id: differs per recipient. */
    wrapId: string;
    rumor: Nip17Rumor;
    /** The seal's author, which the rumor must name: who really sent it. */
    senderPubkey: string;
};
/**
 * Opens a gift wrap addressed to `receiver`, or returns null. Rules (as iOS):
 * the wrap is signed and tags the receiver; the seal is a signed kind 13 with no tags; the
 * rumor is unsigned, names the seal's author, and has a correct id. Decryption with the seal
 * author's key already proves who wrote it, and the checks keep every client agreeing on what
 * opens.
 */
export declare function openNip17GiftWrap(wrap: Nip17SignedEvent, receiver: Pick<Nip17Account, "pubkey" | "nip44Decrypt">, crypto: Nip17Crypto): Promise<OpenedNip17Message | null>;
/**
 * Who a message is addressed to, for chat. NUT-18 payment senders built on CDK leave the
 * rumor's `p` tags out; the wrap opened with this key, so it was meant for this account. A copy
 * the account sent itself without tags names no one and yields null.
 */
export declare function nip17MessageRecipients(message: OpenedNip17Message, receiver: string): string[] | null;
/**
 * Builds a message's gift wraps: one per recipient and one for the sender, each under a fresh
 * one-time key. `signWrap` signs the template with that key (and mines proof of work if the
 * relays want it).
 */
export declare function buildNip17GiftWraps<K extends Nip17WrapKey>(rumor: Nip17Rumor, account: Nip17Account, options: {
    newWrapKey: () => K | Promise<K>;
    signWrap: (template: Nip17EventTemplate, key: K) => Promise<Nip17SignedEvent>;
    timestamp: () => number;
}): Promise<Array<{
    recipient: string;
    wrap: Nip17SignedEvent;
}>>;
