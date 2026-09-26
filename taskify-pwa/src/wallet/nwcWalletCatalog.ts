import { LS_NWC_RECEIVE_ADDRESS, LS_NWC_WALLET_CATALOG } from "../localStorageKeys";

export const LEGACY_NWC_URI_KEY = "cashu_nwc_connection_v1";

export type NwcWalletProfile = {
  id: string;
  name: string;
  uri: string;
  receiveAddress?: string;
};

export type NwcWalletCatalog = {
  version: 1;
  activeWalletId: string | null;
  wallets: NwcWalletProfile[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const emptyNwcWalletCatalog = (): NwcWalletCatalog => ({
  version: 1,
  activeWalletId: null,
  wallets: [],
});

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `nwc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanAddress(value: unknown): string | undefined {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  return address || undefined;
}

function cleanProfile(value: unknown): NwcWalletProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NwcWalletProfile>;
  const uri = typeof candidate.uri === "string" ? candidate.uri.trim() : "";
  if (!uri) return null;
  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : makeId(),
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "NWC wallet",
    uri,
    receiveAddress: cleanAddress(candidate.receiveAddress),
  };
}

export function saveNwcWalletCatalog(storage: StorageLike, catalog: NwcWalletCatalog): void {
  storage.setItem(LS_NWC_WALLET_CATALOG, JSON.stringify(catalog));
}

/** Reads the catalog and performs the one-time migration from the original single-wallet keys. */
export function loadNwcWalletCatalog(storage: StorageLike): NwcWalletCatalog {
  try {
    const raw = storage.getItem(LS_NWC_WALLET_CATALOG);
    if (raw) {
      const decoded = JSON.parse(raw) as Partial<NwcWalletCatalog>;
      const wallets = Array.isArray(decoded.wallets)
        ? decoded.wallets.map(cleanProfile).filter((wallet): wallet is NwcWalletProfile => !!wallet)
        : [];
      const requestedActive = typeof decoded.activeWalletId === "string" ? decoded.activeWalletId : null;
      const activeWalletId = wallets.some((wallet) => wallet.id === requestedActive)
        ? requestedActive
        : wallets[0]?.id ?? null;
      return { version: 1, activeWalletId, wallets };
    }
  } catch {
    // Fall through to the legacy record. A malformed catalog must never strand that connection.
  }

  const legacyUri = storage.getItem(LEGACY_NWC_URI_KEY)?.trim();
  if (!legacyUri) return emptyNwcWalletCatalog();
  const wallet: NwcWalletProfile = {
    id: makeId(),
    name: "NWC wallet",
    uri: legacyUri,
    receiveAddress: cleanAddress(storage.getItem(LS_NWC_RECEIVE_ADDRESS)),
  };
  const catalog: NwcWalletCatalog = { version: 1, activeWalletId: wallet.id, wallets: [wallet] };
  saveNwcWalletCatalog(storage, catalog);
  storage.removeItem(LEGACY_NWC_URI_KEY);
  storage.removeItem(LS_NWC_RECEIVE_ADDRESS);
  return catalog;
}

export function upsertNwcWalletProfile(
  catalog: NwcWalletCatalog,
  input: { id?: string; name: string; uri: string; receiveAddress?: string },
): { catalog: NwcWalletCatalog; wallet: NwcWalletProfile } {
  const wallet: NwcWalletProfile = {
    id: input.id || makeId(),
    name: input.name.trim() || "NWC wallet",
    uri: input.uri.trim(),
    receiveAddress: cleanAddress(input.receiveAddress),
  };
  const existing = catalog.wallets.findIndex((entry) => entry.id === wallet.id);
  const wallets = [...catalog.wallets];
  if (existing >= 0) wallets[existing] = wallet;
  else wallets.push(wallet);
  return {
    wallet,
    catalog: { version: 1, activeWalletId: wallet.id, wallets },
  };
}

export function removeNwcWalletProfile(catalog: NwcWalletCatalog, id: string): NwcWalletCatalog {
  const wallets = catalog.wallets.filter((wallet) => wallet.id !== id);
  return {
    version: 1,
    wallets,
    activeWalletId: catalog.activeWalletId === id ? wallets[0]?.id ?? null : catalog.activeWalletId,
  };
}
