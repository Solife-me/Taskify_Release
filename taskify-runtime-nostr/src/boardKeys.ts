import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getPublicKey, nip19 } from "nostr-tools";

export type BoardKeyPair = {
  sk: Uint8Array;
  skHex: string;
  pk: string;
  npub: string;
  nsec: string;
  signer: NDKPrivateKeySigner;
};

const BOARD_KEY_LABEL = new TextEncoder().encode("taskify-board-nostr-key-v1");

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function boardTagHash(boardId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(boardId)));
}

export function deriveBoardKeyPair(boardId: string): BoardKeyPair {
  if (!boardId) throw new Error("Board ID missing");
  const material = concatBytes(BOARD_KEY_LABEL, new TextEncoder().encode(boardId));
  const sk = sha256(material);
  const skHex = bytesToHex(sk);
  const pk = getPublicKey(sk);

  let npub = pk;
  let nsec = skHex;
  try {
    npub = typeof (nip19 as any)?.npubEncode === "function" ? (nip19 as any).npubEncode(pk) : pk;
  } catch {
    // ignore
  }
  try {
    nsec = typeof (nip19 as any)?.nsecEncode === "function" ? (nip19 as any).nsecEncode(hexToBytes(skHex)) : skHex;
  } catch {
    // ignore
  }

  const signer = new NDKPrivateKeySigner(skHex);
  return { sk, skHex, pk, npub, nsec, signer };
}

export class BoardKeyManager {
  private cache = new Map<string, BoardKeyPair>();

  async getBoardKeys(boardId: string): Promise<BoardKeyPair> {
    const existing = this.cache.get(boardId);
    if (existing) return existing;
    const keys = deriveBoardKeyPair(boardId);
    this.cache.set(boardId, keys);
    return keys;
  }

  async getBoardSigner(boardId: string): Promise<NDKPrivateKeySigner> {
    const keys = await this.getBoardKeys(boardId);
    return keys.signer;
  }

  async getBoardPubkey(boardId: string): Promise<string> {
    const keys = await this.getBoardKeys(boardId);
    return keys.pk;
  }
}
