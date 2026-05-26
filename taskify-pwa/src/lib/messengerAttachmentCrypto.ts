// 0xchat-compatible file attachment crypto for NIP-17 messenger.
//
// Wire format (matches 0xchat / nostr-dart Nip17.encodeInnerEvent):
//   - Per-file random 32-byte key (AES-256)
//   - Per-file random 16-byte nonce (AES-GCM IV)
//   - Ciphertext is raw AES-GCM output (ciphertext || 16-byte auth tag)
//   - Uploaded as opaque bytes to a Taskify file server (NIP-96 / Blossom / originless)
//   - Kind-15 rumor carries tags:
//       ["file-type", mimeType]
//       ["encryption-algorithm", "aes-gcm"]
//       ["decryption-key", hex(key)]
//       ["decryption-nonce", hex(nonce)]
//     and the content field is the plaintext URL of the uploaded ciphertext.
//
// Sources:
//   nostr-dart lib/src/nips/nip_017.dart:69-72
//   0xchat-app-business ox_chat/lib/utils/send_message/chat_send_message_helper.dart:105-111
//   0xchat-app-base ox_common/lib/utils/aes_encrypt_utils.dart:15-43

import { uploadFile } from "../nostr/Nip96Client";
import type { FileServerEntry } from "./fileStorage";
import { toBlobPart, toBufferSource } from "./binary";

export const MESSENGER_ATTACHMENT_ALGO = "aes-gcm" as const;
export const MESSENGER_ATTACHMENT_KEY_BYTES = 32;
export const MESSENGER_ATTACHMENT_NONCE_BYTES = 16;

const decryptObjectUrlCache = new Map<string, Promise<{ objectUrl: string; blob: Blob }>>();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Invalid hex char");
    out[i] = byte;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBufferSource(bytes));
  return bytesToHex(new Uint8Array(digest));
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toBufferSource(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export type MessengerEncryptedUpload = {
  remoteUrl: string;
  mimeType: string;
  filename: string;
  size: number;
  sha256: string;
  keyHex: string;
  nonceHex: string;
  algorithm: typeof MESSENGER_ATTACHMENT_ALGO;
  width?: number;
  height?: number;
};

export async function encryptAndUploadMessengerAttachment(opts: {
  data: Uint8Array;
  mimeType: string;
  filename: string;
  serverEntry: FileServerEntry;
  nostrSkHex: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, loaded: number, total: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
  width?: number;
  height?: number;
}): Promise<MessengerEncryptedUpload> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(MESSENGER_ATTACHMENT_KEY_BYTES));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(MESSENGER_ATTACHMENT_NONCE_BYTES));
  const cryptoKey = await importAesKey(keyBytes);

  // WebCrypto AES-GCM accepts arbitrary-length IVs (spec allows up to 2^64-1 bytes).
  // 0xchat uses 16 bytes, so we pass 16 bytes and get a wire-compatible output.
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(nonceBytes), tagLength: 128 },
    cryptoKey,
    toBufferSource(opts.data),
  );
  const ciphertext = new Uint8Array(ctBuf);
  const ciphertextSha256 = await sha256Hex(ciphertext);

  // Upload the ciphertext under an opaque `<sha256>.bin` name rather than the
  // user's original filename. Some NIP-96 servers (e.g. nostr.build) content-
  // sniff uploads and reject blobs whose bytes don't match the filename
  // extension (e.g. encrypted bytes uploaded as "README.md" → 500). The real
  // filename still rides along in the NIP-17 rumor's `filename` tag, so the
  // recipient sees the original name. This also avoids leaking the user's
  // filename to the file host.
  const uploadFilename = `${ciphertextSha256}.bin`;
  const blob = new Blob([ciphertext], { type: "application/octet-stream" });
  const upload = await uploadFile({
    debugMeta: {
      source: "encryptAndUploadMessengerAttachment",
      originalFilename: opts.filename,
      originalMimeType: opts.mimeType,
      uploadFilename,
      plaintextBytes: opts.data.byteLength,
      ciphertextBytes: ciphertext.byteLength,
      ciphertextSha256,
    },
    serverEntry: opts.serverEntry,
    file: blob,
    filename: uploadFilename,
    contentType: "application/octet-stream",
    signer: opts.nostrSkHex,
    signal: opts.signal,
    onProgress: opts.onProgress
      ? (loaded, total) => opts.onProgress?.(total > 0 ? loaded / total : 0, loaded, total)
      : undefined,
    onPhaseChange: opts.onPhaseChange,
  });

  return {
    remoteUrl: upload.url,
    mimeType: opts.mimeType || "application/octet-stream",
    filename: opts.filename,
    size: opts.data.byteLength,
    sha256: ciphertextSha256,
    keyHex: bytesToHex(keyBytes),
    nonceHex: bytesToHex(nonceBytes),
    algorithm: MESSENGER_ATTACHMENT_ALGO,
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
  };
}

export type MessengerAttachmentDescriptor = {
  url: string;
  mimeType: string;
  keyHex: string;
  nonceHex: string;
  algorithm: string;
};

export async function decryptMessengerAttachment(
  descriptor: MessengerAttachmentDescriptor,
): Promise<{ objectUrl: string; blob: Blob }> {
  const cacheKey = `${descriptor.url}::${descriptor.keyHex}::${descriptor.nonceHex}`;
  const cached = decryptObjectUrlCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const algo = (descriptor.algorithm || "").trim().toLowerCase();
    if (algo && algo !== "aes-gcm" && algo !== "aes-256-gcm") {
      throw new Error(`Unsupported attachment cipher: ${descriptor.algorithm}`);
    }
    const res = await fetch(descriptor.url);
    if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
    const ciphertext = new Uint8Array(await res.arrayBuffer());
    const keyBytes = hexToBytes(descriptor.keyHex);
    const nonceBytes = hexToBytes(descriptor.nonceHex);
    const cryptoKey = await importAesKey(keyBytes);
    const ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBufferSource(nonceBytes), tagLength: 128 },
      cryptoKey,
      toBufferSource(ciphertext),
    );
    const mimeType = descriptor.mimeType || "application/octet-stream";
    const blob = new Blob([toBlobPart(new Uint8Array(ptBuf))], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    return { objectUrl, blob };
  })();

  decryptObjectUrlCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (err) {
    decryptObjectUrlCache.delete(cacheKey);
    throw err;
  }
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

export function isVideoMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("video/");
}

export function isAudioMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("audio/");
}

export async function probeImageDimensions(
  file: Blob,
): Promise<{ width: number; height: number } | null> {
  if (!isImageMime(file.type)) return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function formatByteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
