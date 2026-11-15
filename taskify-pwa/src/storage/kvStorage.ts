/**
 * `kvStorage`
 * -----------
 * Lightweight, synchronous key/value storage backed by `localStorage`.
 *
 * Intended for small values such as:
 * - feature flags and toggles
 * - lightweight caches
 * - small configuration values / keys
 *
 * This module intentionally has no domain knowledge (wallet/task/nostr/etc).
 *
 * IMPORTANT:
 * - In production code, this is the only module that may read/write `localStorage`.
 * - In development, `localStorageGuardrails` may instrument `localStorage` access
 *   to warn if other modules touch it directly.
 * Callers should store small strings. JSON encoding/decoding (if needed) is the
 * caller's responsibility and should be used sparingly.
 */

export type KvStorage = {
  /**
   * Returns true when `localStorage` is present and can be accessed.
   * This does not guarantee writes will succeed (quota, private mode, etc).
   */
  isAvailable: () => boolean;

  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;

  getString: (key: string, fallback?: string) => string;
  setString: (key: string, value: string) => void;

  getBoolean: (key: string, fallback?: boolean) => boolean;
  setBoolean: (key: string, value: boolean) => void;

  getNumber: (key: string, fallback?: number) => number;
  setNumber: (key: string, value: number) => void;
};

function getLocalStorage(): Storage | null {
  try {
    // `globalThis` access is safe across environments; it returns `undefined` outside the browser.
    const storage = (globalThis as any)?.localStorage as Storage | undefined;
    return storage ?? null;
  } catch {
    return null;
  }
}

const KV_STORAGE_ACCESS_DEPTH = Symbol.for("taskify.kvStorage.localStorageAccessDepth");

function withKvStorageLocalStorageAccess<T>(fn: () => T): T {
  if (!import.meta.env.DEV) return fn();
  const globalAny = globalThis as any;
  const existing = globalAny[KV_STORAGE_ACCESS_DEPTH];
  const depth = typeof existing === "number" && Number.isFinite(existing) ? existing : 0;
  globalAny[KV_STORAGE_ACCESS_DEPTH] = depth + 1;
  try {
    return fn();
  } finally {
    globalAny[KV_STORAGE_ACCESS_DEPTH] = depth;
  }
}

// Bootstrap pins the scope for the life of the page. Device keys have to be readable
// before choosing an account.
const DEVICE_KEYS = new Set([
  "taskify_nostr_sk_v1", "taskify_nostr_sk_v2", "taskify_nostr_sk_backup_pending",
]);
let accountPrefix = "";

export function setAccountStoragePrefix(prefix: string): void {
  accountPrefix = prefix;
}

function accountStorageKey(key: string, prefix = accountPrefix): string {
  return DEVICE_KEYS.has(key) ? key : prefix + key;
}

export function writeAccountStorageValue(prefix: string, key: string, value: string): void {
  const storage = getLocalStorage();
  if (!storage) return;
  withKvStorageLocalStorageAccess(() => storage.setItem(accountStorageKey(key, prefix), value));
}

export const kvStorage: KvStorage = {
  isAvailable() {
    return getLocalStorage() !== null;
  },

  getItem(key) {
    const storage = getLocalStorage();
    if (!storage) return null;
    try {
      return withKvStorageLocalStorageAccess(() => storage.getItem(accountStorageKey(key)));
    } catch {
      return null;
    }
  },

  setItem(key, value) {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      withKvStorageLocalStorageAccess(() => storage.setItem(accountStorageKey(key), value));
    } catch {
      // ignore persistence failures
    }
  },

  removeItem(key) {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      withKvStorageLocalStorageAccess(() => storage.removeItem(accountStorageKey(key)));
    } catch {
      // ignore removal failures
    }
  },

  getString(key, fallback = "") {
    return kvStorage.getItem(key) ?? fallback;
  },

  setString(key, value) {
    kvStorage.setItem(key, value);
  },

  getBoolean(key, fallback = false) {
    const raw = kvStorage.getItem(key);
    if (raw === null) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
    return fallback;
  },

  setBoolean(key, value) {
    kvStorage.setItem(key, value ? "1" : "0");
  },

  getNumber(key, fallback = 0) {
    const raw = kvStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  },

  setNumber(key, value) {
    kvStorage.setItem(key, String(value));
  },
};
