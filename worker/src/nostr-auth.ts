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

/**
 * Verify a Taskify HTTPS request signed by the account's Nostr key.
 * The signature covers SHA-256(timestamp + "." + exact request body).
 */
export async function verifyTaskifyAuth(request: Request): Promise<{ npub: string } | null> {
  const publicKeyHeader = request.headers.get("X-Taskify-Npub");
  const timestampHeader = request.headers.get("X-Taskify-Timestamp");
  const signatureHeader = request.headers.get("X-Taskify-Sig");
  if (!publicKeyHeader || !timestampHeader || !signatureHeader) return null;

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return null;

  const publicKey = normalizeNostrPublicKey(publicKeyHeader);
  if (!publicKey || !/^[0-9a-fA-F]{128}$/.test(signatureHeader)) return null;

  const body = await request.clone().text();
  const payload = `${timestamp}.${body}`;
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );

  try {
    return schnorr.verify(hexToBytes(signatureHeader), hash, hexToBytes(publicKey))
      ? { npub: publicKey }
      : null;
  } catch {
    return null;
  }
}
