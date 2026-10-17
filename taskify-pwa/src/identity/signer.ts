import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, nip04, nip44, type EventTemplate } from "nostr-tools";
import type { NostrEvent } from "../domains/nostr/nostrPool";

/**
 * Everything Taskify does with the user's Nostr key: sign events and encrypt to or decrypt from
 * another key. Callers use this instead of the secret key, so the key can live elsewhere: in this
 * browser (`LocalKeySigner`), a NIP-07 extension, or a NIP-46 remote signer.
 */
export interface NostrSigner {
  /** The user's public key, hex. */
  readonly pubkey: string;
  readonly kind: "local" | "extension" | "remote";
  /** Signs a finished template (proof of work, if any, already mined for `pubkey`). */
  sign(template: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  /** Legacy direct messages and older payloads; new code uses NIP-44. */
  nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** A key held in this browser (stored encrypted at rest by `nostrSkStore`). */
export class LocalKeySigner implements NostrSigner {
  readonly kind = "local" as const;
  readonly pubkey: string;
  readonly #secret: Uint8Array;

  constructor(secretKeyHex: string) {
    const normalized = secretKeyHex.trim().toLowerCase();
    if (!HEX_KEY.test(normalized)) throw new Error("A Nostr secret key is 64 hexadecimal characters.");
    this.#secret = hexToBytes(normalized);
    this.pubkey = getPublicKey(this.#secret);
  }

  async sign(template: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent(template, this.#secret) as unknown as NostrEvent;
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(this.#secret, peerPubkey));
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(this.#secret, peerPubkey));
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return nip04.encrypt(this.#secret, peerPubkey, plaintext);
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return nip04.decrypt(this.#secret, peerPubkey, ciphertext);
  }

  /** For `revealLocalSecretKey` only: see identity.ts for who may use the raw key. */
  secretKeyHex(): string {
    return bytesToHex(this.#secret);
  }
}
