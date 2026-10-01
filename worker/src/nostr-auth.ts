import { schnorr } from "@noble/curves/secp256k1.js";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const buffer = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bech32Decode(value: string): { hrp: string; data: Uint8Array } | null {
  const normalized = value.toLowerCase();
  const separator = normalized.lastIndexOf("1");
  if (separator < 1 || separator + 7 > normalized.length) return null;

  const words: number[] = [];
  const dataPart = normalized.slice(separator + 1);
  for (let index = 0; index < dataPart.length - 6; index += 1) {
    const word = BECH32_CHARSET.indexOf(dataPart[index]);
    if (word < 0) return null;
    words.push(word);
  }

  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return { hrp: normalized.slice(0, separator), data: new Uint8Array(bytes) };
}

/** Accept a raw 64-character hex public key or an npub and return canonical hex. */
export function normalizeNostrPublicKey(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  const decoded = bech32Decode(trimmed);
  if (!decoded || decoded.hrp !== "npub" || decoded.data.length !== 32) return null;
  return [...decoded.data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const TASKIFY_AUTH_V2_LABEL = "taskify-request-v2";
const V1_WINDOW_SECONDS = 300;
const V2_WINDOW_SECONDS = 60;

/**
 * The text a version-2 request signature covers, one field per line: a label, the method, the
 * host, the path with its query, the timestamp, and the SHA-256 of the exact body in hex. Keep
 * in step with `signTaskifyRequestHeaders` (PWA), `NostrIdentity.taskifyRequestHeaders` (iOS),
 * and `TaskifyWatchNostrCrypto.requestAuthentication` (Watch).
 */
export function taskifyAuthV2Message(method: string, url: URL, timestamp: number, bodySha256Hex: string): string {
  return [
    TASKIFY_AUTH_V2_LABEL,
    method.toUpperCase(),
    url.host.toLowerCase(),
    `${url.pathname}${url.search}`,
    String(timestamp),
    bodySha256Hex,
  ].join("\n");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type TaskifyAuthOptions = {
  /** Accept the original format (body and timestamp only). Off once every client sends v2. */
  allowV1?: boolean;
  /** Records each v2 signature until it expires, so a captured request cannot be replayed. */
  replayStore?: ReplayStore;
};

/** The part of a D1 database the replay record uses. */
export type ReplayStore = {
  prepare(query: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> } };
};

/**
 * Verify a Taskify HTTPS request signed by the account's Nostr key.
 *
 * Version 2 (`X-Taskify-Auth: v2`) signs SHA-256 of `taskifyAuthV2Message`: it is bound to the
 * method, host, and route, valid for 60 seconds, and single-use when a replay store is given.
 * Version 1 signs SHA-256(timestamp + "." + body) and is valid for 300 seconds; it is accepted
 * only while `allowV1` is set, for clients released before version 2.
 */
export async function verifyTaskifyAuth(
  request: Request,
  options: TaskifyAuthOptions = {},
): Promise<{ npub: string; version: 1 | 2 } | null> {
  const publicKeyHeader = request.headers.get("X-Taskify-Npub");
  const timestampHeader = request.headers.get("X-Taskify-Timestamp");
  const signatureHeader = request.headers.get("X-Taskify-Sig");
  if (!publicKeyHeader || !timestampHeader || !signatureHeader) return null;
  const version = request.headers.get("X-Taskify-Auth") === "v2" ? 2 : 1;
  if (version === 1 && options.allowV1 === false) return null;

  if (!/^\d{1,12}$/.test(timestampHeader)) return null;
  const timestamp = Number.parseInt(timestampHeader, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (version === 2 ? V2_WINDOW_SECONDS : V1_WINDOW_SECONDS)) return null;

  const publicKey = normalizeNostrPublicKey(publicKeyHeader);
  if (!publicKey || !/^[0-9a-fA-F]{128}$/.test(signatureHeader)) return null;

  const body = new Uint8Array(await request.clone().arrayBuffer());
  let hash: Uint8Array;
  if (version === 2) {
    const message = taskifyAuthV2Message(request.method, new URL(request.url), timestamp, toHex(await sha256(body)));
    hash = await sha256(new TextEncoder().encode(message));
  } else {
    const prefix = new TextEncoder().encode(`${timestamp}.`);
    const payload = new Uint8Array(prefix.length + body.length);
    payload.set(prefix, 0);
    payload.set(body, prefix.length);
    hash = await sha256(payload);
  }

  let valid = false;
  try {
    valid = schnorr.verify(hexToBytes(signatureHeader), hash, hexToBytes(publicKey));
  } catch {
    valid = false;
  }
  if (!valid) return null;

  if (version === 2 && options.replayStore) {
    const recorded = await options.replayStore.prepare(
      `INSERT INTO request_signatures (signature, expires_at) VALUES (?, ?)
       ON CONFLICT(signature) DO NOTHING RETURNING signature`,
    ).bind(signatureHeader.toLowerCase(), (timestamp + V2_WINDOW_SECONDS) * 1000).first();
    if (!recorded) return null;
  }
  return { npub: publicKey, version };
}
