/**
 * `nostrSkStore`
 * --------------
 * AES-GCM at-rest encryption for the local Nostr secret key.
 *
 * Threat model: a malicious browser extension or forensic disk imaging that
 * dumps `localStorage` should not yield the raw SK. The wrapping key lives in
 * IndexedDB as a non-extractable CryptoKey — the browser stores it as an
 * opaque handle and never exposes the raw bytes via the WebCrypto API, so an
 * attacker also needs a live, scripted browser session to decrypt.
 *
 * Storage layout:
 *   - localStorage key `LS_NOSTR_SK_V1` (legacy plaintext) — migrated then deleted
 *   - localStorage key `LS_NOSTR_SK_V2` — base64(iv ‖ ciphertext)
 *   - IndexedDB `nostr` store at key `sk_wrapping_key` — non-extractable CryptoKey
 *
 * Public API is sync-after-init: callers `await init()` once during app boot,
 * then use `getSkSync()` from synchronous code paths. Writes are async.
 */

import { kvStorage } from "../storage/kvStorage";
import { idbStorage } from "../storage/idbStorage";
import { getTaskifyDb, TASKIFY_STORE_NOSTR } from "../storage/taskifyDb";
import { LS_NOSTR_SK as LS_NOSTR_SK_V1 } from "../nostrKeys";

export const LS_NOSTR_SK_V2 = "taskify_nostr_sk_v2";
const WRAPPING_KEY_IDB_KEY = "sk_wrapping_key";

let cached: string = "";
let loaded = false;
let inflightInit: Promise<void> | null = null;

function getSubtle(): SubtleCrypto | null {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (!c?.subtle) return null;
    return c.subtle;
  } catch {
    return null;
  }
}

async function getOrCreateWrappingKey(): Promise<CryptoKey> {
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

async function encryptSk(plaintextHex: string, key: CryptoKey): Promise<string> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintextHex);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(combined);
}

async function decryptSk(encoded: string, key: CryptoKey): Promise<string> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  const combined = base64ToBytes(encoded);
  if (combined.length < 13) throw new Error("Ciphertext too short");
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * Idempotent init. Decrypts an existing v2 ciphertext OR migrates legacy v1
 * plaintext into v2 OR no-ops when no SK is present. Must be awaited before
 * `getSkSync()` returns the right value.
 */
export async function init(): Promise<void> {
  if (loaded) return;
  if (inflightInit) return inflightInit;
  inflightInit = (async () => {
    const v2 = kvStorage.getItem(LS_NOSTR_SK_V2);
    if (v2) {
      try {
        const key = await getOrCreateWrappingKey();
        cached = await decryptSk(v2, key);
        // If a stale v1 still exists alongside a valid v2, ensure v1 is gone.
        if (kvStorage.getItem(LS_NOSTR_SK_V1)) kvStorage.removeItem(LS_NOSTR_SK_V1);
        loaded = true;
        return;
      } catch (err) {
        // v2 is unreadable — wrapping key may have been wiped (e.g. browser
        // data cleared per-site). Fall through and check v1.
        console.warn("[nostrSkStore] failed to decrypt v2 ciphertext", err);
      }
    }
    const v1 = kvStorage.getItem(LS_NOSTR_SK_V1);
    if (v1) {
      try {
        const key = await getOrCreateWrappingKey();
        const cipher = await encryptSk(v1, key);
        kvStorage.setItem(LS_NOSTR_SK_V2, cipher);
        kvStorage.removeItem(LS_NOSTR_SK_V1);
        cached = v1;
        loaded = true;
        return;
      } catch (err) {
        // Encryption failed (no WebCrypto?). Keep v1 plaintext available so
        // the app stays functional; cached holds the plaintext for sync reads.
        console.warn("[nostrSkStore] migration v1→v2 failed; retaining plaintext v1", err);
        cached = v1;
        loaded = true;
        return;
      }
    }
    cached = "";
    loaded = true;
  })().finally(() => {
    inflightInit = null;
  });
  return inflightInit;
}

/** Synchronous read. Returns "" if not initialized or no SK is present. */
export function getSkSync(): string {
  return cached;
}

export function isLoaded(): boolean {
  return loaded;
}

/** Awaits in-flight init or kicks one off if not started yet. */
export function whenLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflightInit) return inflightInit;
  return init();
}

/** Encrypt and persist a new SK. Updates the in-memory cache synchronously. */
export async function setSk(skHex: string): Promise<void> {
  const trimmed = (skHex || "").trim();
  if (!trimmed) {
    await clearSk();
    return;
  }
  try {
    const key = await getOrCreateWrappingKey();
    const cipher = await encryptSk(trimmed, key);
    kvStorage.setItem(LS_NOSTR_SK_V2, cipher);
    kvStorage.removeItem(LS_NOSTR_SK_V1);
    cached = trimmed;
    loaded = true;
  } catch (err) {
    // Fallback: if encryption is unavailable for any reason, persist as v1
    // plaintext rather than dropping the SK entirely. This preserves
    // functionality on browsers/contexts without WebCrypto.
    console.warn("[nostrSkStore] encryption unavailable, falling back to v1 plaintext", err);
    kvStorage.setItem(LS_NOSTR_SK_V1, trimmed);
    cached = trimmed;
    loaded = true;
  }
}

export async function clearSk(): Promise<void> {
  kvStorage.removeItem(LS_NOSTR_SK_V1);
  kvStorage.removeItem(LS_NOSTR_SK_V2);
  cached = "";
  loaded = true;
}

/** Test-only: reset module state. Does not touch storage. */
export function __resetForTests(): void {
  cached = "";
  loaded = false;
  inflightInit = null;
}
