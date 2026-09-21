import { useSyncExternalStore } from "react";
import { kvStorage } from "../storage/kvStorage";
import { LS_WALLET_MODE } from "../localStorageKeys";

/**
 * Which wallet the app sends and receives with.
 * - "ecash": the built-in Cashu wallet (default).
 * - "nwc": an external lightning wallet over Nostr Wallet Connect. The ecash wallet's
 *   seed and proofs are kept, and incoming ecash is stored unredeemed instead of
 *   being claimed into it.
 */
export type WalletMode = "ecash" | "nwc";

const listeners = new Set<() => void>();

function readMode(): WalletMode {
  try {
    return kvStorage.getItem(LS_WALLET_MODE) === "nwc" ? "nwc" : "ecash";
  } catch {
    return "ecash";
  }
}

let current: WalletMode = readMode();

export function getWalletMode(): WalletMode {
  return current;
}

export function isNwcWalletMode(): boolean {
  return current === "nwc";
}

export function setWalletMode(mode: WalletMode) {
  if (mode === current) return;
  current = mode;
  try {
    if (mode === "nwc") kvStorage.setItem(LS_WALLET_MODE, "nwc");
    else kvStorage.removeItem(LS_WALLET_MODE);
  } catch {
    // mode still applies for this session
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWalletMode(): WalletMode {
  return useSyncExternalStore(subscribe, getWalletMode, getWalletMode);
}
