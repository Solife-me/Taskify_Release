import { sha256, b64encode, b64decode } from "./nostrPrimitives.js";

export async function boardTagHash(boardId: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(boardId));
  return Array.from(digest).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// AES key label — distinct from both the public board tag and the signing key.
// The tag uses SHA-256(boardId); the signing key uses SHA-256("taskify-board-nostr-key-v1" || boardId).
// Using a unique label here ensures the AES key cannot be recovered from the public tag.
const AES_KEY_LABEL = new TextEncoder().encode("taskify-board-aes-v1");

// Cache derived AES keys per boardId. The key material is deterministic (boardId only),
// so one derivation per board is sufficient for the lifetime of the session.
// Without this, every decryptFromBoard call ran SHA-256 + importKey — 2 async WebCrypto
// ops per event × 500 events = 1000 serial operations that blocked the queue for minutes.
const aesKeyCache = new Map<string, Promise<CryptoKey>>();
const legacyAesKeyCache = new Map<string, Promise<CryptoKey>>();

async function deriveBoardAesKey(boardId: string): Promise<CryptoKey> {
  const cached = aesKeyCache.get(boardId);
  if (cached) return cached;
  const promise = (async () => {
    const id = new TextEncoder().encode(boardId);
    const material = new Uint8Array(AES_KEY_LABEL.length + id.length);
    material.set(AES_KEY_LABEL, 0);
    material.set(id, AES_KEY_LABEL.length);
    const hash = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  aesKeyCache.set(boardId, promise);
  return promise;
}

/** Legacy key — SHA-256(boardId) with no label. Used only for decrypting old events. */
async function deriveLegacyBoardAesKey(boardId: string): Promise<CryptoKey> {
  const cached = legacyAesKeyCache.get(boardId);
  if (cached) return cached;
  const promise = (async () => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(boardId));
    return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
  })();
  legacyAesKeyCache.set(boardId, promise);
  return promise;
}

export async function encryptToBoard(boardId: string, plaintext: string): Promise<string> {
  const key = await deriveBoardAesKey(boardId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  const combined = new Uint8Array(iv.length + ctBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ctBuf), iv.length);
  return b64encode(combined);
}

export async function decryptFromBoard(
  boardId: string,
  data: string
): Promise<{ plaintext: string; usedLegacyKey: boolean }> {
  const bytes = b64decode(data);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  // Try the secure labeled key first.
  try {
    const key = await deriveBoardAesKey(boardId);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return { plaintext: new TextDecoder().decode(ptBuf), usedLegacyKey: false };
  } catch {
    // Fall back to the legacy key (SHA-256(boardId) = the public tag).
    // This handles events written before the key domain-separation fix.
    const legacyKey = await deriveLegacyBoardAesKey(boardId);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, legacyKey, ct);
    return { plaintext: new TextDecoder().decode(ptBuf), usedLegacyKey: true };
  }
}
