/**
 * The startup-safe half of wallet availability: whether the (phasing-out) wallet is shown on
 * this device (and, after the removal date, whether its recovery view is), and whether the device holds any wallet data at all. Reads raw storage only, so
 * it pulls no wallet code into startup; `walletAvailability` (loaded only where wallet data
 * exists) decides when the wallet comes back.
 */
import { useSyncExternalStore } from "react";
import { isWalletRemoved } from "./walletPhaseOut";
import { kvStorage } from "../storage/kvStorage";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../storage/taskifyDb";
import {
  LS_NWC_WALLET_CATALOG,
  LS_P2PK_KEYS,
  LS_WALLET_CLOSED,
  LS_WALLET_ENABLED,
  LS_WALLET_MODE,
} from "../localStorageKeys";

/** Keys any wallet use leaves behind (plain and encrypted forms). */
const WALLET_KV_KEYS = [
  "cashu_wallet_seed_v1",
  "cashu_wallet_seed_v2",
  "cashu_wallet_seed_counters_v1",
  LS_P2PK_KEYS,
  "cashu_p2pk_keys_v2",
  LS_NWC_WALLET_CATALOG,
  "taskify_nwc_wallet_catalog_v2",
  LS_WALLET_MODE,
  LS_WALLET_ENABLED,
  LS_WALLET_CLOSED,
];
const WALLET_IDB_KEYS = [
  "cashu_proofs_v1",
  "cashu_pending_tokens_v1",
  "cashu_pending_melts_v1",
  "cashu_locked_mint_quotes_v1",
  "cashuHistory",
];

/**
 * Whether this device has any wallet data (a seed, keys, proofs, history, NWC). Without any,
 * there is nothing to decrypt, check or back up, and no wallet code needs to load.
 */
export function hasWalletData(): boolean {
  try {
    if (WALLET_KV_KEYS.some((key) => kvStorage.getItem(key) !== null)) return true;
  } catch {
    return true;
  }
  try {
    return WALLET_IDB_KEYS.some((key) => {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, key);
      return raw !== null && raw !== "" && raw !== "[]" && raw !== "{}";
    });
  } catch {
    return true;
  }
}

function readFlag(key: string): boolean {
  try {
    return kvStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
let enabled = readFlag(LS_WALLET_ENABLED);
let closed = readFlag(LS_WALLET_CLOSED);

/** Shows the recovery view now, for testing it before the removal date. */
export const LS_WALLET_REMOVAL_PREVIEW = "taskify_wallet_removal_preview_v1";

function walletRemovedNow(): boolean {
  if (isWalletRemoved()) return true;
  try {
    return kvStorage.getItem(LS_WALLET_REMOVAL_PREVIEW) === "1";
  } catch {
    return false;
  }
}

/** Whether the full wallet is shown on this device (never after the removal date). */
export function isWalletEnabled(): boolean {
  return enabled && !walletRemovedNow();
}

/** After the removal date, a device that had the wallet shows how to recover what is left. */
export function isWalletRecoveryShown(): boolean {
  return enabled && walletRemovedNow();
}

export function isWalletClosed(): boolean {
  return closed;
}

/** Records the wallet as shown (`true`, sticky) or closed out (`false`). */
export function setWalletEnabled(next: boolean): void {
  if (enabled === next && closed === !next) return;
  // (Compares the stored flag, not isWalletEnabled(), which is false after the removal date.)
  enabled = next;
  closed = !next;
  try {
    if (next) {
      kvStorage.setItem(LS_WALLET_ENABLED, "1");
      kvStorage.removeItem(LS_WALLET_CLOSED);
    } else {
      kvStorage.removeItem(LS_WALLET_ENABLED);
      kvStorage.setItem(LS_WALLET_CLOSED, "1");
    }
  } catch {
    // in effect for this session
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWalletEnabled(): boolean {
  return useSyncExternalStore(subscribe, isWalletEnabled, isWalletEnabled);
}

export function useWalletRecoveryShown(): boolean {
  return useSyncExternalStore(subscribe, isWalletRecoveryShown, isWalletRecoveryShown);
}

/** Test-only: forget the in-memory flags and re-read storage. */
export function __resetWalletFlagsForTests(): void {
  enabled = readFlag(LS_WALLET_ENABLED);
  closed = readFlag(LS_WALLET_CLOSED);
  listeners.clear();
}
