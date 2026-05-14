import { useCallback, useEffect, useState } from "react";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import {
  markHistoryEntrySpentRaw,
  MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT,
  type MarkHistoryEntriesOldSpentEventDetail,
} from "../../lib/walletHistory";
import { deriveTimestampFromId } from "../../wallet/cashuProofHelpers";
import {
  parseStoredHistory,
  type HistoryEntryInput,
  type HistoryFilter,
  type HistoryItem,
  type HistoryStatusMap,
} from "../../wallet/walletHistoryTypes";

type ShowToast = (message: string, durationMs?: number) => void;
type CaptureFiat = (amountSat: number | undefined) => number | undefined;

export interface UseWalletHistoryOptions {
  showToast: ShowToast;
  captureFiatValueUsd: CaptureFiat;
}

export function useWalletHistory({ showToast, captureFiatValueUsd }: UseWalletHistoryOptions) {
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
      if (!saved) return [];
      const parsed: unknown = JSON.parse(saved);
      return parseStoredHistory(parsed);
    } catch {
      return [];
    }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyRevertState, setHistoryRevertState] = useState<HistoryStatusMap>({});
  const [historyCheckStates, setHistoryCheckStates] = useState<HistoryStatusMap>({});
  const [historyMintQuoteStates, setHistoryMintQuoteStates] = useState<HistoryStatusMap>({});
  const [historyRedeemStates, setHistoryRedeemStates] = useState<HistoryStatusMap>({});

  useEffect(() => {
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(history));
  }, [history]);

  const buildHistoryEntry = useCallback(
    (entry: HistoryEntryInput): HistoryItem => {
      const amountSat =
        typeof entry.amountSat === "number" && Number.isFinite(entry.amountSat)
          ? entry.amountSat
          : undefined;
      const feeSat =
        typeof entry.feeSat === "number" && Number.isFinite(entry.feeSat) ? entry.feeSat : undefined;
      const createdAt =
        typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt > 0
          ? entry.createdAt
          : Date.now();
      const fiatSnapshot =
        entry.fiatValueUsd != null ? entry.fiatValueUsd : captureFiatValueUsd(amountSat);
      const normalized: HistoryItem = {
        ...entry,
        id: entry.id && entry.id.trim() ? entry.id : `${entry.type || "entry"}-${createdAt}`,
        amountSat,
        feeSat,
        createdAt,
        fiatValueUsd: typeof fiatSnapshot === "number" ? fiatSnapshot : undefined,
      };
      if (entry.mintQuote) {
        normalized.mintQuote = { ...entry.mintQuote };
      }
      if (entry.tokenState) {
        normalized.tokenState = {
          ...entry.tokenState,
          proofs: [...entry.tokenState.proofs],
        };
      }
      return normalized;
    },
    [captureFiatValueUsd],
  );

  const removeHistoryEntryStates = useCallback(
    (entryId: string) => {
      setHistoryCheckStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryMintQuoteStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryRedeemStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryRevertState((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
    },
    [setHistoryCheckStates, setHistoryMintQuoteStates, setHistoryRedeemStates, setHistoryRevertState],
  );

  const markHistoryEntryAsSpent = useCallback(
    (entry: HistoryItem, timestamp: number): HistoryItem => {
      const updated = markHistoryEntrySpentRaw(entry, timestamp);
      return (updated as HistoryItem) ?? entry;
    },
    [],
  );

  const markHistoryEntriesOlderThan = useCallback(
    (cutoffMs: number, options?: { suppressToast?: boolean }) => {
      const normalizedCutoff = Math.max(0, cutoffMs);
      const now = Date.now();
      const threshold = now - normalizedCutoff;
      const updatedIds: string[] = [];
      setHistory((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (!entry.tokenState) return entry;
          const createdAt =
            typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
              ? entry.createdAt
              : deriveTimestampFromId(entry.id);
          if (createdAt > threshold) return entry;
          const alreadySpent =
            entry.tokenState.lastState === "SPENT" || entry.summary.includes("(spent)");
          if (alreadySpent) return entry;
          const updatedEntry = markHistoryEntryAsSpent(entry, now);
          if (updatedEntry === entry) return entry;
          changed = true;
          updatedIds.push(entry.id);
          return updatedEntry;
        });
        return changed ? next : prev;
      });
      if (!updatedIds.length) {
        return 0;
      }
      setHistoryCheckStates((prev) => {
        const next = { ...prev };
        for (const id of updatedIds) {
          next[id] = { status: "success", message: "Token marked spent" };
        }
        return next;
      });
      if (!options?.suppressToast) {
        showToast(
          `Marked ${updatedIds.length} history entr${updatedIds.length === 1 ? "y" : "ies"} as spent`,
          3500,
        );
      }
      return updatedIds.length;
    },
    [markHistoryEntryAsSpent, setHistory, setHistoryCheckStates, showToast],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<MarkHistoryEntriesOldSpentEventDetail>;
      const cutoffMs =
        customEvent?.detail && typeof customEvent.detail.cutoffMs === "number"
          ? customEvent.detail.cutoffMs
          : 0;
      markHistoryEntriesOlderThan(cutoffMs, { suppressToast: true });
    };
    window.addEventListener(MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT, handler);
    return () => {
      window.removeEventListener(MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT, handler);
    };
  }, [markHistoryEntriesOlderThan]);

  const handleMarkHistoryTokenSpent = useCallback(
    (item: HistoryItem) => {
      if (!item.tokenState) return;
      const timestamp = Date.now();
      setHistory((prev) =>
        prev.map((entry) => (entry.id === item.id ? markHistoryEntryAsSpent(entry, timestamp) : entry)),
      );
      setHistoryCheckStates((prev) => ({
        ...prev,
        [item.id]: { status: "success", message: "Token marked spent" },
      }));
      showToast("Token marked spent", 3000);
    },
    [markHistoryEntryAsSpent, setHistory, setHistoryCheckStates, showToast],
  );

  const handleDeleteHistoryEntry = useCallback(
    (item: HistoryItem) => {
      setHistory((prev) => prev.filter((entry) => entry.id !== item.id));
      removeHistoryEntryStates(item.id);
      setExpandedHistoryId((prev) => (prev === item.id ? null : prev));
      showToast("History entry deleted", 2000);
    },
    [removeHistoryEntryStates, setHistory, setExpandedHistoryId, showToast],
  );

  return {
    history,
    setHistory,
    showHistory,
    setShowHistory,
    historyFilter,
    setHistoryFilter,
    expandedHistoryId,
    setExpandedHistoryId,
    historyRevertState,
    setHistoryRevertState,
    historyCheckStates,
    setHistoryCheckStates,
    historyMintQuoteStates,
    setHistoryMintQuoteStates,
    historyRedeemStates,
    setHistoryRedeemStates,
    buildHistoryEntry,
    removeHistoryEntryStates,
    markHistoryEntryAsSpent,
    markHistoryEntriesOlderThan,
    handleMarkHistoryTokenSpent,
    handleDeleteHistoryEntry,
  };
}
