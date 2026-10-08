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
 *   - IndexedDB `nostr` store at key `sk_wrapping_key` — non-extractable CryptoKey,
 *     shared with the wallet seed and NWC stores (see `deviceKeyCrypto`)
 *
 * Public API is sync-after-init: callers `await init()` once during app boot,
 * then use `getSkSync()` from synchronous code paths. Writes are async.
 */

import { kvStorage } from "../storage/kvStorage";
import { LS_NOSTR_SK as LS_NOSTR_SK_V1 } from "../nostrKeys";
import { __resetDeviceKeyForTests, decryptWithDeviceKey, encryptWithDeviceKey } from "./deviceKeyCrypto";

export const LS_NOSTR_SK_V2 = "taskify_nostr_sk_v2";
/** Set to "1" the first time we migrate v1 plaintext → v2 ciphertext, so the
 *  app can show a one-time "back up your nsec" prompt. Cleared by
 *  `acknowledgeBackupNotice()` when the user dismisses the prompt. Never set
 *  for fresh installs (no v1 existed). */
export const LS_NOSTR_SK_BACKUP_PENDING = "taskify_nostr_sk_backup_pending";

let cached: string = "";
let loaded = false;
let inflightInit: Promise<void> | null = null;

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
        cached = await decryptWithDeviceKey(v2);
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
        const cipher = await encryptWithDeviceKey(v1);
        kvStorage.setItem(LS_NOSTR_SK_V2, cipher);
        kvStorage.removeItem(LS_NOSTR_SK_V1);
        // Flag for the one-time "back up your nsec" prompt. The user is now
        // in the v2-only state where losing the IDB wrapping key without a
        // separate nsec backup means losing access to the identity.
        kvStorage.setItem(LS_NOSTR_SK_BACKUP_PENDING, "1");
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
    const cipher = await encryptWithDeviceKey(trimmed);
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
  kvStorage.removeItem(LS_NOSTR_SK_BACKUP_PENDING);
  cached = "";
  loaded = true;
}

/** Whether the one-time "back up your nsec" prompt should be shown. True only
 *  after a v1→v2 migration has just run and the user hasn't acknowledged. */
export function isBackupNoticePending(): boolean {
  return kvStorage.getItem(LS_NOSTR_SK_BACKUP_PENDING) === "1";
}

/** Mark the backup prompt as dismissed; the banner never shows again. */
export function acknowledgeBackupNotice(): void {
  kvStorage.removeItem(LS_NOSTR_SK_BACKUP_PENDING);
}

/** Test-only: reset module state. Does not touch storage. */
export function __resetForTests(): void {
  cached = "";
  loaded = false;
  inflightInit = null;
  __resetDeviceKeyForTests();
}
