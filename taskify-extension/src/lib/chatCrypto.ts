/**
 * Chat crypto: the NIP-17 gift-wrap machinery and the attachment encryption, using Taskify's
 * shared implementations so the panel is wire-compatible with the PWA, the native apps and the
 * `taskify-cli` agent.
 *
 * Attachments follow the 0xchat-compatible wire format:
 *   - a fresh 32-byte AES-256 key and 16-byte nonce per file
 *   - the file is encrypted with AES-GCM and uploaded to a file server (NIP-96 / Blossom /
 *     Originless)
 *   - the kind-15 rumor carries the ciphertext's URL, plus the key, nonce and algorithm in tags
 */
import {
  buildNip17GiftWraps,
  createNip17Rumor,
  type Nip17Account,
  type Nip17Rumor,
  type Nip17SignedEvent,
} from "taskify-core";
import { nip17Crypto, newNip17WrapKey } from "taskify-runtime-nostr";
import { finalizeEvent, nip44 } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";

/** The account, as NIP-17 needs it. */
export function nip17Account(secretKeyHex: string, pubkey: string): Nip17Account {
  return {
    pubkey,
    sign: async (template) => finalizeEvent(template, hexToBytes(secretKeyHex)) as Nip17SignedEvent,
    nip44Encrypt: async (peerPubkey, plaintext) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(hexToBytes(secretKeyHex), peerPubkey)),
    nip44Decrypt: async (peerPubkey, ciphertext) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(hexToBytes(secretKeyHex), peerPubkey)),
  };
}

/** The one-time key a gift wrap is sealed under. */
export function nip17WrapKey() {
  return newNip17WrapKey();
}

export { nip17Crypto };

/** NIP-59: seal and wrap timestamps are randomized up to two days into the past. */
export function nip17TimestampSource(mode: "now" | "random"): () => number {
  return () => {
    const now = Math.floor(Date.now() / 1000);
    if (mode === "now") return now;
    return now - Math.floor(Math.random() * 2 * 24 * 60 * 60);
  };
}

export type SendableMessage = {
  kind: number;
  content: string;
  extraTags?: string[][];
};

/**
 * Builds the gift wraps for a message: one per recipient, plus one for the sender's own inbox so
 * the message shows up in this panel right away.
 */
export async function buildMessageWraps(options: {
  account: Nip17Account;
  senderPubkey: string;
  recipientPubkeys: string[];
  message: SendableMessage;
  timestamp: () => number;
  signWrap: (template: Parameters<typeof nip17Crypto.eventId>[0], key: ReturnType<typeof newNip17WrapKey>) => Promise<Nip17SignedEvent>;
}): Promise<Array<{ recipient: string; wrap: Nip17SignedEvent }>> {
  const rumor = createNip17Rumor(
    {
      sender: options.senderPubkey,
      recipients: options.recipientPubkeys,
      content: options.message.content,
      createdAt: Math.floor(Date.now() / 1000),
      kind: options.message.kind,
      extraTags: options.message.extraTags,
    },
    nip17Crypto,
  );
  return buildNip17GiftWraps(rumor, options.account, {
    newWrapKey: newNip17WrapKey,
    signWrap: options.signWrap as never,
    timestamp: options.timestamp,
  });
}

export { createNip17Rumor };
export type { Nip17Rumor, Nip17SignedEvent };

// ── Attachment encryption ──────────────────────────────────────────────────────

export const ATTACHMENT_ALGO = "aes-gcm" as const;
export const ATTACHMENT_KEY_BYTES = 32;
export const ATTACHMENT_NONCE_BYTES = 16;

export type EncryptedAttachment = {
  /** The URL the ciphertext was uploaded to. */
  remoteUrl: string;
  mimeType: string;
  filename: string;
  size: number;
  sha256: string;
  keyHex: string;
  nonceHex: string;
  algorithm: typeof ATTACHMENT_ALGO;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Encrypts a file for upload. The key and nonce travel in the rumor tags; the file server only
 * ever sees ciphertext.
 */
export async function encryptAttachment(options: {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}): Promise<{ ciphertext: Uint8Array; meta: Omit<EncryptedAttachment, "remoteUrl"> }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(ATTACHMENT_KEY_BYTES));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(ATTACHMENT_NONCE_BYTES));
  const key = await crypto.subtle.importKey("raw", keyBytes as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceBytes as unknown as BufferSource }, key, options.data as unknown as BufferSource),
  );
  return {
    ciphertext,
    meta: {
      mimeType: options.mimeType,
      filename: options.filename,
      size: options.data.byteLength,
      sha256: await sha256Hex(options.data),
      keyHex: bytesToHex(keyBytes),
      nonceHex: bytesToHex(nonceBytes),
      algorithm: ATTACHMENT_ALGO,
    },
  };
}

/** Decrypts an attachment that arrived over chat. */
export async function decryptAttachment(options: {
  ciphertext: Uint8Array;
  keyHex: string;
  nonceHex: string;
}): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(options.keyHex) as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(options.nonceHex) as unknown as BufferSource },
    key,
    options.ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/** The tags a kind-15 file rumor carries. */
export function attachmentTags(meta: Omit<EncryptedAttachment, "remoteUrl">): string[][] {
  const tags: string[][] = [
    ["file-type", meta.mimeType],
    ["encryption-algorithm", meta.algorithm],
    ["decryption-key", meta.keyHex],
    ["decryption-nonce", meta.nonceHex],
  ];
  if (meta.sha256) tags.push(["x", meta.sha256]);
  if (meta.size > 0) tags.push(["size", String(meta.size)]);
  if (meta.filename) tags.push(["filename", meta.filename]);
  return tags;
}
