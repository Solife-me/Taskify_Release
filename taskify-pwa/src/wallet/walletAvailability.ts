import { kvStorage } from "../storage/kvStorage";
import { __resetWalletFlagsForTests, isWalletClosed, isWalletEnabled, setWalletEnabled } from "./walletFlags";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../storage/taskifyDb";
import {
  LS_NWC_SWEEP_JOURNAL,
  LS_NWC_TOKEN_SWEEP_JOURNAL,
  LS_WALLET_MODE,
} from "../localStorageKeys";
import { amountToNumber, listPendingMelts, listPendingTokens, loadStore } from "./storage";
import { loadStoredNwcWalletCatalog } from "./nwcWalletCatalog";
import type { SweepJournal } from "./nwcSweep";

/**
 * The Taskify wallet is being phased out. Installs that never used it get no wallet UI
 * (wallet tab, wallet settings, pay-contact buttons, bounties). Installs with any wallet
 * activity keep it so their funds stay reachable.
 *
 * Once enabled, the wallet stays enabled on this device. While disabled, activity is
 * re-checked on every launch and whenever `refreshWalletAvailability` runs, so funds that
 * arrive later (a restored backup, a claimed payment request) always bring the wallet back.
 * Seed presence is not activity: the seed is generated the first time any wallet code runs.
 *
 * Once every balance has been moved out, the user can close the wallet out, which returns the
 * device to the fresh no-wallet state. Nothing is deleted (the seed, proofs and history stay for
 * recovery). A closed wallet comes back only if funds reappear, not for past activity.
 */


function nonEmptyJsonCollection(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length > 0;
  } catch {
    // unreadable data is not activity
  }
  return false;
}

/**
 * Whether this device has ever held or moved funds with the Taskify wallet or connected an
 * NWC wallet. Reads synchronously from storage preloaded by `storageBootstrap`.
 */
export function hasWalletActivity(): boolean {
  try {
    if (Object.values(loadStore()).some((proofs) => Array.isArray(proofs) && proofs.length > 0)) return true;
  } catch {
    // keep checking other signals
  }
  try {
    if (listPendingTokens().length > 0) return true;
  } catch {
    // keep checking other signals
  }
  try {
    if (listPendingMelts().length > 0) return true;
  } catch {
    // keep checking other signals
  }
  if (nonEmptyJsonCollection(idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashu_locked_mint_quotes_v1"))) return true;
  if (nonEmptyJsonCollection(idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory"))) return true;
  try {
    if (kvStorage.getItem(LS_WALLET_MODE) === "nwc") return true;
  } catch {
    // keep checking other signals
  }
  try {
    if (loadStoredNwcWalletCatalog().wallets.length > 0) return true;
  } catch {
    // no NWC wallets
  }
  return false;
}


function proofBalanceSat(): number {
  try {
    return Object.values(loadStore()).reduce(
      (total, proofs) =>
        total + (Array.isArray(proofs) ? proofs.reduce((sum, proof) => sum + amountToNumber(proof?.amount), 0) : 0),
      0,
    );
  } catch {
    return 0;
  }
}

function sweepStillSettling(key: string): boolean {
  try {
    const raw = kvStorage.getItem(key);
    if (!raw) return false;
    const journal = JSON.parse(raw) as SweepJournal;
    if (!journal || !Array.isArray(journal.sources)) return false;
    return (
      journal.status === "running" ||
      journal.sources.some((source) => source.status === "in_progress" || source.status === "awaiting_settlement")
    );
  } catch {
    return false;
  }
}

function sentTokenSatAwaitingClaim(): number {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
    const history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(history)) return 0;
    return history.reduce((total, entry) => {
      const tokenState = entry?.tokenState;
      if (!tokenState || !Array.isArray(tokenState.proofs) || !tokenState.proofs.length) return total;
      if (tokenState.lastState === "SPENT") return total;
      return total + (typeof entry.amountSat === "number" && entry.amountSat > 0 ? entry.amountSat : 0);
    }, 0);
  } catch {
    return 0;
  }
}

export type WalletCloseOutCheck = {
  /** What still holds funds. The wallet can't be closed out until each one is moved. */
  blockers: string[];
  /** Sats in sent tokens nobody has redeemed yet. Closing out keeps them recoverable by seed. */
  unclaimedSentSat: number;
};

/** What stands between this device and closing out the wallet. */
export function checkWalletCloseOut(): WalletCloseOutCheck {
  const blockers: string[] = [];
  const balance = proofBalanceSat();
  if (balance > 0) blockers.push(`${balance.toLocaleString()} sats are still in the wallet`);
  let savedTokens = 0;
  try {
    savedTokens = listPendingTokens().length;
  } catch {
    savedTokens = 0;
  }
  if (savedTokens > 0) {
    blockers.push(`${savedTokens} saved ecash ${savedTokens === 1 ? "token is" : "tokens are"} waiting to be redeemed or moved`);
  }
  let pendingMelts = 0;
  try {
    pendingMelts = listPendingMelts().length;
  } catch {
    pendingMelts = 0;
  }
  if (pendingMelts > 0) blockers.push("A Lightning payment is still settling");
  if (sweepStillSettling(LS_NWC_SWEEP_JOURNAL) || sweepStillSettling(LS_NWC_TOKEN_SWEEP_JOURNAL)) {
    blockers.push("A transfer to your NWC wallet is still settling");
  }
  return { blockers, unclaimedSentSat: sentTokenSatAwaitingClaim() };
}

/** Whether the wallet holds or is still moving funds; this alone brings a closed wallet back. */
export function hasWalletFunds(): boolean {
  return checkWalletCloseOut().blockers.length > 0;
}

/**
 * Re-checks the device and enables the wallet for good if it finds wallet activity (or, for a
 * closed-out wallet, funds).
 */
export function refreshWalletAvailability(): boolean {
  if (isWalletEnabled()) return true;
  if (!(isWalletClosed() ? hasWalletFunds() : hasWalletActivity())) return false;
  setWalletEnabled(true);
  return true;
}

/**
 * Hides the wallet on this device, as on a fresh install. Refuses while anything still holds
 * funds. Wallet data is kept so the seed can still recover anything left behind.
 */
export function closeOutWallet(): void {
  const { blockers } = checkWalletCloseOut();
  if (blockers.length) throw new Error(blockers.join(". "));
  setWalletEnabled(false);
}

export { isWalletEnabled, useWalletEnabled } from "./walletFlags";

/** Test-only: forget the in-memory decision and re-read storage. */
export function __resetWalletAvailabilityForTests(): void {
  __resetWalletFlagsForTests();
}
