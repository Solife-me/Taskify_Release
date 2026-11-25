/**
 * The user's Taskify/Nostr identity, and its storage in the extension.
 *
 * The extension asks for the account's `nsec` once and keeps it encrypted at rest with the same
 * scheme the PWA uses: a non-extractable AES-GCM wrapping key lives in IndexedDB, and the secret
 * is stored in `chrome.storage.local` as base64(iv ‖ ciphertext). The key material never leaves
 * the browser through a WebCrypto API, so a dump of the extension's storage does not yield the
 * secret key.
 *
 * The account is the same one the PWA and the iOS/macOS apps use, so the panel shows the same
 * boards and the same chats.
 */
import { getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const WRAPPING_KEY_DB = "taskify-extension";
const WRAPPING_KEY_STORE = "keys";
const WRAPPING_KEY_ID = "identity-wrapping-key";

const SECRET_KEY_STORAGE = "taskify.identity.nsec.v1";
const PUBLIC_KEY_STORAGE = "taskify.identity.pubkey.v1";

export type StoredIdentity = {
  pubkey: string;
  /** The secret key, hex. Present only while the user is unlocked in this session. */
  secretKeyHex: string | null;
};

let wrappingKeyPromise: Promise<CryptoKey> | null = null;
let cached: StoredIdentity | null = null;
let loaded = false;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WRAPPING_KEY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WRAPPING_KEY_STORE)) {
        db.createObjectStore(WRAPPING_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the extension database."));
  });
}

function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).get(key);
        request.onsuccess = () => resolve((request.result as T) ?? null);
        request.onerror = () => reject(request.error ?? new Error("Read failed."));
      }),
  );
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Write failed."));
      }),
  );
}

/** The wrapping key: generated once, non-extractable, kept in IndexedDB. */
function getWrappingKey(): Promise<CryptoKey> {
  wrappingKeyPromise ??= (async () => {
    const existing = await idbGet<CryptoKey>(WRAPPING_KEY_STORE, WRAPPING_KEY_ID);
    if (existing && typeof existing === "object" && "type" in existing) return existing;
    const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await idbPut(WRAPPING_KEY_STORE, WRAPPING_KEY_ID, fresh);
    return fresh;
  })().catch((err) => {
    wrappingKeyPromise = null;
    throw err;
  });
  return wrappingKeyPromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

async function encryptSecret(secretKeyHex: string): Promise<string> {
  const key = await getWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secretKeyHex),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

async function decryptSecret(stored: string): Promise<string> {
  const key = await getWrappingKey();
  const bytes = base64ToBytes(stored);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

/** Accepts an `nsec1…` or a 64-character hex key, and returns the hex secret and the pubkey. */
export function parseSecretKey(input: string): { secretKeyHex: string; pubkey: string } | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    const secretKeyHex = trimmed.toLowerCase();
    try {
      return { secretKeyHex, pubkey: getPublicKey(hexToBytes(secretKeyHex)) };
    } catch {
      return null;
    }
  }

  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") return null;
    const secretKeyHex = bytesToHex(decoded.data as Uint8Array);
    return { secretKeyHex, pubkey: getPublicKey(hexToBytes(secretKeyHex)) };
  } catch {
    return null;
  }
}

/** Stores the account, encrypted. The pubkey is kept in the clear so the panel can show it. */
export async function saveIdentity(secretKeyHex: string, pubkey: string): Promise<void> {
  const cipher = await encryptSecret(secretKeyHex);
  await chrome.storage.local.set({ [SECRET_KEY_STORAGE]: cipher, [PUBLIC_KEY_STORAGE]: pubkey });
  cached = { pubkey, secretKeyHex };
  loaded = true;
}

/** Reads the stored account and decrypts the secret. */
export async function loadIdentity(): Promise<StoredIdentity | null> {
  if (loaded) return cached;
  try {
    const stored = await chrome.storage.local.get([SECRET_KEY_STORAGE, PUBLIC_KEY_STORAGE]);
    const cipher = stored[SECRET_KEY_STORAGE];
    const pubkey = stored[PUBLIC_KEY_STORAGE];
    if (typeof cipher !== "string" || typeof pubkey !== "string" || !cipher || !pubkey) {
      loaded = true;
      cached = null;
      return null;
    }
    const secretKeyHex = await decryptSecret(cipher);
    cached = { pubkey, secretKeyHex };
  } catch (err) {
    console.warn("[taskify] could not read the stored identity", err);
    cached = null;
  }
  loaded = true;
  return cached;
}

/** The pubkey alone, for a panel that only needs to know who the user is. */
export async function loadPublicKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(PUBLIC_KEY_STORAGE);
  const pubkey = stored[PUBLIC_KEY_STORAGE];
  return typeof pubkey === "string" && pubkey ? pubkey : null;
}

/** Forgets the account, on this device only. The account itself still exists on the relays. */
export async function clearIdentity(): Promise<void> {
  await chrome.storage.local.remove([SECRET_KEY_STORAGE, PUBLIC_KEY_STORAGE]);
  cached = null;
  loaded = true;
}

/** Test seam: forget the in-memory cache so the next read hits storage again. */
export function __resetIdentityCache(): void {
  cached = null;
  loaded = false;
}
