import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { getPublicKey, nip19 } from "nostr-tools";

function arrayLikeToHex(data: ArrayLike<number>): string {
  return Array.from(data).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalize Nostr public key input into a compressed 33-byte hex string (66 chars).
 */
export function normalizeNostrPubkey(input: string | null | undefined): string | null {
  let value = input?.trim();
  if (!value) return null;

  // Allow nostr: URI scheme prefixes (case-insensitive)
  if (/^nostr:/i.test(value)) {
    value = value.replace(/^nostr:/i, "");
  }

  // Normalize case for bech32 inputs (spec requires lowercase, but users often paste uppercase)
  const lowerValue = value.toLowerCase();

  const maybeHex = lowerValue.startsWith("0x") ? lowerValue.slice(2) : lowerValue;
  if (/^(02|03)[0-9a-f]{64}$/.test(maybeHex)) {
    return maybeHex;
  }
  if (/^[0-9a-f]{64}$/.test(maybeHex)) {
    return `02${maybeHex}`;
  }

  try {
    const decoded = nip19.decode(lowerValue);
    if (decoded.type !== "npub" || !decoded.data) return null;
    if (typeof decoded.data === "string") {
      if (/^[0-9a-f]{64}$/.test(decoded.data)) return `02${decoded.data.toLowerCase()}`;
      return null;
    }
    if (decoded.data instanceof Uint8Array) {
      return `02${bytesToHex(decoded.data).toLowerCase()}`;
    }
    if (Array.isArray(decoded.data)) {
      return `02${arrayLikeToHex(decoded.data).toLowerCase()}`;
    }
  } catch {
    // fall through to null
  }
  return null;
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
