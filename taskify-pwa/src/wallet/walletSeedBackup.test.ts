// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";

// In-memory IndexedDB boundary, as in walletSecretsAtRest.test.ts; the device key crypto is real.
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

import { hasWalletData } from "./walletFlags";
import { restoreWalletSeedFromBackup, walletSeedForBackup } from "./walletSeedBackup";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

beforeEach(() => {
  idbValues.clear();
  localStorage.clear();
});

test("a device that never used the wallet backs up no seed and creates none", async () => {
  expect(hasWalletData()).toBe(false);
  expect(walletSeedForBackup()).toBeNull(); // the seed module is not even loaded

  const seed = await import("./seed");
  await seed.initWalletSeedStore();
  expect(walletSeedForBackup()).toBeNull(); // loaded, but nothing stored: still none
  expect(Object.keys(localStorage).filter((key) => key.startsWith("cashu_wallet_seed"))).toEqual([]);
  expect(hasWalletData()).toBe(false);
});

test("a seed found in a backup is restored, and later backups carry it", async () => {
  await restoreWalletSeedFromBackup({ type: "nut13-wallet-backup", version: 1, mnemonic: MNEMONIC, counters: {} });
  expect(walletSeedForBackup()).toMatchObject({ type: "nut13-wallet-backup", mnemonic: MNEMONIC });
  expect(hasWalletData()).toBe(true);
});
