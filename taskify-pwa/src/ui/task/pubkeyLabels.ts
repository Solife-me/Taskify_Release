import { nip19 } from "nostr-tools";
import { compressedToRawHex } from "../../domains/tasks/contactUtils";

/** A public key (hex or compressed) as an npub, or as raw hex if it cannot be encoded. */
export function toNpubKey(value: string): string {
  const raw = compressedToRawHex(value);
  try {
    return nip19.npubEncode(raw);
  } catch {
    return raw;
  }
}

/** A long key or npub shortened for a label: its start and end. */
export function shortenPubkey(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
