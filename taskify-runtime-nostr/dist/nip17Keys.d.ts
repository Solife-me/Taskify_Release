import type { Event, EventTemplate } from 'nostr-tools';
/**
 * nostr-tools crypto for taskify-core's NIP-17 module (`Nip17Crypto`, `Nip17Account`,
 * `Nip17WrapKey`, matched by shape).
 */
export declare const nip17Crypto: {
    eventId: (event: EventTemplate & {
        pubkey: string;
    }) => string;
    verifyEvent: (event: Event) => boolean;
};
export type Nip17KeyParty = {
    readonly pubkey: string;
    readonly secretKey: Uint8Array;
    sign(template: EventTemplate): Promise<Event>;
    nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
};
/** A key held in memory acting as a NIP-17 party: the CLI's account, or a one-time wrap key. */
export declare function nip17KeyParty(secretKey: Uint8Array): Nip17KeyParty;
/** A fresh one-time key for one gift wrap. */
export declare function newNip17WrapKey(): Nip17KeyParty;
