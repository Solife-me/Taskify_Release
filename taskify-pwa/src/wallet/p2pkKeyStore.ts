import { createEncryptedSlot } from "../lib/encryptedSlot";
import { LS_P2PK_KEYS } from "../localStorageKeys";
import { kvStorage } from "../storage/kvStorage";

// v1 held the P2PK key list as plaintext JSON; v2 holds the same JSON as device-key ciphertext.
export const LS_P2PK_KEYS_ENCRYPTED = "cashu_p2pk_keys_v2";

function isKeyListJson(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && Array.isArray(parsed.keys);
  } catch {
    return false;
  }
}

const keySlot = createEncryptedSlot({
  plainKey: LS_P2PK_KEYS,
  cipherKey: LS_P2PK_KEYS_ENCRYPTED,
  label: "p2pkKeys",
  isValid: isKeyListJson,
});

/** Called from `storageBootstrap` before the P2PK provider mounts. */
export function initP2pkKeyStore(): Promise<void> {
  return keySlot.init();
}

/** Whether a stored key list exists that has not been decrypted, so must not be overwritten. */
export function isP2pkKeyStoreLocked(): boolean {
  return !keySlot.isLoaded() && keySlot.hasCiphertext();
}

export function readStoredP2pkKeys(): string | null {
  if (keySlot.isLoaded()) return keySlot.get();
  if (keySlot.hasCiphertext()) throw new Error("The P2PK keys have not been unlocked yet.");
  return kvStorage.getItem(LS_P2PK_KEYS);
}

export function writeStoredP2pkKeys(raw: string): Promise<void> {
  if (isP2pkKeyStoreLocked()) {
    return Promise.reject(new Error("The P2PK keys have not been unlocked yet."));
  }
  return keySlot.set(raw);
}

export function __resetP2pkKeyStoreForTests(): void {
  keySlot.__resetForTests();
}
