import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getPublicKey, nip19 } from "nostr-tools";
const BOARD_KEY_LABEL = new TextEncoder().encode("taskify-board-nostr-key-v1");
function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
export function boardTagHash(boardId) {
    return bytesToHex(sha256(new TextEncoder().encode(boardId)));
}
export function deriveBoardKeyPair(boardId) {
    if (!boardId)
        throw new Error("Board ID missing");
    const material = concatBytes(BOARD_KEY_LABEL, new TextEncoder().encode(boardId));
    const sk = sha256(material);
    const skHex = bytesToHex(sk);
    const pk = getPublicKey(sk);
    let npub = pk;
    let nsec = skHex;
    try {
        npub = typeof nip19?.npubEncode === "function" ? nip19.npubEncode(pk) : pk;
    }
    catch {
        // ignore
    }
    try {
        nsec = typeof nip19?.nsecEncode === "function" ? nip19.nsecEncode(hexToBytes(skHex)) : skHex;
    }
    catch {
        // ignore
    }
    const signer = new NDKPrivateKeySigner(skHex);
    return { sk, skHex, pk, npub, nsec, signer };
}
export class BoardKeyManager {
    cache = new Map();
    async getBoardKeys(boardId) {
        const existing = this.cache.get(boardId);
        if (existing)
            return existing;
        const keys = deriveBoardKeyPair(boardId);
        this.cache.set(boardId, keys);
        return keys;
    }
    async getBoardSigner(boardId) {
        const keys = await this.getBoardKeys(boardId);
        return keys.signer;
    }
    async getBoardPubkey(boardId) {
        const keys = await this.getBoardKeys(boardId);
        return keys.pk;
    }
}
