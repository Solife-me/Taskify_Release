import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { useNwc } from "../../context/NwcContext";
import type { MintConnection } from "../../mint/MintSession";
import {
  PENDING_TOKENS_CHANGED_EVENT,
  addPendingToken,
  flushWalletStorage,
  listPendingTokens,
  loadStore,
  normalizeMintUrl,
  removePendingToken,
  type PendingTokenEntry,
} from "../../wallet/storage";
import { runSweep, summarizeSweepJournal, type SweepJournal, type SweepSource } from "../../wallet/nwcSweep";
import {
  amountToSat,
  kvSweepJournalStore,
  kvTokenSweepRecordStore,
  mintSweepSource,
  nwcSweepDestination,
  resolveOutstandingTokenSweeps,
  tokenSweepSource,
  type TokenSweepLedger,
} from "../../wallet/nwcSweepAdapters";
import { LS_NWC_TOKEN_SWEEP_JOURNAL } from "../../localStorageKeys";
import type { HistoryEntryInput, HistoryItem } from "../../wallet/walletHistoryTypes";

export type MintBalance = { mintUrl: string; sat: number };

export type StoredTokenState =
  | { status: "checking" }
  | { status: "ready"; spendableSat: number; spentSat: number }
  | { status: "error"; message: string };

type Options = {
  getMintConnection: (mintUrl: string) => Promise<MintConnection>;
  refreshTotalBalance: () => void;
  showToast: (message: string, durationMs?: number) => void;
  formatSatAmount: (amount: number) => string;
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  buildHistoryEntry: (entry: HistoryEntryInput) => HistoryItem;
  walletLabel: string;
  /** Run background upkeep (settling interrupted token sweeps). */
  active: boolean;
};

const migrationStore = kvSweepJournalStore();
const tokenJournalStore = kvSweepJournalStore(LS_NWC_TOKEN_SWEEP_JOURNAL);
const tokenRecords = kvTokenSweepRecordStore();

// One sweep at a time across every mounted consumer: two runs would race for the same proofs.
let sweepInProgress = false;

function proofSum(proofs: Proof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToSat((proof as any)?.amount), 0);
}

export function ecashBalancesByMint(): MintBalance[] {
  const store = loadStore();
  return Object.entries(store)
    .map(([mintUrl, proofs]) => ({ mintUrl, sat: proofSum(Array.isArray(proofs) ? proofs : []) }))
    .filter((entry) => entry.sat > 0)
    .sort((a, b) => b.sat - a.sat);
}

function tokenAmount(entry: PendingTokenEntry): number {
  return typeof entry.amount === "number" && Number.isFinite(entry.amount) ? entry.amount : 0;
}

export function useNwcSweeps({
  getMintConnection,
  refreshTotalBalance,
  showToast,
  formatSatAmount,
  setHistory,
  buildHistoryEntry,
  walletLabel,
  active,
}: Options) {
  const nwc = useNwc();
  const destination = useMemo(
    () => nwcSweepDestination({ makeInvoice: nwc.makeInvoice, lookupInvoice: nwc.lookupInvoice }),
    [nwc.lookupInvoice, nwc.makeInvoice],
  );
  const [busy, setBusy] = useState(false);

  const recordSweepHistory = useCallback(
    (journal: SweepJournal, what: string) => {
      const entries = journal.sources
        .filter((source) => source.sentSat > 0)
        .map((source) =>
          buildHistoryEntry({
            id: `nwc-sweep-${journal.runId}-${source.sourceId}`,
            summary: `Moved ${source.sentSat} sats ${what} to ${walletLabel}`,
            detail: source.attempts.filter((a) => a.state === "paid").map((a) => a.invoice).join("\n"),
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat: source.sentSat,
            feeSat: source.feesSat || undefined,
            mintUrl: source.sourceId.startsWith("token:") ? undefined : source.sourceId,
            stateLabel: "Paid",
          }),
        );
      if (entries.length) setHistory((h) => [...entries, ...h]);
    },
    [buildHistoryEntry, setHistory, walletLabel],
  );

  // --- Migration of the ecash wallet's balance ---------------------------------
  const [mintBalances, setMintBalances] = useState<MintBalance[]>(() => ecashBalancesByMint());
  const [migrationJournal, setMigrationJournal] = useState<SweepJournal | null>(() => migrationStore.load());
  const [migrationError, setMigrationError] = useState("");

  const refreshMintBalances = useCallback(() => {
    setMintBalances(ecashBalancesByMint());
    setMigrationJournal(migrationStore.load());
  }, []);

  const runMigration = useCallback(async (): Promise<SweepJournal | null> => {
    if (sweepInProgress) {
      setMigrationError("A transfer is already running");
      return null;
    }
    sweepInProgress = true;
    setBusy(true);
    setMigrationError("");
    try {
      const existing = migrationStore.load();
      const resume = existing && existing.status !== "completed" ? existing : null;
      const mintUrls = new Set(ecashBalancesByMint().map((entry) => normalizeMintUrl(entry.mintUrl)));
      // Mints an interrupted run still has to settle are included even if they now read 0.
      for (const source of resume?.sources ?? []) mintUrls.add(normalizeMintUrl(source.sourceId));
      const sources: SweepSource[] = [];
      for (const mintUrl of mintUrls) {
        const conn = await getMintConnection(mintUrl);
        sources.push(mintSweepSource(conn));
      }
      if (!sources.length) return null;
      const journal = await runSweep(sources, destination, migrationStore, {
        journal: resume,
        memo: "Taskify wallet migration",
        onUpdate: (next) => setMigrationJournal(JSON.parse(JSON.stringify(next))),
      });
      setMigrationJournal(JSON.parse(JSON.stringify(journal)));
      recordSweepHistory(journal, "from ecash");
      const { sentSat } = summarizeSweepJournal(journal);
      if (sentSat > 0) showToast(`moved ${formatSatAmount(sentSat)} to ${walletLabel}`, 4000);
      return journal;
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      sweepInProgress = false;
      setBusy(false);
      refreshTotalBalance();
      setMintBalances(ecashBalancesByMint());
      nwc.getBalanceMsat().catch(() => null);
    }
  }, [destination, formatSatAmount, getMintConnection, nwc, recordSweepHistory, refreshTotalBalance, showToast, walletLabel]);

  const clearMigrationJournal = useCallback(() => {
    migrationStore.clear();
    setMigrationJournal(null);
  }, []);

  // --- Stored (unredeemed) tokens ---------------------------------------------
  const [tokens, setTokens] = useState<PendingTokenEntry[]>(() => listPendingTokens());
  const [tokenStates, setTokenStates] = useState<Record<string, StoredTokenState>>({});
  const [tokenError, setTokenError] = useState("");
  const checkGeneration = useRef(0);

  const ledger = useMemo<TokenSweepLedger>(
    () => ({
      async addChangeToken(mintUrl, token, amountSat) {
        addPendingToken(mintUrl, token, amountSat);
        await flushWalletStorage();
      },
      async removeToken(id) {
        removePendingToken(id);
        await flushWalletStorage();
      },
    }),
    [],
  );

  const refreshTokens = useCallback(() => {
    const list = listPendingTokens();
    setTokens(list);
    return list;
  }, []);

  useEffect(() => {
    const handler = () => refreshTokens();
    window.addEventListener(PENDING_TOKENS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PENDING_TOKENS_CHANGED_EVENT, handler);
  }, [refreshTokens]);

  const checkTokenStates = useCallback(async () => {
    const list = refreshTokens();
    const generation = ++checkGeneration.current;
    setTokenStates(Object.fromEntries(list.map((entry) => [entry.id, { status: "checking" } as StoredTokenState])));
    await Promise.all(
      list.map(async (entry) => {
        let state: StoredTokenState;
        try {
          const conn = await getMintConnection(entry.mint);
          const decoded = await conn.decodeTokenWithKeysets(entry.token);
          const proofs = (decoded.proofs ?? []) as Proof[];
          const states = proofs.length ? await conn.checkProofStates(proofs) : [];
          const spendable = proofs.filter((_, i) => String(states[i]?.state ?? "").toUpperCase() === "UNSPENT");
          state = { status: "ready", spendableSat: proofSum(spendable), spentSat: proofSum(proofs) - proofSum(spendable) };
        } catch (error) {
          state = { status: "error", message: error instanceof Error ? error.message : String(error) };
        }
        if (generation === checkGeneration.current) {
          setTokenStates((prev) => ({ ...prev, [entry.id]: state }));
        }
      }),
    );
  }, [getMintConnection, refreshTokens]);

  const sweepTokens = useCallback(
    async (ids: string[]): Promise<SweepJournal | null> => {
      if (sweepInProgress) {
        setTokenError("A transfer is already running");
        return null;
      }
      const chosen = listPendingTokens().filter((entry) => ids.includes(entry.id));
      if (!chosen.length) return null;
      sweepInProgress = true;
      setBusy(true);
      setTokenError("");
      try {
        const sources: SweepSource[] = [];
        for (const entry of chosen) {
          const conn = await getMintConnection(entry.mint);
          sources.push(
            tokenSweepSource(entry, conn, ledger, tokenRecords, `${formatSatAmount(tokenAmount(entry))} token`),
          );
        }
        const journal = await runSweep(sources, destination, tokenJournalStore, {
          memo: "Taskify ecash token",
        });
        recordSweepHistory(journal, "from ecash tokens");
        const summary = summarizeSweepJournal(journal);
        if (summary.sentSat > 0) showToast(`moved ${formatSatAmount(summary.sentSat)} to ${walletLabel}`, 4000);
        const failed = journal.sources.filter((source) => source.status === "failed");
        if (failed.length) setTokenError(failed.map((source) => source.error).filter(Boolean).join("; "));
        const waiting = journal.sources.filter((source) => source.status === "awaiting_settlement");
        if (waiting.length) {
          setTokenError((prev) =>
            [prev, "A payment is still in progress; the token will update once the mint settles it."].filter(Boolean).join(" "),
          );
        }
        return journal;
      } catch (error) {
        setTokenError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        sweepInProgress = false;
        setBusy(false);
        refreshTokens();
        refreshTotalBalance();
        nwc.getBalanceMsat().catch(() => null);
        void checkTokenStates();
      }
    },
    [checkTokenStates, destination, formatSatAmount, getMintConnection, ledger, nwc, recordSweepHistory, refreshTokens, refreshTotalBalance, showToast, walletLabel],
  );

  const deleteToken = useCallback(
    async (id: string) => {
      removePendingToken(id);
      await flushWalletStorage();
      refreshTokens();
      refreshTotalBalance();
    },
    [refreshTokens, refreshTotalBalance],
  );

  // Settle token sweeps a previous session left in flight.
  useEffect(() => {
    if (!active || !tokenRecords.list().length || sweepInProgress) return;
    sweepInProgress = true;
    void resolveOutstandingTokenSweeps(tokenRecords, getMintConnection, ledger)
      .catch(() => null)
      .finally(() => {
        sweepInProgress = false;
        refreshTokens();
        refreshTotalBalance();
      });
  }, [active, getMintConnection, ledger, refreshTokens, refreshTotalBalance]);

  const storedTokenSat = useMemo(() => tokens.reduce((sum, entry) => sum + tokenAmount(entry), 0), [tokens]);

  return {
    busy,
    // migration
    mintBalances,
    refreshMintBalances,
    migrationJournal,
    migrationError,
    runMigration,
    clearMigrationJournal,
    // stored tokens
    tokens,
    storedTokenSat,
    tokenStates,
    tokenError,
    refreshTokens,
    checkTokenStates,
    sweepTokens,
    deleteToken,
  };
}
