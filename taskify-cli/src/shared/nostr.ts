import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey, nip19 } from "nostr-tools";

function arrayLikeToHex(data: ArrayLike<number>): string {
  return Array.from(data).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function normalizeNostrPubkey(input: string | null | undefined): string | null {
  let value = input?.trim();
  if (!value) return null;

  if (/^nostr:/i.test(value)) {
    value = value.replace(/^nostr:/i, "");
  }

  const lowerValue = value.toLowerCase();
  const maybeHex = lowerValue.startsWith("0x") ? lowerValue.slice(2) : lowerValue;
  if (/^(02|03)[0-9a-f]{64}$/.test(maybeHex)) return maybeHex;
  if (/^[0-9a-f]{64}$/.test(maybeHex)) return `02${maybeHex}`;

  try {
    const decoded = nip19.decode(lowerValue);
    if (decoded.type !== "npub" || !decoded.data) return null;
    const decodedData: unknown = decoded.data;
    if (typeof decodedData === "string") {
      if (/^[0-9a-f]{64}$/.test(decodedData)) return `02${decodedData.toLowerCase()}`;
      return null;
    }
    if (decodedData instanceof Uint8Array) return `02${bytesToHex(decodedData).toLowerCase()}`;
    if (Array.isArray(decodedData)) return `02${arrayLikeToHex(decodedData).toLowerCase()}`;
  } catch {
    // ignore
  }
  return null;
}

export function toNpub(input: string | null | undefined): string | null {
  const normalized = normalizeNostrPubkey(input);
  if (!normalized) return null;
  try {
    return nip19.npubEncode(normalized.slice(-64));
  } catch {
    return null;
  }
}

export function isValidNostrPubkeyHex(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(02|03)[0-9a-fA-F]{64}$/.test(value);
}

export function deriveCompressedPubkeyFromSecret(secretHex: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex?.trim() || "")) return null;
  try {
    const pubkey = getPublicKey(hexToBytes(secretHex.trim()));
    return `02${pubkey.toLowerCase()}`;
  } catch {
    return null;
  }
}
