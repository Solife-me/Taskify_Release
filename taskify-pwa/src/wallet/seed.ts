import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const LS_WALLET_SEED = "cashu_wallet_seed_v1";
const LS_WALLET_COUNTERS = "cashu_wallet_seed_counters_v1";
const DEFAULT_STRENGTH = 128;
const COUNTER_KEY_SEPARATOR = "|";

export type WalletSeedRecord = {
  mnemonic: string;
  seedHex: string;
  createdAt?: string;
};

type WalletCounterStore = Record<string, number>;

type WalletSeedBackupPayload = {
  type: "nut13-wallet-backup";
  version: 1;
  mnemonic: string;
  createdAt?: string;
  counters: Record<string, Record<string, number>>;
};

let seedCache: WalletSeedRecord | null = null;
let counterCache: WalletCounterStore | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore storage access issues (e.g., SSR or private mode restrictions)
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Invalid hex value");
  }
  const result = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    result[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return result;
}

function normalizeMnemonic(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

function normalizeMintUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function counterKey(mintUrl: string, keysetId: string): string {
  return `${normalizeMintUrl(mintUrl)}${COUNTER_KEY_SEPARATOR}${keysetId}`;
}

function splitCounterKey(key: string): [string, string] | null {
  const index = key.indexOf(COUNTER_KEY_SEPARATOR);
  if (index <= 0) return null;
  const mint = key.slice(0, index);
  const keysetId = key.slice(index + COUNTER_KEY_SEPARATOR.length);
  if (!mint || !keysetId) return null;
  return [mint, keysetId];
}

function readSeedRecordFromStorage(): WalletSeedRecord | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LS_WALLET_SEED);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const mnemonicRaw = typeof parsed?.mnemonic === "string" ? parsed.mnemonic : "";
    const seedHexRaw = typeof parsed?.seedHex === "string" ? parsed.seedHex : "";
    if (!mnemonicRaw || !seedHexRaw) return null;
    const mnemonic = normalizeMnemonic(mnemonicRaw);
    if (!validateMnemonic(mnemonic, wordlist)) return null;
    const seedHex = seedHexRaw.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(seedHex) || seedHex.length % 2 !== 0) return null;
    return {
      mnemonic,
      seedHex,
      createdAt: typeof parsed?.createdAt === "string" ? parsed.createdAt : undefined,
    };
  } catch {
    return null;
  }
}

function persistSeedRecord(record: WalletSeedRecord) {
  seedCache = record;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(
      LS_WALLET_SEED,
      JSON.stringify({
        mnemonic: record.mnemonic,
        seedHex: record.seedHex,
        createdAt: record.createdAt,
      }),
    );
  } catch {
    // ignore persistence failures
  }
}

function generateSeedRecord(): WalletSeedRecord {
  const mnemonic = normalizeMnemonic(generateMnemonic(wordlist, DEFAULT_STRENGTH));
  const seed = mnemonicToSeedSync(mnemonic);
  return {
    mnemonic,
    seedHex: bytesToHex(seed),
    createdAt: new Date().toISOString(),
  };
}

function ensureSeedRecord(): WalletSeedRecord {
  if (seedCache) {
    return seedCache;
  }
  const stored = readSeedRecordFromStorage();
  if (stored) {
    seedCache = stored;
    return stored;
  }
  const generated = generateSeedRecord();
  persistSeedRecord(generated);
  return generated;
}

function readCounterStoreFromStorage(): WalletCounterStore {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(LS_WALLET_COUNTERS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const normalized: WalletCounterStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "number") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        normalized[key] = Math.max(0, Math.floor(numeric));
        continue;
      }
      normalized[key] = Math.max(0, Math.floor(value));
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadCounterStore(): WalletCounterStore {
  if (counterCache) {
    return { ...counterCache };
  }
  const store = readCounterStoreFromStorage();
  counterCache = { ...store };
  return store;
}

function persistCounterStore(store: WalletCounterStore) {
  counterCache = { ...store };
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(LS_WALLET_COUNTERS, JSON.stringify(counterCache));
  } catch {
    // ignore persistence failures
  }
}

export function getWalletSeedMnemonic(): string {
  return ensureSeedRecord().mnemonic;
}

export function getWalletSeedBytes(): Uint8Array {
  return hexToBytes(ensureSeedRecord().seedHex);
}

export function getWalletCounterInit(mintUrl: string): Record<string, number> {
  const store = loadCounterStore();
  const normalizedMint = normalizeMintUrl(mintUrl);
  const prefix = `${normalizedMint}${COUNTER_KEY_SEPARATOR}`;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    const keysetId = key.slice(prefix.length);
    if (!keysetId) continue;
    result[keysetId] = Math.max(0, Math.floor(value));
  }
  return result;
}

export function persistWalletCounter(mintUrl: string, keysetId: string, next: number) {
  if (!mintUrl || !keysetId) return;
  const normalizedMint = normalizeMintUrl(mintUrl);
  if (!normalizedMint) return;
  const numeric = Math.max(0, Math.floor(Number(next)));
  if (!Number.isFinite(numeric)) return;
  const store = loadCounterStore();
  store[counterKey(normalizedMint, keysetId)] = numeric;
  persistCounterStore(store);
}

export function persistWalletCounterSnapshot(mintUrl: string, snapshot: Record<string, number> | null | undefined) {
  if (!mintUrl || !snapshot || typeof snapshot !== "object") return;
  const normalizedMint = normalizeMintUrl(mintUrl);
  if (!normalizedMint) return;
  const store = loadCounterStore();
  const prefix = `${normalizedMint}${COUNTER_KEY_SEPARATOR}`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  for (const [keysetId, value] of Object.entries(snapshot)) {
    const numeric = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(numeric) || !keysetId) continue;
    store[counterKey(normalizedMint, keysetId)] = numeric;
  }
  persistCounterStore(store);
}

export function getWalletSeedBackup(): WalletSeedBackupPayload {
  const record = ensureSeedRecord();
  const store = loadCounterStore();
  const counters: Record<string, Record<string, number>> = {};
  for (const [key, value] of Object.entries(store)) {
    const pair = splitCounterKey(key);
    if (!pair) continue;
    const [mint, keysetId] = pair;
    if (!counters[mint]) counters[mint] = {};
    counters[mint][keysetId] = Math.max(0, Math.floor(value));
  }
  return {
    type: "nut13-wallet-backup",
    version: 1,
    mnemonic: record.mnemonic,
    createdAt: record.createdAt,
    counters,
  };
}

export function getWalletSeedBackupJson(): string {
  return JSON.stringify(getWalletSeedBackup(), null, 2);
}

export function regenerateWalletSeed(): WalletSeedRecord {
  const record = generateSeedRecord();
  persistSeedRecord(record);
  persistCounterStore({});
  return record;
}

export function getWalletCountersByMint(): Record<string, Record<string, number>> {
  const store = loadCounterStore();
  const grouped: Record<string, Record<string, number>> = {};
  for (const [key, value] of Object.entries(store)) {
    const pair = splitCounterKey(key);
    if (!pair) continue;
    const [mint, keysetId] = pair;
    if (!grouped[mint]) grouped[mint] = {};
    grouped[mint][keysetId] = Math.max(0, Math.floor(value));
  }
  return grouped;
}

export function incrementWalletCounter(mintUrl: string, keysetId: string, delta = 1): number {
  if (!mintUrl || !keysetId) {
    throw new Error("Missing mint URL or keyset ID");
  }
  const clampedDelta = Math.max(1, Math.floor(Number.isFinite(delta) ? delta : 1));
  const existing = getWalletCounterInit(mintUrl)[keysetId] ?? 0;
  const next = existing + clampedDelta;
  persistWalletCounter(mintUrl, keysetId, next);
  return next;
}
