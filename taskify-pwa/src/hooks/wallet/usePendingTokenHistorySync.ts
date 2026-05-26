import { useEffect, type Dispatch, type SetStateAction } from "react";
import { listPendingTokens, type PendingTokenEntry } from "../../wallet/storage";
import {
  deriveSpentHistoryTokenStateFromToken,
  markHistoryTokenStateSpent,
  type HistoryItem,
} from "../../wallet/walletHistoryTypes";

type PendingTokenHistorySyncOptions = {
  open: boolean;
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  intervalMs?: number;
};

export function usePendingTokenHistorySync({
  open,
  setHistory,
  intervalMs = 8000,
}: PendingTokenHistorySyncOptions) {
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const syncPending = () => {
      if (cancelled) return;
      const now = Date.now();
      let entries: PendingTokenEntry[] = [];
      try {
        entries = listPendingTokens();
      } catch {
        entries = [];
      }
      const pendingIds = new Set(entries.map((entry) => entry.id));
      setHistory((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          if (item.pendingTokenId && !pendingIds.has(item.pendingTokenId) && item.pendingStatus !== "redeemed") {
            changed = true;
            const amount = item.pendingTokenAmount;
            const amountNote = amount ? `${amount} sat${amount === 1 ? "" : "s"}` : "Token";
            const tokenState = item.tokenState
              ? markHistoryTokenStateSpent(item.tokenState, now)
              : typeof item.detail === "string"
                ? deriveSpentHistoryTokenStateFromToken(item.detail, now)
                : undefined;
              return {
                ...item,
                pendingTokenId: undefined,
                pendingStatus: "redeemed" as const,
                ...(tokenState ? { tokenState } : {}),
                summary: item.summary.includes("saved for later redemption")
                ? `${amountNote} redeemed automatically`
                : item.summary,
            };
          }
          return item;
        });
        return changed ? next : prev;
      });
    };
    syncPending();
    const interval = window.setInterval(syncPending, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, setHistory, intervalMs]);
}
