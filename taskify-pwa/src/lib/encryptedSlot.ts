/**
 * `encryptedSlot`
 * ---------------
 * One secret string in `localStorage`, kept as device-key ciphertext (see `deviceKeyCrypto`)
 * with an in-memory copy for synchronous reads.
 *
 * Callers `await init()` during boot (`storageBootstrap`), then read with `get()`. `init()`
 * decrypts the ciphertext or migrates the original plaintext key. Plaintext is removed only
 * after its ciphertext has been written and read back, and a ciphertext that can no longer be
 * decrypted is set aside under `<cipherKey>_unreadable` rather than deleted. If WebCrypto or
 * IndexedDB is unavailable the value stays in plaintext so the feature keeps working.
 */

import { kvStorage } from "../storage/kvStorage";
import { decryptWithDeviceKey, encryptWithDeviceKey } from "./deviceKeyCrypto";

export type EncryptedSlot = {
  init(): Promise<void>;
  isLoaded(): boolean;
  /** Whether ciphertext is stored, i.e. a value exists that cannot be read before `init()`. */
  hasCiphertext(): boolean;
  get(): string | null;
  /** Updates the in-memory value at once; resolves when storage has caught up. */
  set(value: string | null): Promise<void>;
  __resetForTests(): void;
};

export function createEncryptedSlot(options: {
  plainKey: string;
  cipherKey: string;
  label: string;
  isValid?: (value: string) => boolean;
}): EncryptedSlot {
  const { plainKey, cipherKey, label } = options;
  const isValid = options.isValid ?? (() => true);
  const unreadableKey = `${cipherKey}_unreadable`;
  let cached: string | null = null;
  let loaded = false;
  let inflight: Promise<void> | null = null;
  // Every storage write goes through this chain, in call order, so a slow migration can never
  // land after (and overwrite) a newer value.
  let writes: Promise<void> = Promise.resolve();

  function enqueue(write: () => Promise<void>): Promise<void> {
    writes = writes.catch(() => {}).then(write);
    return writes;
  }

  async function encryptAndVerify(value: string): Promise<string> {
    const cipher = await encryptWithDeviceKey(value);
    if ((await decryptWithDeviceKey(cipher)) !== value) throw new Error("ciphertext did not read back");
    return cipher;
  }

  async function init(): Promise<void> {
    if (loaded) return;
    if (inflight) return inflight;
    inflight = (async () => {
      const cipher = kvStorage.getItem(cipherKey);
      const plain = kvStorage.getItem(plainKey);
      if (cipher) {
        try {
          const value = await decryptWithDeviceKey(cipher);
          if (!isValid(value)) throw new Error("decrypted value is not valid");
          cached = value;
          loaded = true;
          if (plain !== null) kvStorage.removeItem(plainKey);
          return;
        } catch (err) {
          console.warn(`[${label}] stored ciphertext could not be read; keeping it aside`, err);
          if (!kvStorage.getItem(unreadableKey)) kvStorage.setItem(unreadableKey, cipher);
          kvStorage.removeItem(cipherKey);
        }
      }
      if (plain !== null && isValid(plain)) {
        cached = plain;
        loaded = true;
        await enqueue(async () => {
          try {
            kvStorage.setItem(cipherKey, await encryptAndVerify(plain));
            kvStorage.removeItem(plainKey);
          } catch (err) {
            console.warn(`[${label}] could not encrypt; keeping plaintext`, err);
          }
        });
        return;
      }
      cached = null;
      loaded = true;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function set(value: string | null): Promise<void> {
    cached = value;
    loaded = true;
    return enqueue(async () => {
      if (value === null) {
        kvStorage.removeItem(cipherKey);
        kvStorage.removeItem(plainKey);
        return;
      }
      try {
        kvStorage.setItem(cipherKey, await encryptAndVerify(value));
        kvStorage.removeItem(plainKey);
      } catch (err) {
        // Losing the value is worse than storing it unencrypted.
        console.warn(`[${label}] could not encrypt; storing plaintext`, err);
        kvStorage.setItem(plainKey, value);
        kvStorage.removeItem(cipherKey);
      }
    });
  }

  return {
    init,
    isLoaded: () => loaded,
    hasCiphertext: () => kvStorage.getItem(cipherKey) !== null,
    get: () => cached,
    set,
    __resetForTests: () => {
      cached = null;
      loaded = false;
      inflight = null;
      writes = Promise.resolve();
    },
  };
}
