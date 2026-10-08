/**
 * `deviceKeyCrypto`
 * -----------------
 * AES-GCM encryption under one per-browser wrapping key, for secrets kept in
 * `localStorage` (the Nostr key, the wallet seed, NWC connection strings).
 *
 * The wrapping key lives in IndexedDB as a non-extractable CryptoKey, so a dump
 * of the browser's storage files does not yield the secrets. It does not stop
 * script running in the page: that script can ask WebCrypto to decrypt too.
 *
 * Ciphertext format: base64(iv ‖ ciphertext).
 */

import { idbStorage } from "../storage/idbStorage";
import { getTaskifyDb, TASKIFY_STORE_NOSTR } from "../storage/taskifyDb";

const WRAPPING_KEY_IDB_KEY = "sk_wrapping_key";

let wrappingKeyPromise: Promise<CryptoKey> | null = null;

function getSubtle(): SubtleCrypto | null {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (!c?.subtle) return null;
    return c.subtle;
  } catch {
    return null;
  }
}

async function loadOrCreateWrappingKey(): Promise<CryptoKey> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  const db = await getTaskifyDb();
  const existing = await idbStorage.get<unknown>(db, TASKIFY_STORE_NOSTR, WRAPPING_KEY_IDB_KEY);
  if (existing && typeof existing === "object" && "type" in existing && "algorithm" in existing) {
    return existing as CryptoKey;
  }
  const fresh = await subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: bytes never leave the browser via WebCrypto APIs
    ["encrypt", "decrypt"],
  );
  await idbStorage.put(db, TASKIFY_STORE_NOSTR, fresh, WRAPPING_KEY_IDB_KEY);
  return fresh;
}

/**
 * One lookup per page. Several stores initialise at once during boot; without this, two of
 * them could each create a key, and whichever was stored first would leave its ciphertext
 * unreadable on the next load.
 */
function getOrCreateWrappingKey(): Promise<CryptoKey> {
  if (!wrappingKeyPromise) {
    wrappingKeyPromise = loadOrCreateWrappingKey().catch((err) => {
      wrappingKeyPromise = null;
      throw err;
    });
  }
  return wrappingKeyPromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptWithDeviceKey(plaintext: string): Promise<string> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  const key = await getOrCreateWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(combined);
}

export async function decryptWithDeviceKey(encoded: string): Promise<string> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  const key = await getOrCreateWrappingKey();
  const combined = base64ToBytes(encoded);
  if (combined.length < 13) throw new Error("Ciphertext too short");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12));
  return new TextDecoder().decode(pt);
}

/** Test-only: forget the cached key so a test can simulate a new page or a wiped key. */
export function __resetDeviceKeyForTests(): void {
  wrappingKeyPromise = null;
}
