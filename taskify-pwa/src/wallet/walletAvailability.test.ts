import { beforeEach, expect, test, vi } from "vitest";

// In-memory wallet store; the real one writes through to IndexedDB.
const values = new Map<string, string>();
vi.mock("../storage/idbKeyValue", () => ({
  idbKeyValue: {
    getItem: (_store: string, key: string) => values.get(key) ?? null,
    setItem: (_store: string, key: string, value: string) => { values.set(key, value); },
    removeItem: (_store: string, key: string) => { values.delete(key); },
    flushStore: async () => {},
  },
}));

// Stands in for localStorage (tests run in node).
const kv = new Map<string, string>();
vi.mock("../storage/kvStorage", () => ({
  kvStorage: {
    getItem: (key: string) => kv.get(key) ?? null,
    setItem: (key: string, value: string) => { kv.set(key, value); },
    removeItem: (key: string) => { kv.delete(key); },
  },
}));

let nwcWallets: unknown[] = [];
vi.mock("./nwcWalletCatalog", () => ({
  loadStoredNwcWalletCatalog: () => ({ version: 1, activeWalletId: null, wallets: nwcWallets }),
}));

import { addPendingToken, saveStore } from "./storage";
import { LS_NWC_SWEEP_JOURNAL, LS_WALLET_CLOSED, LS_WALLET_ENABLED, LS_WALLET_MODE } from "../localStorageKeys";
import {
  __resetWalletAvailabilityForTests,
  checkWalletCloseOut,
  closeOutWallet,
  hasWalletActivity,
  isWalletEnabled,
  refreshWalletAvailability,
} from "./walletAvailability";

const proof = { amount: 8, id: "009a1f293253e41e", secret: "s", C: "02ab" };

beforeEach(() => {
  values.clear();
  nwcWallets = [];
  kv.clear();
  __resetWalletAvailabilityForTests();
});

test("a fresh install has no wallet", () => {
  expect(hasWalletActivity()).toBe(false);
  expect(refreshWalletAvailability()).toBe(false);
  expect(isWalletEnabled()).toBe(false);
  expect(kv.get(LS_WALLET_ENABLED)).toBeUndefined();
});

test("an empty history or proof store is not activity", () => {
  values.set("cashuHistory", "[]");
  saveStore({ "https://mint.example": [] });
  expect(hasWalletActivity()).toBe(false);
});

test.each([
  ["proofs", () => saveStore({ "https://mint.example": [proof as never] })],
  ["saved tokens", () => addPendingToken("https://mint.example", "cashuAtoken", 8)],
  ["wallet history", () => values.set("cashuHistory", JSON.stringify([{ id: "h1" }]))],
  ["NWC wallet mode", () => kv.set(LS_WALLET_MODE, "nwc")],
  ["an NWC connection", () => { nwcWallets = [{ id: "w", name: "Alby", uri: "nostr+walletconnect://x" }]; }],
])("%s keep the wallet, and it stays once enabled", (_label, seed) => {
  seed();
  expect(refreshWalletAvailability()).toBe(true);
  expect(kv.get(LS_WALLET_ENABLED)).toBe("1");

  // Activity gone (e.g. funds moved out): the wallet still stays on this device.
  values.clear();
  nwcWallets = [];
  kv.delete(LS_WALLET_MODE);
  __resetWalletAvailabilityForTests();
  expect(isWalletEnabled()).toBe(true);
});

test("funds arriving later bring the wallet back", () => {
  expect(refreshWalletAvailability()).toBe(false);
  saveStore({ "https://mint.example": [proof as never] });
  expect(refreshWalletAvailability()).toBe(true);
  expect(isWalletEnabled()).toBe(true);
});

test("the wallet can't be closed out while it holds funds", () => {
  saveStore({ "https://mint.example": [proof as never] });
  addPendingToken("https://mint.example", "cashuAtoken", 8);
  kv.set(LS_NWC_SWEEP_JOURNAL, JSON.stringify({ version: 1, status: "incomplete", sources: [{ status: "awaiting_settlement" }] }));
  expect(refreshWalletAvailability()).toBe(true);

  const { blockers } = checkWalletCloseOut();
  expect(blockers).toHaveLength(3);
  expect(() => closeOutWallet()).toThrow();
  expect(isWalletEnabled()).toBe(true);
});

test("closing out returns the device to the no-wallet state, keeping wallet data", () => {
  values.set("cashuHistory", JSON.stringify([{ id: "h1", amountSat: 5, tokenState: { proofs: [{}], lastState: "UNSPENT" } }]));
  nwcWallets = [{ id: "w", name: "Alby", uri: "nostr+walletconnect://x" }];
  expect(refreshWalletAvailability()).toBe(true);

  const check = checkWalletCloseOut();
  expect(check.blockers).toEqual([]);
  expect(check.unclaimedSentSat).toBe(5);

  closeOutWallet();
  expect(isWalletEnabled()).toBe(false);
  expect(kv.get(LS_WALLET_CLOSED)).toBe("1");
  expect(values.get("cashuHistory")).toBeDefined();

  // Past activity no longer brings it back, on this launch or the next.
  expect(refreshWalletAvailability()).toBe(false);
  __resetWalletAvailabilityForTests();
  expect(refreshWalletAvailability()).toBe(false);

  // Funds do.
  saveStore({ "https://mint.example": [proof as never] });
  expect(refreshWalletAvailability()).toBe(true);
  expect(kv.get(LS_WALLET_CLOSED)).toBeUndefined();
});
