// @ts-nocheck
import React, { useMemo } from "react";
import { normalizeMintUrl, deriveTimestampFromId } from "../../wallet/cashuProofHelpers";
import {
  MINT_QUOTE_SUBSCRIPTION_WINDOW_MS,
  TOKEN_STATE_BACKGROUND_WINDOW_MS,
} from "../../wallet/walletModalHelpers";

export interface UseHistoryFilterOptions {
  history: any[];
  mintUrl: string;
  isHistoryEntryPending: (entry: any) => boolean;
  historyFilter: string;
  setHistoryFilter: (v: string) => void;
  setExpandedHistoryId: (v: string | null) => void;
}

export function useHistoryFilter({
  history,
  mintUrl,
  isHistoryEntryPending,
  historyFilter,
  setHistoryFilter,
  setExpandedHistoryId,
}: UseHistoryFilterOptions) {
  const tokenizedHistoryItems = useMemo(
    () => history.filter((entry) => entry.tokenState && entry.tokenState.proofs.length),
    [history],
  );
  const pendingTokenStateItems = useMemo(() => {
    const now = Date.now();
    const earliestAllowed = now - TOKEN_STATE_BACKGROUND_WINDOW_MS;
    return tokenizedHistoryItems.filter((entry) => {
      const tokenState = entry.tokenState;
      if (!tokenState) return false;
      if (tokenState.lastState === "SPENT") return false;
      if (tokenState.suppressChecks === true) return false;
      if (typeof entry.summary === "string" && entry.summary.includes("(spent)")) return false;
      const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : null;
      const lastCheckedAt = typeof tokenState.lastCheckedAt === "number" ? tokenState.lastCheckedAt : null;
      const lastActivity = Math.max(createdAt ?? 0, lastCheckedAt ?? 0);
      if (lastActivity <= 0) return false;
      return lastActivity >= earliestAllowed;
    });
  }, [tokenizedHistoryItems]);
  const pendingMintQuoteHistoryItems = useMemo(() => {
    const normalizedActive = mintUrl ? normalizeMintUrl(mintUrl) : null;
    const now = Date.now();
    const earliestAllowed = now - MINT_QUOTE_SUBSCRIPTION_WINDOW_MS;
    return history.filter((entry) => {
      const mintQuote = entry.mintQuote;
      if (!mintQuote) return false;
      const quoteId = mintQuote.quote?.trim();
      if (!quoteId) return false;
      if (mintQuote.suppressChecks) return false;
      const createdAt =
        typeof mintQuote.createdAt === "number"
          ? mintQuote.createdAt
          : typeof entry.createdAt === "number"
            ? entry.createdAt
            : deriveTimestampFromId(entry.id);
      if (createdAt && Number.isFinite(createdAt) && createdAt < earliestAllowed) return false;
      if (mintQuote.expiresAt && mintQuote.expiresAt <= now) return false;
      const targetMint = mintQuote.mintUrl ? normalizeMintUrl(mintQuote.mintUrl) : normalizedActive;
      if (!targetMint) return false;
      return true;
    });
  }, [history, mintUrl]);
  const pendingHistoryItems = useMemo(
    () => history.filter((entry) => isHistoryEntryPending(entry)),
    [history, isHistoryEntryPending],
  );
  const bountyHistoryItems = useMemo(
    () => history.filter((entry) => entry.entryKind === "bounty-attachment"),
    [history],
  );
  const filteredHistory = useMemo(() => {
    if (historyFilter === "pending") {
      return pendingHistoryItems;
    }
    if (historyFilter === "bounty") {
      return bountyHistoryItems;
    }
    return history;
  }, [history, historyFilter, pendingHistoryItems, bountyHistoryItems]);
  const hasExpiringMintQuotes = useMemo(
    () => history.some((entry) => entry.mintQuote?.expiresAt),
    [history],
  );
  const historyFilterControls = useMemo(() => {
    if (!history.length) return null;
    return (
      <div className="history-filter" role="group" aria-label="Filter history">
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("all");
            setExpandedHistoryId(null);
          }}
          aria-pressed={historyFilter === "all"}
        >
          All
        </button>
        <span className="history-filter__divider" aria-hidden="true">
          •
        </span>
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("bounty");
            setExpandedHistoryId(null);
          }}
          disabled={!bountyHistoryItems.length}
          aria-pressed={historyFilter === "bounty"}
        >
          Bounties
          {bountyHistoryItems.length ? (
            <span className="history-filter__badge">{bountyHistoryItems.length}</span>
          ) : null}
        </button>
        <span className="history-filter__divider" aria-hidden="true">
          •
        </span>
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("pending");
            setExpandedHistoryId(null);
          }}
          disabled={!pendingHistoryItems.length}
          aria-pressed={historyFilter === "pending"}
        >
          Pending
          <span className="history-filter__badge">{pendingHistoryItems.length}</span>
        </button>
      </div>
    );
  }, [history.length, historyFilter, pendingHistoryItems.length, bountyHistoryItems.length]);

  return {
    tokenizedHistoryItems,
    pendingTokenStateItems,
    pendingMintQuoteHistoryItems,
    pendingHistoryItems,
    bountyHistoryItems,
    filteredHistory,
    hasExpiringMintQuotes,
    historyFilterControls,
  };
}
