import { describe, expect, test } from "vitest";
import { LS_NWC_RECEIVE_ADDRESS, LS_NWC_WALLET_CATALOG } from "../localStorageKeys";
import {
  LEGACY_NWC_URI_KEY,
  loadNwcWalletCatalog,
  removeNwcWalletProfile,
  upsertNwcWalletProfile,
} from "./nwcWalletCatalog";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("NWC wallet catalog", () => {
  test("migrates the original connection and receive address", () => {
    const storage = memoryStorage({
      [LEGACY_NWC_URI_KEY]: "nostr+walletconnect://fixture",
      [LS_NWC_RECEIVE_ADDRESS]: "Alice@Example.com",
    });
    const catalog = loadNwcWalletCatalog(storage);
    expect(catalog.wallets).toHaveLength(1);
    expect(catalog.wallets[0].receiveAddress).toBe("alice@example.com");
    expect(catalog.activeWalletId).toBe(catalog.wallets[0].id);
    expect(storage.values.has(LS_NWC_WALLET_CATALOG)).toBe(true);
    expect(storage.values.has(LEGACY_NWC_URI_KEY)).toBe(false);
  });

  test("keeps another wallet active after removing the selected one", () => {
    const first = upsertNwcWalletProfile(
      { version: 1, activeWalletId: null, wallets: [] },
      { name: "Home", uri: "nwc:home" },
    );
    const second = upsertNwcWalletProfile(first.catalog, { name: "Work", uri: "nwc:work" });
    const remaining = removeNwcWalletProfile(second.catalog, second.wallet.id);
    expect(remaining.wallets.map((wallet) => wallet.name)).toEqual(["Home"]);
    expect(remaining.activeWalletId).toBe(first.wallet.id);
  });
});
