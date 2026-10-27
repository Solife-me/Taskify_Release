import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44, verifyEvent } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';

/**
 * nostr-tools crypto for taskify-core's NIP-17 module (`Nip17Crypto`, `Nip17Account`,
 * `Nip17WrapKey`, matched by shape).
 */
export const nip17Crypto = {
  eventId: (event: EventTemplate & { pubkey: string }): string => getEventHash(event),
  verifyEvent: (event: Event): boolean => {
    try {
      // Only the event's own fields: a copy made with spread would carry nostr-tools' cached
      // "verified" mark from the original, even after its signature was changed.
      const { id, pubkey, sig, kind, content, tags, created_at } = event;
      return verifyEvent({ id, pubkey, sig, kind, content, tags, created_at });
    } catch {
      return false;
    }
  },
};

export type Nip17KeyParty = {
  readonly pubkey: string;
  readonly secretKey: Uint8Array;
  sign(template: EventTemplate): Promise<Event>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
};

/** A key held in memory acting as a NIP-17 party: the CLI's account, or a one-time wrap key. */
export function nip17KeyParty(secretKey: Uint8Array): Nip17KeyParty {
  const pubkey = getPublicKey(secretKey);
  const conversation = (peer: string) => nip44.v2.utils.getConversationKey(secretKey, peer);
  return {
    pubkey,
    secretKey,
    sign: async (template) => finalizeEvent(template, secretKey),
    nip44Encrypt: async (peer, plaintext) => nip44.v2.encrypt(plaintext, conversation(peer)),
    nip44Decrypt: async (peer, ciphertext) => nip44.v2.decrypt(ciphertext, conversation(peer)),
  };
}

/** A fresh one-time key for one gift wrap. */
export function newNip17WrapKey(): Nip17KeyParty {
  return nip17KeyParty(generateSecretKey());
}
