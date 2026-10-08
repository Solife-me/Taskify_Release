// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";

// In-memory IndexedDB boundary, as in nostrSkStore.test.ts; the CryptoKey and AES-GCM are real.
const idbValues = new Map<string, unknown>();
vi.mock("../storage/idbStorage", () => ({
  idbStorage: {
    get: vi.fn(async (_db: unknown, _store: string, key: string) => idbValues.get(key)),
    put: vi.fn(async (_db: unknown, _store: string, value: unknown, key: string) => { idbValues.set(key, value); }),
    delete: vi.fn(async (_db: unknown, _store: string, key: string) => { idbValues.delete(key); }),
  },
}));
vi.mock("../storage/taskifyDb", async () => {
  const actual = await vi.importActual<typeof import("../storage/taskifyDb")>("../storage/taskifyDb");
  return { ...actual, getTaskifyDb: vi.fn(async () => ({} as IDBDatabase)) };
});

import { __resetDeviceKeyForTests } from "../lib/deviceKeyCrypto";
import { LS_NWC_RECEIVE_ADDRESS, LS_NWC_WALLET_CATALOG } from "../localStorageKeys";
import {
  __resetNwcWalletCatalogForTests,
  initNwcWalletCatalogStore,
  LEGACY_NWC_URI_KEY,
  LS_NWC_WALLET_CATALOG_ENCRYPTED,
  loadStoredNwcWalletCatalog,
  saveStoredNwcWalletCatalog,
  upsertNwcWalletProfile,
} from "./nwcWalletCatalog";
import {
  __resetWalletSeedForTests,
  getWalletSeedMnemonic,
  initWalletSeedStore,
  LS_WALLET_SEED_ENCRYPTED,
  regenerateWalletSeed,
} from "./seed";
import {
  __resetP2pkKeyStoreForTests,
  initP2pkKeyStore,
  LS_P2PK_KEYS_ENCRYPTED,
  readStoredP2pkKeys,
  writeStoredP2pkKeys,
} from "./p2pkKeyStore";

const LS_WALLET_SEED = "cashu_wallet_seed_v1";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NWC_URI = "nostr+walletconnect://b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4?relay=wss%3A%2F%2Frelay.example&secret=71a8c14c1407c113601079c4302dab36460f0ccd0ad506f1f2dc73b5100e4f3c";

function newPage() {
  __resetDeviceKeyForTests();
  __resetWalletSeedForTests();
  __resetNwcWalletCatalogForTests();
  __resetP2pkKeyStoreForTests();
}

function storedValues(): string[] {
  return Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "");
}

beforeEach(() => {
  idbValues.clear();
  localStorage.clear();
  newPage();
});

describe("wallet seed at rest", () => {
  test("a plaintext seed is encrypted, the plaintext removed, and the same seed read back later", async () => {
    localStorage.setItem(LS_WALLET_SEED, JSON.stringify({ mnemonic: MNEMONIC, seedHex: "ab".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" }));
    await initWalletSeedStore();
    expect(getWalletSeedMnemonic()).toBe(MNEMONIC);
    expect(localStorage.getItem(LS_WALLET_SEED)).toBeNull();
    expect(localStorage.getItem(LS_WALLET_SEED_ENCRYPTED)).toBeTruthy();
    expect(storedValues().some((value) => value.includes("abandon"))).toBe(false);

    newPage();
    await initWalletSeedStore();
    expect(getWalletSeedMnemonic()).toBe(MNEMONIC);
  });

  test("a new seed is written only as ciphertext", async () => {
    await initWalletSeedStore();
    const { mnemonic } = regenerateWalletSeed();
    await vi.waitFor(() => expect(localStorage.getItem(LS_WALLET_SEED_ENCRYPTED)).toBeTruthy());
    expect(localStorage.getItem(LS_WALLET_SEED)).toBeNull();
    expect(storedValues().some((value) => value.includes(mnemonic.split(" ")[0] + " " + mnemonic.split(" ")[1]))).toBe(false);
  });

  test("an encrypted seed that has not been unlocked is never replaced by a new one", async () => {
    localStorage.setItem(LS_WALLET_SEED, JSON.stringify({ mnemonic: MNEMONIC, seedHex: "ab".repeat(64) }));
    await initWalletSeedStore();
    const cipher = localStorage.getItem(LS_WALLET_SEED_ENCRYPTED);
    newPage(); // a new page that skipped initWalletSeedStore()
    expect(() => getWalletSeedMnemonic()).toThrow(/not been unlocked/);
    expect(localStorage.getItem(LS_WALLET_SEED_ENCRYPTED)).toBe(cipher);
  });

  test("a seed whose key was wiped is set aside, not deleted", async () => {
    localStorage.setItem(LS_WALLET_SEED, JSON.stringify({ mnemonic: MNEMONIC, seedHex: "ab".repeat(64) }));
    await initWalletSeedStore();
    const cipher = localStorage.getItem(LS_WALLET_SEED_ENCRYPTED);
    idbValues.clear(); // the browser dropped IndexedDB but kept localStorage
    newPage();
    await initWalletSeedStore();
    expect(localStorage.getItem(`${LS_WALLET_SEED_ENCRYPTED}_unreadable`)).toBe(cipher);
  });
});

describe("NWC connections at rest", () => {
  test("the original single connection is folded into an encrypted catalog", async () => {
    localStorage.setItem(LEGACY_NWC_URI_KEY, NWC_URI);
    localStorage.setItem(LS_NWC_RECEIVE_ADDRESS, "alice@example.com");
    await initNwcWalletCatalogStore();
    const catalog = loadStoredNwcWalletCatalog();
    expect(catalog.wallets[0].uri).toBe(NWC_URI);
    expect(localStorage.getItem(LEGACY_NWC_URI_KEY)).toBeNull();
    expect(localStorage.getItem(LS_NWC_WALLET_CATALOG)).toBeNull();
    expect(localStorage.getItem(LS_NWC_WALLET_CATALOG_ENCRYPTED)).toBeTruthy();
    expect(storedValues().some((value) => value.includes("secret="))).toBe(false);

    newPage();
    await initNwcWalletCatalogStore();
    expect(loadStoredNwcWalletCatalog().wallets[0].uri).toBe(NWC_URI);
  });

  test("saving a catalog writes no connection string in plain text", async () => {
    await initNwcWalletCatalogStore();
    const { catalog } = upsertNwcWalletProfile(loadStoredNwcWalletCatalog(), { name: "Home", uri: NWC_URI });
    saveStoredNwcWalletCatalog(catalog);
    await vi.waitFor(() => expect(localStorage.getItem(LS_NWC_WALLET_CATALOG_ENCRYPTED)).toBeTruthy());
    expect(storedValues().some((value) => value.includes("secret="))).toBe(false);
    expect(loadStoredNwcWalletCatalog().wallets[0].uri).toBe(NWC_URI);
  });
});

describe("P2PK keys at rest", () => {
  const PRIV = "7f".repeat(32);
  const LIST = JSON.stringify({ keys: [{ id: "k1", publicKey: "02" + "aa".repeat(32), privateKey: PRIV, createdAt: 1, usedCount: 0 }], primaryKeyId: "k1" });

  test("a plaintext key list is encrypted, the plaintext removed, and read back on the next page", async () => {
    localStorage.setItem("cashu_p2pk_keys_v1", LIST);
    await initP2pkKeyStore();
    expect(readStoredP2pkKeys()).toBe(LIST);
    expect(localStorage.getItem("cashu_p2pk_keys_v1")).toBeNull();
    expect(localStorage.getItem(LS_P2PK_KEYS_ENCRYPTED)).toBeTruthy();
    expect(storedValues().some((value) => value.includes(PRIV))).toBe(false);

    newPage();
    await initP2pkKeyStore();
    expect(readStoredP2pkKeys()).toBe(LIST);
  });

  test("an encrypted list that has not been unlocked is neither read as empty nor overwritten", async () => {
    await initP2pkKeyStore();
    await writeStoredP2pkKeys(LIST);
    const cipher = localStorage.getItem(LS_P2PK_KEYS_ENCRYPTED);
    newPage();
    expect(() => readStoredP2pkKeys()).toThrow();
    await expect(writeStoredP2pkKeys(JSON.stringify({ keys: [], primaryKeyId: null }))).rejects.toThrow();
    expect(localStorage.getItem(LS_P2PK_KEYS_ENCRYPTED)).toBe(cipher);
  });
});
