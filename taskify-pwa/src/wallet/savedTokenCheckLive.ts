/**
 * The saved-token check (`savedTokenCheck.ts`) wired to the real mints and storage. Wallet code:
 * it reaches mints through `MintSession`.
 */
import { appendWalletHistoryEntry } from "../domains/backup/backupUtils";
import { MintSession } from "../mint/MintSession";
import { getCashuTokenMetadata } from "./cashuTokenMetadata";
import { savedTokenHistoryEntry, settleSavedTokens, type SavedTokenCheckDeps } from "./savedTokenCheck";
import { listPendingTokens, normalizeMintUrl, removePendingToken, type PendingTokenEntry } from "./storage";

export const liveSavedTokenDeps: SavedTokenCheckDeps = {
  // Reads notes without the mint's keyset list, so tokens the redeemer could not decode are checked too.
  decode: (token) => {
    const metadata = getCashuTokenMetadata(token);
    return { mint: metadata.mint, proofs: metadata.incompleteProofs };
  },
  checkStates: (mintUrl, proofs) => MintSession.checkTokenStates(normalizeMintUrl(mintUrl), proofs),
};

/** Removes saved tokens already claimed elsewhere; resolves to the ones left. */
export function settleSavedTokensNow() {
  return settleSavedTokens({
    ...liveSavedTokenDeps,
    list: listPendingTokens,
    remove: removePendingToken,
    recordHistory: (item) => appendWalletHistoryEntry(item),
  });
}

/** The user gives up on a saved token they know is gone; a copy stays in History. */
export function removeSavedTokenKeepingCopy(entry: PendingTokenEntry): void {
  appendWalletHistoryEntry(savedTokenHistoryEntry(entry, "Saved token removed"));
  removePendingToken(entry.id);
}
