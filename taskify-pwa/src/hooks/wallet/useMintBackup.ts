import { useCallback, useEffect, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent } from "nostr-tools";
import { LS_MINT_BACKUP_ENABLED } from "../../localStorageKeys";
import { kvStorage } from "../../storage/kvStorage";
import {
  normalizeMintUrl,
  normalizeProofAmount,
  sumProofAmounts,
} from "../../wallet/cashuProofHelpers";
import {
  createMintBackupTemplate,
  deriveMintBackupKeys,
  loadMintBackupCache,
  MINT_BACKUP_CLIENT_TAG,
  persistMintBackupCache as persistMintBackupCacheToStorage,
  type MintBackupPayload,
} from "../../wallet/mintBackup";
import { getWalletSeedMnemonic } from "../../wallet/seed";
import { addMintToList, getMintList, loadStore } from "../../wallet/storage";

type MintBackupState = "idle" | "syncing" | "success" | "error" | "restoring";

export type MintEntry = {
  url: string;
  balance: number;
  count: number;
};

export type UseMintBackupOptions = {
  defaultNostrRelays: string[];
  enabledFromSettings: boolean;
  ensureNostrPool: () => any;
  mintUrl?: string | null;
  safePublish: (pool: any, relays: string[], event: any) => Promise<unknown>;
};

function mintListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useMintBackup({
  defaultNostrRelays,
  enabledFromSettings,
  ensureNostrPool,
  mintUrl,
  safePublish,
}: UseMintBackupOptions) {
  const [showMintBalances, setShowMintBalances] = useState(false);
  const [showNwcSheet, setShowNwcSheet] = useState(false);
  const [mintInputSheet, setMintInputSheet] = useState("");
  const [mintEntries, setMintEntries] = useState<MintEntry[]>([]);
  const [mintBackupEnabled, setMintBackupEnabled] = useState<boolean>(() => enabledFromSettings);
  const [, setMintBackupState] = useState<MintBackupState>("idle");
  const [, setMintBackupMessage] = useState("");
  const [mintBackupCache, setMintBackupCache] = useState<MintBackupPayload | null>(() =>
    loadMintBackupCache(),
  );
  const [mintBackupCandidate, setMintBackupCandidate] = useState<string[]>(() => getMintList());

  useEffect(() => {
    setMintBackupEnabled(enabledFromSettings);
  }, [enabledFromSettings]);

  useEffect(() => {
    try {
      kvStorage.setItem(LS_MINT_BACKUP_ENABLED, mintBackupEnabled ? "1" : "0");
    } catch {
      // ignore persistence errors
    }
  }, [mintBackupEnabled]);

  useEffect(() => {
    if (!mintBackupEnabled) {
      setMintBackupState("idle");
      setMintBackupMessage("");
    }
  }, [mintBackupEnabled]);

  const persistMintBackupCache = useCallback((payload: MintBackupPayload) => {
    setMintBackupCache(payload);
    persistMintBackupCacheToStorage(payload);
  }, []);

  const refreshMintEntries = useCallback(() => {
    try {
      const store = loadStore();
      const storeEntries = new Map<string, { url: string; proofs: Proof[] }>();
      Object.entries(store).forEach(([url, proofs]) => {
        const normalized = normalizeMintUrl(url);
        if (!normalized) return;
        storeEntries.set(normalized, {
          url,
          proofs: Array.isArray(proofs) ? (proofs as Proof[]) : [],
        });
      });

      let trackedMints = getMintList();
      const trackedSet = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrl(url);
        if (!normalized) continue;
        trackedSet.add(normalized);
      }

      if (mintUrl) {
        const normalizedActive = normalizeMintUrl(mintUrl);
        if (normalizedActive && !trackedSet.has(normalizedActive)) {
          trackedMints = addMintToList(mintUrl);
          trackedSet.add(normalizedActive);
        }
      }

      storeEntries.forEach((payload, normalized) => {
        const hasBalance = payload.proofs.some((proof) => normalizeProofAmount(proof?.amount) > 0);
        if (hasBalance && !trackedSet.has(normalized)) {
          trackedMints = addMintToList(payload.url);
          trackedSet.add(normalized);
        }
      });

      const entries: MintEntry[] = [];
      const seen = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrl(url);
        if (!normalized || seen.has(normalized)) continue;
        const payload = storeEntries.get(normalized);
        const proofs = payload?.proofs ?? [];
        const balance = sumProofAmounts(proofs);
        entries.push({
          url,
          balance,
          count: proofs.length,
        });
        seen.add(normalized);
      }

      entries.sort((a, b) => b.balance - a.balance || a.url.localeCompare(b.url));
      setMintBackupCandidate(trackedMints);
      setMintEntries(entries);
    } catch (error) {
      console.warn("Failed to refresh mint entries", error);
      setMintEntries([]);
    }
  }, [mintUrl]);

  const syncMintBackup = useCallback(
    async (overrideMints?: string[]) => {
      if (!mintBackupEnabled) return;
      setMintBackupState("syncing");
      setMintBackupMessage("");
      try {
        const relays = defaultNostrRelays
          .map((url) => (typeof url === "string" ? url.trim() : ""))
          .filter((url): url is string => !!url);
        if (!relays.length) {
          throw new Error("No Nostr relays configured.");
        }
        const mnemonic = getWalletSeedMnemonic();
        const keys = deriveMintBackupKeys(mnemonic);
        const mintList = (overrideMints ?? getMintList()).map((mint) => mint);
        if (mintBackupCache && mintListsEqual(mintBackupCache.mints, mintList)) {
          setMintBackupState("success");
          setMintBackupMessage("Mint backup already up to date.");
          return;
        }
        const template = await createMintBackupTemplate(mintList, keys, {
          clientTag: MINT_BACKUP_CLIENT_TAG,
        });
        const created_at = Math.max(template.created_at || 0, Math.floor(Date.now() / 1000));
        const signedEvent = finalizeEvent(
          { ...template, created_at },
          hexToBytes(keys.privateKeyHex),
        );
        const pool = ensureNostrPool();
        await safePublish(pool, relays, signedEvent as any);
        const payload: MintBackupPayload = {
          mints: mintList,
          timestamp: signedEvent.created_at || created_at,
        };
        persistMintBackupCache(payload);
        setMintBackupState("success");
        setMintBackupMessage(
          `Backed up ${mintList.length} mint${mintList.length === 1 ? "" : "s"}.`,
        );
      } catch (error: any) {
        setMintBackupState("error");
        setMintBackupMessage(error?.message || "Unable to back up mints.");
      }
    },
    [
      defaultNostrRelays,
      ensureNostrPool,
      mintBackupCache,
      mintBackupEnabled,
      persistMintBackupCache,
      safePublish,
    ],
  );

  useEffect(() => {
    if (!mintBackupEnabled) return;
    void syncMintBackup(mintBackupCandidate);
  }, [mintBackupCandidate, mintBackupEnabled, syncMintBackup]);

  return {
    showMintBalances,
    setShowMintBalances,
    showNwcSheet,
    setShowNwcSheet,
    mintInputSheet,
    setMintInputSheet,
    mintEntries,
    refreshMintEntries,
  };
}
