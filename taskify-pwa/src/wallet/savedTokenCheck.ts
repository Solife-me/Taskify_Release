/**
 * Saved tokens (ecash kept to redeem later) that can never be redeemed: their notes were spent
 * in another wallet. Asks each token's mint whether its notes are spent (NUT-07), reading the
 * notes without needing the mint's keyset list, so a token the redeemer could not decode is
 * still checked. A token whose notes are all spent is removed, with a copy kept in History.
 * Nothing is removed while the mint cannot be reached.
 */
import type { Proof, ProofState } from "@cashu/cashu-ts";
import type { WalletHistoryLogEntry } from "../domains/backup/backupTypes";
import type { PendingTokenEntry } from "./storage";

export type SavedTokenStatus = "spent" | "redeemable" | "unknown";

export type SavedTokenCheckDeps = {
  /** The token's mint and notes, or null when it cannot be read. */
  decode: (token: string) => { mint: string | undefined; proofs: Proof[] } | null;
  checkStates: (mintUrl: string, proofs: Proof[]) => Promise<Pick<ProofState, "state">[]>;
};

async function statusOf(entry: PendingTokenEntry, deps: SavedTokenCheckDeps): Promise<SavedTokenStatus> {
  let decoded: ReturnType<SavedTokenCheckDeps["decode"]>;
  try {
    decoded = deps.decode(entry.token);
  } catch {
    return "unknown";
  }
  const proofs = (decoded?.proofs ?? []).filter((proof) => typeof proof?.secret === "string" && proof.secret);
  const mint = decoded?.mint || entry.mint;
  if (!proofs.length || !mint) return "unknown";
  try {
    const states = await deps.checkStates(mint, proofs);
    if (states.length !== proofs.length) return "unknown";
    return states.every((state) => String(state?.state ?? "").toUpperCase() === "SPENT") ? "spent" : "redeemable";
  } catch {
    return "unknown";
  }
}

export async function checkSavedTokens(
  entries: PendingTokenEntry[],
  deps: SavedTokenCheckDeps,
): Promise<Record<string, SavedTokenStatus>> {
  const result: Record<string, SavedTokenStatus> = {};
  for (const entry of entries) result[entry.id] = await statusOf(entry, deps);
  return result;
}

/** Removes saved tokens already claimed elsewhere; resolves to the ones left, with their status. */
export async function settleSavedTokens(
  deps: SavedTokenCheckDeps & {
    list: () => PendingTokenEntry[];
    remove: (id: string) => void;
    recordHistory: (item: WalletHistoryLogEntry) => void;
  },
): Promise<Array<{ entry: PendingTokenEntry; status: SavedTokenStatus }>> {
  const entries = deps.list();
  const statuses = await checkSavedTokens(entries, deps);
  const remaining: Array<{ entry: PendingTokenEntry; status: SavedTokenStatus }> = [];
  for (const entry of entries) {
    const status = statuses[entry.id];
    if (status !== "spent") {
      remaining.push({ entry, status });
      continue;
    }
    deps.recordHistory(savedTokenHistoryEntry(entry, "Saved token already claimed elsewhere"));
    deps.remove(entry.id);
  }
  return remaining;
}

/** A History entry keeping a copy of a saved token the wallet stops tracking. */
export function savedTokenHistoryEntry(entry: PendingTokenEntry, summary: string): WalletHistoryLogEntry {
  const amount = typeof entry.amount === "number" && entry.amount > 0 ? entry.amount : 0;
  return {
    id: `saved-token-${entry.id}-${Date.now()}`,
    summary: amount ? `${summary} • ${amount} sats` : summary,
    detail: entry.token,
    detailKind: "token",
    type: "ecash",
    direction: "in",
    amountSat: amount || undefined,
    mintUrl: entry.mint,
  };
}
