// @ts-nocheck
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { finalizeEvent } from "nostr-tools";
import { kvStorage } from "../../storage/kvStorage";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import {
  loadStore as loadProofStore,
  saveStore as saveProofStore,
  getMintList,
  replaceMintList,
} from "../../wallet/storage";
import {
  getWalletSeedMnemonic,
  getWalletSeedBackupJson,
  getWalletCountersByMint,
  incrementWalletCounter,
  regenerateWalletSeed,
} from "../../wallet/seed";
import {
  createMintBackupTemplate,
  decryptMintBackupPayload,
  deriveMintBackupKeys,
  loadMintBackupCache,
  MINT_BACKUP_CLIENT_TAG,
  MINT_BACKUP_D_TAG,
  MINT_BACKUP_KIND,
  persistMintBackupCache,
  type MintBackupPayload,
} from "../../wallet/mintBackup";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import {
  markHistoryEntrySpentRaw,
  MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT,
  type HistoryEntryRaw,
} from "../../lib/walletHistory";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { SessionPool } from "../../nostr/SessionPool";
import { useCashu } from "../../context/CashuContext";
import { useP2PK, type P2PKKey } from "../../context/P2PKContext";
import { useToast } from "../../context/ToastContext";
import {
  pillButtonClass,
  hexToBytes,
  DEBUG_CONSOLE_STORAGE_KEY,
  VOICE_TEST_INPUT_STORAGE_KEY,
  HISTORY_MARK_SPENT_CUTOFF_MS,
} from "./settingsConstants";

export function WalletSection({
  settings,
  setSettings,
  defaultRelays,
  onReloadNeeded,
  onResetWalletTokenTracking,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  defaultRelays: string[];
  onReloadNeeded: () => void;
  onResetWalletTokenTracking: () => void;
}) {
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice, checkProofStates } = useCashu();
  const {
    keys: p2pkKeys,
    primaryKey: primaryP2pkKey,
    generateKeypair: generateP2pkKeypair,
    importFromNsec: importP2pkFromNsec,
    removeKey: removeP2pkKey,
    setPrimaryKey: setPrimaryP2pkKey,
  } = useP2PK();

  const [walletExpanded, setWalletExpanded] = useState(false);
  const [walletSeedVisible, setWalletSeedVisible] = useState(false);
  const [walletSeedWords, setWalletSeedWords] = useState<string | null>(null);
  const [walletSeedError, setWalletSeedError] = useState<string | null>(null);
  const [mintBackupState, setMintBackupState] = useState<
    "idle" | "syncing" | "success" | "error" | "restoring"
  >("idle");
  const [mintBackupMessage, setMintBackupMessage] = useState("");
  const [mintBackupCache, setMintBackupCache] = useState<MintBackupPayload | null>(() => loadMintBackupCache());
  const [walletCounters, setWalletCounters] = useState<Record<string, Record<string, number>>>(() => getWalletCountersByMint());
  const [walletAdvancedVisible, setWalletAdvancedVisible] = useState(false);
  const [showNewSeedConfirm, setShowNewSeedConfirm] = useState(false);
  const [removeSpentBusy, setRemoveSpentBusy] = useState(false);
  const [removeSpentStatus, setRemoveSpentStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [debugConsoleState, setDebugConsoleState] = useState<"inactive" | "loading" | "active">("inactive");
  const [debugConsoleMessage, setDebugConsoleMessage] = useState<string | null>(null);
  const [voiceTestInputEnabled, setVoiceTestInputEnabled] = useState<boolean>(
    () => kvStorage.getItem(VOICE_TEST_INPUT_STORAGE_KEY) === "true",
  );
  const debugConsoleScriptRef = useRef<HTMLScriptElement | null>(null);
  const mintBackupPoolRef = useRef<SessionPool | null>(null);
  const [keysetCounterBusy, setKeysetCounterBusy] = useState<string | null>(null);
  const [p2pkImportVisible, setP2pkImportVisible] = useState(false);
  const [p2pkImportValue, setP2pkImportValue] = useState("");
  const [p2pkImportLabel, setP2pkImportLabel] = useState("");
  const [p2pkImportError, setP2pkImportError] = useState("");
  const [p2pkKeysExpanded, setP2pkKeysExpanded] = useState(false);

  const isReplaceableRejection = useCallback((err: unknown): boolean => {
    const msg = typeof (err as any)?.message === "string" ? (err as any).message : "";
    return /have newer event/i.test(msg) || /already exists/i.test(msg) || /duplicate/i.test(msg);
  }, []);

  const safePublish = useCallback(
    async (pool: SessionPool, relays: string[], event: any) => {
      const result = pool.publish(relays, event);
      try {
        await Promise.resolve(result);
      } catch (err) {
        if (!isReplaceableRejection(err)) {
          throw err;
        }
      }
    },
    [isReplaceableRejection],
  );

  const walletCounterEntries = useMemo(
    () => Object.entries(walletCounters).sort(([a], [b]) => a.localeCompare(b)),
    [walletCounters],
  );
  const walletCounterDisplayEntries = useMemo(
    () => walletCounterEntries.filter(([, counters]) => Object.keys(counters).length > 0),
    [walletCounterEntries],
  );

  const normalizeMint = useCallback((url: string) => (url || "").trim().replace(/\/+$/, ""), []);
  const shortMintLabel = useCallback((url: string) => {
    if (!url) return "";
    try {
      const target = url.includes("://") ? url : `https://${url}`;
      const parsed = new URL(target);
      return parsed.host || url;
    } catch {
      return url;
    }
  }, []);

  const refreshWalletCounters = useCallback(() => {
    setWalletCounters(getWalletCountersByMint());
  }, []);

  useEffect(() => {
    if (walletExpanded) {
      refreshWalletCounters();
    }
  }, [walletExpanded, refreshWalletCounters]);

  const collectSpentSecrets = useCallback(
    async (mintUrl: string, proofs: Proof[]) => {
      const normalized = normalizeMint(mintUrl);
      if (!normalized) {
        throw new Error("Mint unavailable");
      }
      const spent = new Set<string>();
      const chunkSize = 50;
      for (let start = 0; start < proofs.length; start += chunkSize) {
        const chunk = proofs.slice(start, start + chunkSize);
        const states = await checkProofStates(normalized, chunk);
        states.forEach((state, index) => {
          const stateValue = typeof state?.state === "string" ? state.state.toUpperCase() : "";
          if (stateValue === "SPENT") {
            const secret = chunk[index]?.secret;
            if (secret) {
              spent.add(secret);
            }
          }
        });
      }
      return spent;
    },
    [checkProofStates, normalizeMint],
  );

  const handleRegenerateWalletSeed = useCallback(() => {
    try {
      const record = regenerateWalletSeed();
      setWalletSeedWords(record.mnemonic);
      setWalletSeedVisible(true);
      setWalletSeedError(null);
      refreshWalletCounters();
      onReloadNeeded();
      setShowNewSeedConfirm(false);
      showToast("New seed phrase generated. Close Settings to reload your wallet.", 3500);
    } catch (error: any) {
      const message = error?.message || "Failed to generate a new seed phrase.";
      setWalletSeedError(message);
      showToast(message, 3500);
    }
  }, [refreshWalletCounters, onReloadNeeded, showToast]);

  const handleRemoveSpentProofs = useCallback(async () => {
    setRemoveSpentBusy(true);
    setRemoveSpentStatus(null);
    try {
      const store = loadProofStore();
      const entries = Object.entries(store);
      if (!entries.length) {
        setRemoveSpentStatus({ type: "success", message: "No proofs stored for any mint." });
        return;
      }
      let totalRemoved = 0;
      const mintErrors: string[] = [];
      for (const [mintKey, proofList] of entries) {
        if (!Array.isArray(proofList) || proofList.length === 0) continue;
        const proofsWithSecret = proofList.filter(
          (proof): proof is Proof => !!proof?.secret && typeof proof.secret === "string" && proof.secret.trim() !== "",
        );
        if (!proofsWithSecret.length) continue;
        try {
          const spentSecrets = await collectSpentSecrets(mintKey, proofsWithSecret);
          if (!spentSecrets.size) continue;
          store[mintKey] = proofList.filter((proof) => {
            if (!proof || typeof proof.secret !== "string") return true;
            return !spentSecrets.has(proof.secret);
          });
          totalRemoved += spentSecrets.size;
        } catch (error: any) {
          mintErrors.push(`${shortMintLabel(mintKey)}: ${error?.message || "check failed"}`);
        }
      }
      if (totalRemoved > 0) {
        saveProofStore(store);
        onReloadNeeded();
        showToast("Removed spent proofs. Close Settings to reload your wallet.", 3500);
      }
      const parts: string[] = [];
      if (totalRemoved > 0) {
        parts.push(`Removed ${totalRemoved} spent note${totalRemoved === 1 ? "" : "s"}.`);
      } else {
        parts.push("No spent proofs detected.");
      }
      if (mintErrors.length) {
        parts.push(`Skipped ${mintErrors.length} mint${mintErrors.length === 1 ? "" : "s"} (${mintErrors.join("; ")}).`);
      }
      setRemoveSpentStatus({
        type: mintErrors.length ? "error" : "success",
        message: parts.join(" "),
      });
    } catch (error: any) {
      setRemoveSpentStatus({ type: "error", message: error?.message || "Unable to remove spent proofs." });
    } finally {
      setRemoveSpentBusy(false);
    }
  }, [collectSpentSecrets, onReloadNeeded, shortMintLabel, showToast]);

  const handleMarkHistoryEntriesOlderSpent = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
    if (!raw) {
      showToast("No wallet history entries to mark.", 3000);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      showToast("Unable to read wallet history.", 3000);
      return;
    }
    if (!Array.isArray(parsed)) {
      showToast("No wallet history entries to mark.", 3000);
      return;
    }
    const now = Date.now();
    const threshold = now - HISTORY_MARK_SPENT_CUTOFF_MS;
    let updatedCount = 0;
    const nextHistory = parsed.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const createdAt =
        typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
      if (createdAt > threshold) return entry;
      const tokenState = entry.tokenState;
      if (!tokenState || !Array.isArray(tokenState.proofs) || tokenState.proofs.length === 0) {
        return entry;
      }
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (tokenState.lastState === "SPENT" || summary.includes("(spent)")) {
        return entry;
      }
      const updated = markHistoryEntrySpentRaw(entry as HistoryEntryRaw, now);
      if (!updated) return entry;
      updatedCount += 1;
      return updated;
    });
    if (!updatedCount) {
      showToast("No history entries older than 5 days needed marking.", 3000);
      return;
    }
    try {
      idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(nextHistory));
    } catch {
      showToast("Unable to update wallet history.", 3000);
      return;
    }
    showToast(`Marked ${updatedCount} history entr${updatedCount === 1 ? "y" : "ies"} as spent`, 3000);
    window.dispatchEvent(
      new CustomEvent(MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT, {
        detail: { cutoffMs: HISTORY_MARK_SPENT_CUTOFF_MS },
      }),
    );
  }, [showToast]);

  const handleIncrementKeysetCounter = useCallback(
    (mintUrl: string, keysetId: string) => {
      const normalizedMint = normalizeMint(mintUrl);
      if (!normalizedMint || !keysetId) return;
      const busyKey = `${normalizedMint}|${keysetId}`;
      setKeysetCounterBusy(busyKey);
      try {
        const nextValue = incrementWalletCounter(normalizedMint, keysetId, 1);
        setWalletCounters((prev) => {
          const next = { ...prev };
          const mintCounters = { ...(next[normalizedMint] ?? {}) };
          mintCounters[keysetId] = nextValue;
          next[normalizedMint] = mintCounters;
          return next;
        });
        onReloadNeeded();
        showToast("Counter incremented. Close Settings to reload your wallet.", 3500);
      } catch (error: any) {
        showToast(error?.message || "Failed to increment counter.", 3500);
      } finally {
        setKeysetCounterBusy(null);
      }
    },
    [normalizeMint, onReloadNeeded, showToast],
  );

  const enableDebugConsole = useCallback(() => {
    if (debugConsoleState === "loading") return;
    setDebugConsoleMessage(null);
    if (typeof document === "undefined") {
      setDebugConsoleMessage("Debug console unavailable in this environment.");
      return;
    }
    if (document.querySelector("#eruda")) {
      setDebugConsoleState("active");
      kvStorage.setItem(DEBUG_CONSOLE_STORAGE_KEY, "true");
      showToast("Debug console already enabled.", 2500);
      return;
    }
    setDebugConsoleState("loading");
    try {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/eruda";
      script.async = true;
      script.setAttribute("data-taskify-eruda", "true");
      script.onload = () => {
        try {
          (window as any)?.eruda?.init?.();
          setDebugConsoleState("active");
          kvStorage.setItem(DEBUG_CONSOLE_STORAGE_KEY, "true");
          showToast("Debug console enabled.", 2500);
        } catch (error: any) {
          setDebugConsoleState("inactive");
          setDebugConsoleMessage(error?.message || "Failed to start the debug console.");
        }
      };
      script.onerror = () => {
        setDebugConsoleState("inactive");
        setDebugConsoleMessage("Failed to load the debug console script.");
      };
      document.body.appendChild(script);
      debugConsoleScriptRef.current = script;
    } catch (error: any) {
      setDebugConsoleState("inactive");
      setDebugConsoleMessage(error?.message || "Failed to load the debug console.");
    }
  }, [debugConsoleState, showToast]);

  const disableDebugConsole = useCallback(() => {
    setDebugConsoleMessage(null);
    if (typeof document !== "undefined") {
      const erudaRoot = document.querySelector("#eruda");
      if (erudaRoot) erudaRoot.remove();
      const script = debugConsoleScriptRef.current;
      if (script?.parentNode) {
        script.parentNode.removeChild(script);
      }
      debugConsoleScriptRef.current = null;
    }
    if (typeof window !== "undefined") {
      try {
        const eruda = (window as any)?.eruda;
        eruda?.destroy?.();
      } catch {}
    }
    kvStorage.removeItem(DEBUG_CONSOLE_STORAGE_KEY);
    setDebugConsoleState("inactive");
    showToast("Debug console disabled.", 2000);
  }, [showToast]);

  const handleToggleDebugConsole = useCallback(() => {
    if (debugConsoleState === "loading") return;
    if (debugConsoleState === "active") {
      disableDebugConsole();
    } else {
      enableDebugConsole();
    }
  }, [debugConsoleState, disableDebugConsole, enableDebugConsole]);

  const handleToggleVoiceTestInput = useCallback(() => {
    setVoiceTestInputEnabled((prev) => {
      const next = !prev;
      if (next) {
        kvStorage.setItem(VOICE_TEST_INPUT_STORAGE_KEY, "true");
        showToast("Voice testing text input enabled.", 2000);
      } else {
        kvStorage.removeItem(VOICE_TEST_INPUT_STORAGE_KEY);
        showToast("Voice testing text input disabled.", 2000);
      }
      return next;
    });
  }, [showToast]);

  useEffect(() => {
    if (typeof document !== "undefined" && document.querySelector("#eruda")) {
      setDebugConsoleState("active");
      return;
    }
    const persisted = kvStorage.getItem(DEBUG_CONSOLE_STORAGE_KEY) === "true";
    if (persisted) enableDebugConsole();
  }, [enableDebugConsole]);

  const sortedP2pkKeys = useMemo(() => {
    return [...p2pkKeys].sort((a, b) => {
      const labelA = (a.label || "").toLowerCase();
      const labelB = (b.label || "").toLowerCase();
      if (labelA && labelB && labelA !== labelB) return labelA.localeCompare(labelB);
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return a.publicKey.localeCompare(b.publicKey);
    });
  }, [p2pkKeys]);

  const handleGenerateP2pkKey = useCallback((): P2PKKey | null => {
    try {
      const key = generateP2pkKeypair();
      setPrimaryP2pkKey(key.id);
      setP2pkKeysExpanded(true);
      showToast("Generated new P2PK key", 2500);
      return key;
    } catch (err: any) {
      showToast(err?.message || "Unable to generate key");
      return null;
    }
  }, [generateP2pkKeypair, setPrimaryP2pkKey, showToast]);

  const handleImportP2pkKey = useCallback((): P2PKKey | null => {
    setP2pkImportError("");
    try {
      const key = importP2pkFromNsec(p2pkImportValue, {
        label: p2pkImportLabel.trim() || undefined,
      });
      setPrimaryP2pkKey(key.id);
      setP2pkImportValue("");
      setP2pkImportLabel("");
      setP2pkImportVisible(false);
      setP2pkKeysExpanded(true);
      showToast("Key imported", 2500);
      return key;
    } catch (err: any) {
      setP2pkImportError(err?.message || "Unable to import key");
      return null;
    }
  }, [importP2pkFromNsec, p2pkImportLabel, p2pkImportValue, setPrimaryP2pkKey, showToast]);

  const handleRemoveP2pkKey = useCallback(
    (key: P2PKKey) => {
      if (!window.confirm("Remove this P2PK key? Tokens locked to it will no longer be spendable here.")) return;
      removeP2pkKey(key.id);
      showToast("Key removed", 2000);
    },
    [removeP2pkKey, showToast],
  );

  const handleSetPrimaryP2pkKey = useCallback(
    (key: P2PKKey) => {
      setPrimaryP2pkKey(key.id);
      showToast("Primary P2PK key updated", 2000);
    },
    [setPrimaryP2pkKey, showToast],
  );

  const handleCopyP2pkKey = useCallback(
    async (pubkey: string) => {
      try {
        await navigator.clipboard?.writeText(pubkey);
        showToast("Copied P2PK public key", 2000);
      } catch {
        showToast("Unable to copy key", 2000);
      }
    },
    [showToast],
  );

  const ensureWalletSeedLoaded = useCallback((): string => {
    if (walletSeedWords) return walletSeedWords;
    try {
      const mnemonic = getWalletSeedMnemonic();
      setWalletSeedWords(mnemonic);
      setWalletSeedError(null);
      return mnemonic;
    } catch (error) {
      console.error("[wallet] Unable to load seed", error);
      const message = "Unable to access wallet seed.";
      setWalletSeedError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [walletSeedWords]);

  const handleToggleWalletSeed = useCallback(() => {
    try {
      const seed = ensureWalletSeedLoaded();
      if (!seed) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      setWalletSeedVisible((prev) => !prev);
    } catch {
      // error state already handled in ensureWalletSeedLoaded
    }
  }, [ensureWalletSeedLoaded]);

  const handleCopyWalletSeed = useCallback(async () => {
    try {
      const mnemonic = ensureWalletSeedLoaded();
      if (!mnemonic) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      await navigator.clipboard?.writeText(mnemonic);
      setWalletSeedError(null);
      showToast("Wallet seed copied", 2000);
    } catch (error) {
      console.error("[wallet] Failed to copy wallet seed", error);
      setWalletSeedError("Unable to copy wallet seed.");
      showToast("Unable to copy wallet seed", 2000);
    }
  }, [ensureWalletSeedLoaded, showToast]);

  const handleDownloadWalletSeed = useCallback(() => {
    try {
      const mnemonic = ensureWalletSeedLoaded();
      if (!mnemonic) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      const backup = getWalletSeedBackupJson();
      const blob = new Blob([backup], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `taskify-wallet-seed-${timestamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setWalletSeedError(null);
      showToast("Wallet seed saved", 2000);
    } catch (error) {
      console.error("[wallet] Failed to save wallet seed", error);
      setWalletSeedError("Unable to save wallet seed.");
      showToast("Unable to save wallet seed", 2000);
    }
  }, [ensureWalletSeedLoaded, showToast]);

  const mintBackupRelays = useMemo(
    () =>
      (defaultRelays.length ? defaultRelays : DEFAULT_NOSTR_RELAYS)
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url): url is string => !!url),
    [defaultRelays],
  );

  const ensureMintBackupPool = useCallback(() => {
    if (mintBackupPoolRef.current) return mintBackupPoolRef.current;
    mintBackupPoolRef.current = new SessionPool();
    return mintBackupPoolRef.current;
  }, []);

  const persistMintBackupCacheState = useCallback((payload: MintBackupPayload) => {
    setMintBackupCache(payload);
    persistMintBackupCache(payload);
  }, []);

  const syncMintBackup = useCallback(async () => {
    if (!settings.walletMintBackupEnabled) return;
    setMintBackupState("syncing");
    setMintBackupMessage("");
    try {
      if (!mintBackupRelays.length) {
        throw new Error("No Nostr relays configured.");
      }
      const mnemonic = getWalletSeedMnemonic();
      const keys = deriveMintBackupKeys(mnemonic);
      const mints = getMintList();
      const template = await createMintBackupTemplate(mints, keys, {
        clientTag: MINT_BACKUP_CLIENT_TAG,
        timestamp: Math.floor(Date.now() / 1000),
      });
      const pool = ensureMintBackupPool();
      const created_at = Math.max(template.created_at || 0, Math.floor(Date.now() / 1000));
      const signed = finalizeEvent(
        { ...template, pubkey: keys.publicKeyHex, created_at },
        hexToBytes(keys.privateKeyHex),
      );
      await safePublish(pool, mintBackupRelays, signed);
      persistMintBackupCacheState({
        mints,
        timestamp: signed.created_at || created_at,
      });
      setMintBackupState("success");
      setMintBackupMessage("Mint list backed up to Nostr.");
    } catch (error: any) {
      console.error("[wallet] Unable to sync mint backup", error);
      setMintBackupState("error");
      setMintBackupMessage(error?.message || "Unable to back up mints.");
    }
  }, [ensureMintBackupPool, mintBackupRelays, persistMintBackupCacheState, safePublish, settings.walletMintBackupEnabled]);

  const handleRestoreMintBackup = useCallback(async () => {
    setMintBackupState("restoring");
    setMintBackupMessage("");
    try {
      if (!mintBackupRelays.length) {
        throw new Error("No Nostr relays configured.");
      }
      const mnemonic = getWalletSeedMnemonic();
      const keys = deriveMintBackupKeys(mnemonic);
      const pool = ensureMintBackupPool();
      const events = await pool.list(mintBackupRelays, [
        { kinds: [MINT_BACKUP_KIND], authors: [keys.publicKeyHex], "#d": [MINT_BACKUP_D_TAG] },
      ]);
      const latest = events.reduce<null | { created_at?: number; content: string }>((current, ev) => {
        if (!ev) return current;
        if (!current || (ev.created_at || 0) > (current.created_at || 0)) return ev;
        return current;
      }, null);
      if (!latest) {
        throw new Error("No mint backups found.");
      }
      const payload = await decryptMintBackupPayload(latest.content, keys);
      const restoredMints = payload.mints;
      replaceMintList(restoredMints);
      persistMintBackupCacheState({
        mints: restoredMints,
        timestamp: payload.timestamp || latest.created_at || Math.floor(Date.now() / 1000),
      });
      setMintBackupState("success");
      setMintBackupMessage(
        `Restored ${restoredMints.length} mint${restoredMints.length === 1 ? "" : "s"} from backup.`,
      );
    } catch (error: any) {
      console.error("[wallet] Unable to restore mint backup", error);
      setMintBackupState("error");
      setMintBackupMessage(error?.message || "Unable to restore mint backup.");
    }
  }, [ensureMintBackupPool, mintBackupRelays, persistMintBackupCacheState]);

  useEffect(() => {
    if (!settings.walletMintBackupEnabled) {
      setMintBackupState("idle");
      setMintBackupMessage("");
      return;
    }
    void syncMintBackup();
  }, [settings.walletMintBackupEnabled, syncMintBackup]);

  return (
        <section className="wallet-section space-y-3">
          <button
            className="flex w-full items-center gap-2 mb-3 text-left"
            onClick={() => setWalletExpanded((prev) => !prev)}
            aria-expanded={walletExpanded}
          >
            <div className="text-sm font-medium flex-1">Wallet</div>
            <span className="text-xs text-tertiary">{walletExpanded ? "Hide" : "Show"}</span>
            <span className="text-tertiary">{walletExpanded ? "−" : "+"}</span>
          </button>
          {walletExpanded && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium mb-1">Currency conversion</div>
                <div className="text-xs text-secondary mb-2">Show USD equivalents by fetching spot BTC prices from Coinbase.</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletConversionEnabled)}
                    onClick={() => setSettings({ walletConversionEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletConversionEnabled)}
                    onClick={() => setSettings({ walletConversionEnabled: false, walletPrimaryCurrency: "sat" })}
                  >Off</button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Bitcoin denomination</div>
                <div className="text-xs text-secondary mb-2">Choose how sat amounts are labeled in the wallet.</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={pillButtonClass(settings.walletDenominationDisplay !== "sat")}
                    onClick={() => setSettings({ walletDenominationDisplay: "bitcoin-symbol" })}
                  >₿42,778</button>
                  <button
                    className={pillButtonClass(settings.walletDenominationDisplay === "sat")}
                    onClick={() => setSettings({ walletDenominationDisplay: "sat" })}
                  >42,778 sat</button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Contacts sync/backup</div>
                <div className="text-xs text-secondary mb-2">
                  Publish and pull your wallet contacts over Nostr. Turn off to keep contacts local only.
                </div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletContactsSyncEnabled)}
                    onClick={() => setSettings({ walletContactsSyncEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletContactsSyncEnabled)}
                    onClick={() => setSettings({ walletContactsSyncEnabled: false })}
                  >Off</button>
                </div>
              </div>
              <div className="text-xs text-secondary">
                Open wallet bounties from Wallet → Bounties. Pinning now replaces the old "add to bounties" flow.
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Nostr mint backup</div>
                <div className="text-xs text-secondary mb-2">Automatically back up your saved mint list to Taskify's Nostr relays using your wallet seed.</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletMintBackupEnabled)}
                    onClick={() => setSettings({ walletMintBackupEnabled: true })}
                  >
                    On
                  </button>
                  <button
                    className={pillButtonClass(!settings.walletMintBackupEnabled)}
                    onClick={() => setSettings({ walletMintBackupEnabled: false })}
                  >
                    Off
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={syncMintBackup}
                    disabled={!settings.walletMintBackupEnabled || mintBackupState === "syncing"}
                  >
                    {mintBackupState === "syncing" ? "Backing up…" : "Sync now"}
                  </button>
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={handleRestoreMintBackup}
                    disabled={mintBackupState === "restoring"}
                  >
                    {mintBackupState === "restoring" ? "Restoring…" : "Restore"}
                  </button>
                </div>
                {mintBackupCache?.timestamp ? (
                  <div className="text-[11px] text-secondary mt-1">
                    Last backup: {new Date((mintBackupCache.timestamp || 0) * 1000).toLocaleString()}
                  </div>
                ) : null}
                {mintBackupMessage && (
                  <div className={`text-xs mt-1 ${mintBackupState === "error" ? "text-rose-400" : "text-secondary"}`}>
                    {mintBackupMessage}
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Wallet seed backup</div>
                <div className="text-xs text-secondary mb-2">
                  Save these 12 words in a secure place. The exported file also includes deterministic counters for each mint so you can restore your Cashu wallet elsewhere.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`${walletSeedVisible ? "ghost-button" : "accent-button"} button-sm pressable`}
                    onClick={handleToggleWalletSeed}
                  >
                    {walletSeedVisible ? "Hide words" : "Show words"}
                  </button>
                  <button className="ghost-button button-sm pressable" onClick={handleCopyWalletSeed}>
                    Copy seed
                  </button>
                  <button className="ghost-button button-sm pressable" onClick={handleDownloadWalletSeed}>
                    Save backup file
                  </button>
                </div>
                {walletSeedVisible && walletSeedWords && (
                  <div className="mt-2 p-3 rounded-lg border border-surface bg-surface-muted text-xs font-mono leading-relaxed break-words select-text">
                    {walletSeedWords}
                  </div>
                )}
                {walletSeedError && <div className="text-xs text-rose-400 mt-2">{walletSeedError}</div>}
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Background token state checks</div>
                <div className="text-xs text-secondary mb-2">
                  Periodically check supported mints for the status of sent eCash proofs and alert when a payment is received.
                </div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletSentStateChecksEnabled)}
                    onClick={() => setSettings({ walletSentStateChecksEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletSentStateChecksEnabled)}
                    onClick={() => setSettings({ walletSentStateChecksEnabled: false })}
                  >Off</button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Reset sent token tracking</div>
                <div className="text-xs text-secondary mb-2">Clears stored proof subscriptions so old eCash tokens stop retrying status updates.</div>
                <div className="flex gap-2">
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={() => {
                      const confirmed = window.confirm(
                        "Reset background tracking for sent tokens? This clears stored proof subscriptions so Taskify stops retrying old requests.",
                      );
                      if (!confirmed) return;
                      onResetWalletTokenTracking();
                    }}
                  >Reset tracking</button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Payment requests</div>
                <div className="text-xs text-secondary mb-2">Create Cashu payment requests and share them over Nostr for others to fund.</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletPaymentRequestsEnabled)}
                    onClick={() => setSettings({ walletPaymentRequestsEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletPaymentRequestsEnabled)}
                    onClick={() => setSettings({
                      walletPaymentRequestsEnabled: false,
                      walletPaymentRequestsBackgroundChecksEnabled: false,
                    })}
                  >Off</button>
                </div>
              </div>
              {settings.walletPaymentRequestsEnabled && (
                <>
                  <div>
                    <div className="text-sm font-medium mb-2">Background Nostr checks</div>
                    <div className="flex gap-2">
                      <button
                        className={pillButtonClass(settings.walletPaymentRequestsBackgroundChecksEnabled)}
                        onClick={() => setSettings({ walletPaymentRequestsBackgroundChecksEnabled: true })}
                      >On</button>
                      <button
                        className={pillButtonClass(!settings.walletPaymentRequestsBackgroundChecksEnabled)}
                        onClick={() => setSettings({ walletPaymentRequestsBackgroundChecksEnabled: false })}
                      >Off</button>
                    </div>
                    <div className="text-xs text-secondary mt-2">
                      Poll every minute for paid requests even when the wallet is closed.
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-2">Recipients (P2PK)</div>
                    <div className="text-xs text-secondary">Add lock keys to require recipients to prove control before spending.</div>
                    <div className="flex flex-wrap gap-2 text-xs mt-2">
                      <button
                        className="accent-button button-sm pressable"
                        onClick={() => {
                          handleGenerateP2pkKey();
                        }}
                      >
                        Generate key
                      </button>
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={() => {
                          setP2pkImportVisible((prev) => !prev);
                          setP2pkImportError("");
                        }}
                        aria-expanded={p2pkImportVisible}
                      >
                        {p2pkImportVisible ? "Hide import" : "Import nsec"}
                      </button>
                    </div>
                    {p2pkImportVisible && (
                      <div className="mt-2 space-y-2">
                        <input
                          className="pill-input text-xs"
                          placeholder="nsec1... or 64-hex secret key"
                          value={p2pkImportValue}
                          onChange={(e) => setP2pkImportValue(e.target.value)}
                        />
                        <input
                          className="pill-input text-xs"
                          placeholder="Label (optional)"
                          value={p2pkImportLabel}
                          onChange={(e) => setP2pkImportLabel(e.target.value)}
                        />
                        {p2pkImportError && <div className="text-[11px] text-rose-500">{p2pkImportError}</div>}
                        <div className="flex flex-wrap gap-2 text-xs">
                          <button
                            className="accent-button button-sm pressable"
                            onClick={() => {
                              handleImportP2pkKey();
                            }}
                            disabled={!p2pkImportValue.trim()}
                          >
                            Import
                          </button>
                          <button
                            className="ghost-button button-sm pressable"
                            onClick={() => {
                              setP2pkImportVisible(false);
                              setP2pkImportValue("");
                              setP2pkImportLabel("");
                              setP2pkImportError("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {sortedP2pkKeys.length ? (
                      <div className="mt-3 space-y-2">
                        <button
                          className="ghost-button button-sm pressable w-full justify-between"
                          onClick={() => setP2pkKeysExpanded((prev) => !prev)}
                          aria-expanded={p2pkKeysExpanded}
                        >
                          <span>
                            Browse {sortedP2pkKeys.length} key{sortedP2pkKeys.length === 1 ? "" : "s"}
                          </span>
                          <span className="text-tertiary">{p2pkKeysExpanded ? "−" : "+"}</span>
                        </button>
                        {p2pkKeysExpanded && (
                          <div className="space-y-2 max-h-60 overflow-auto pr-1">
                            {sortedP2pkKeys.map((key) => (
                              <div key={key.id} className="rounded-2xl border border-surface px-3 py-2 text-xs space-y-1">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-primary flex-1">
                                    {key.label?.trim() || key.publicKey.slice(0, 12)}
                                  </div>
                                  {primaryP2pkKey?.id === key.id && <span className="text-[10px] text-accent">Default</span>}
                                </div>
                                <div className="break-all text-tertiary text-[11px]">{key.publicKey}</div>
                                <div className="text-[11px] text-secondary">
                                  Used {key.usedCount}×{key.lastUsedAt ? ` • Last ${new Date(key.lastUsedAt).toLocaleDateString()}` : ""}
                                </div>
                                <div className="flex flex-wrap gap-2 text-[11px] mt-1">
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => handleCopyP2pkKey(key.publicKey)}
                                  >
                                    Copy
                                  </button>
                                  {primaryP2pkKey?.id !== key.id && (
                                    <button
                                      className="ghost-button button-sm pressable"
                                      onClick={() => handleSetPrimaryP2pkKey(key)}
                                    >
                                      Set default
                                    </button>
                                  )}
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => handleRemoveP2pkKey(key)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-secondary">
                        No P2PK keys yet. Generate or import one to lock tokens.
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="pt-3 border-t border-surface/30">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-sm font-medium flex-1">Advanced tools</div>
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={() => setWalletAdvancedVisible((prev) => !prev)}
                  >
                    {walletAdvancedVisible ? "Hide" : "Show"}
                  </button>
                </div>
                {walletAdvancedVisible && (
                  <div className="space-y-4">
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Generate new seed phrase</div>
                          <div className="text-xs text-secondary mt-1">
                            Replace your NUT-13 seed and reset keyset counters. Existing proofs stay untouched.
                          </div>
                        </div>
                        <button
                          className="ghost-button button-sm pressable shrink-0"
                          onClick={() => setShowNewSeedConfirm((prev) => !prev)}
                          aria-expanded={showNewSeedConfirm}
                        >
                          {showNewSeedConfirm ? "Cancel" : "Generate"}
                        </button>
                      </div>
                      {showNewSeedConfirm && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <div className="text-secondary flex-1 min-w-[200px]">
                            This immediately creates a completely new wallet seed. Save the words before reloading.
                          </div>
                          <button
                            className="ghost-button button-sm pressable"
                            onClick={() => setShowNewSeedConfirm(false)}
                          >
                            Never mind
                          </button>
                          <button
                            className="accent-button button-sm pressable"
                            onClick={handleRegenerateWalletSeed}
                          >
                            Confirm
                          </button>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Remove spent proofs</div>
                          <div className="text-xs text-secondary mt-1">
                            Ask each mint which notes were already spent and remove them from local storage.
                          </div>
                        </div>
                        <button
                          className={`${removeSpentBusy ? "ghost-button" : "accent-button"} button-sm pressable shrink-0`}
                          onClick={handleRemoveSpentProofs}
                          disabled={removeSpentBusy}
                        >
                          {removeSpentBusy ? "Checking…" : "Scan"}
                        </button>
                      </div>
                      {removeSpentStatus && (
                        <div
                          className={`text-xs mt-2 ${
                            removeSpentStatus.type === "error" ? "text-rose-400" : "text-secondary"
                          }`}
                        >
                          {removeSpentStatus.message}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Mark history entries older than five days as spent</div>
                          <div className="text-xs text-secondary mt-1">
                            Treat stale wallet entries as spent so we stop re-checking them on every refresh.
                          </div>
                        </div>
                        <button
                          className="accent-button button-sm pressable shrink-0"
                          onClick={handleMarkHistoryEntriesOlderSpent}
                        >
                          Mark spent
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Debug console</div>
                          <div className="text-xs text-secondary mt-1">
                            Load the in-app eruda console for troubleshooting on mobile browsers.
                          </div>
                        </div>
                        <button
                          className="ghost-button button-sm pressable shrink-0"
                          onClick={handleToggleDebugConsole}
                          disabled={debugConsoleState === "loading"}
                        >
                          {debugConsoleState === "active"
                            ? "Hide"
                            : debugConsoleState === "loading"
                              ? "Loading…"
                              : "Show"}
                        </button>
                      </div>
                      {debugConsoleMessage && (
                        <div className="text-xs text-rose-400 mt-2">{debugConsoleMessage}</div>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Voice testing text input</div>
                          <div className="text-xs text-secondary mt-1">
                            Show a paste/type transcript input in voice dictation for extraction testing only.
                          </div>
                        </div>
                        <button
                          className="ghost-button button-sm pressable shrink-0"
                          onClick={handleToggleVoiceTestInput}
                        >
                          {voiceTestInputEnabled ? "On" : "Off"}
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-medium mb-1">Increment keyset counters</div>
                      <div className="text-xs text-secondary">
                        Tap a keyset ID to advance the derivation counter if you hit "outputs already signed".
                      </div>
                      {walletCounterDisplayEntries.length ? (
                        <div className="mt-2 space-y-3">
                          {walletCounterDisplayEntries.map(([mint, counters]) => (
                            <div key={mint} className="rounded-2xl border border-surface px-3 py-2 space-y-2">
                              <div className="text-xs font-medium text-tertiary">{shortMintLabel(mint)}</div>
                              <div className="flex flex-wrap gap-2">
                                {Object.entries(counters)
                                  .sort(([a], [b]) => a.localeCompare(b))
                                  .map(([keysetId, count]) => {
                                    const busyKey = `${mint}|${keysetId}`;
                                    return (
                                      <button
                                        key={`${mint}-${keysetId}`}
                                        className="ghost-button button-sm pressable text-xs"
                                        onClick={() => handleIncrementKeysetCounter(mint, keysetId)}
                                        disabled={keysetCounterBusy === busyKey}
                                      >
                                        {keysetId} • #{count}
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-secondary mt-2">
                          Counters appear after you mint eCash with your Taskify seed.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
  );
}
