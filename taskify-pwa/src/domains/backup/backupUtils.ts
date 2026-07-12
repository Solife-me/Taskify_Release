// Backup utility functions extracted from App.tsx

import type { TaskifyBackupPayload, WalletHistoryLogEntry } from "./backupTypes";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { kvStorage } from "../../storage/kvStorage";
import { TASKIFY_STORE_TASKS, TASKIFY_STORE_WALLET, TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import {
  LS_SETTINGS,
  LS_BIBLE_TRACKER,
  LS_SCRIPTURE_MEMORY,
  LS_BACKGROUND_IMAGE,
} from "../storageKeys";
import { LS_NOSTR_RELAYS, TASKIFY_NOSTR_KEY_UPDATED_EVENT } from "../../nostrKeys";
import { setSk as nostrSkSet } from "../../lib/nostrSkStore";
import {
  taskEntityStore,
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
} from "../../storage/entityStore";
import { LS_LIGHTNING_CONTACTS, LS_BTC_USD_PRICE_CACHE, LS_CONTACTS_SYNC_META } from "../../localStorageKeys";
import {
  saveStore as saveProofStore,
  setActiveMint,
  replaceMintList,
  replacePendingTokens,
  normalizeMintUrl,
  type PendingTokenEntry,
  type ProofStore,
} from "../../wallet/storage";
import { type WalletSeedBackupPayload, restoreWalletSeedBackup } from "../../wallet/seed";
import type { Proof } from "@cashu/cashu-ts";

// ---- Constants ----

export const SATS_PER_BTC = 100_000_000;

function notifyNostrKeyUpdated(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(TASKIFY_NOSTR_KEY_UPDATED_EVENT));
  } catch {
    // ignore same-tab notification failures
  }
}

// ---- Backup functions ----

export function parseBackupJsonPayload(raw: string): Partial<TaskifyBackupPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid backup file.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid backup data");
  }
  return parsed as Partial<TaskifyBackupPayload>;
}

function normalizeCashuProofStore(raw: unknown): ProofStore | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const store: ProofStore = {};
  for (const [mintUrl, value] of Object.entries(raw as Record<string, unknown>)) {
    const mint = normalizeMintUrl(mintUrl);
    if (!mint || !Array.isArray(value)) continue;
    const proofs: Proof[] = [];
    for (const proof of value) {
      if (!proof || typeof proof !== "object") continue;
      const candidate = proof as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id : "";
      const secret = typeof candidate.secret === "string" ? candidate.secret : "";
      const C = typeof candidate.C === "string" ? candidate.C : "";
      const amountRaw = candidate.amount;
      const amount =
        typeof amountRaw === "number"
          ? amountRaw
          : typeof amountRaw === "string" && amountRaw.trim()
            ? Number.parseFloat(amountRaw)
            : Number.NaN;
      if (!id || !secret || !C || !Number.isFinite(amount) || amount <= 0) continue;
      proofs.push({
        ...(candidate as Proof),
        amount: Math.floor(amount) as any,
      });
    }
    if (proofs.length) {
      store[mint] = proofs;
    }
  }
  return store;
}

export function applyBackupDataToStorage(data: Partial<TaskifyBackupPayload>): void {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid backup data");
  }
  // Wholesale-replace each per-entity v3 store; the legacy blobs are
  // deprecated post-migration. Caller must `flush()` each store before
  // reloading the page so writes are durable.
  if ("tasks" in data && Array.isArray(data.tasks)) {
    taskEntityStore.replaceAll(data.tasks as { id: string }[]);
  }
  if ("calendarEvents" in data && Array.isArray(data.calendarEvents)) {
    calendarEventEntityStore.replaceAll(data.calendarEvents as { id: string }[]);
  }
  if ("externalCalendarEvents" in data && Array.isArray(data.externalCalendarEvents)) {
    externalCalendarEventEntityStore.replaceAll(data.externalCalendarEvents as { id: string }[]);
  }
  if ("boards" in data && Array.isArray(data.boards)) {
    boardEntityStore.replaceAll(data.boards as { id: string }[]);
  }
  if ("settings" in data && data.settings !== undefined) {
    // Extract backgroundImage from settings and store separately in IndexedDB
    const settingsToStore = { ...(data.settings as Record<string, unknown>) };
    const bgImage = settingsToStore.backgroundImage;
    delete settingsToStore.backgroundImage;
    kvStorage.setItem(LS_SETTINGS, JSON.stringify(settingsToStore));
    if (typeof bgImage === "string" && bgImage) {
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE, bgImage);
    } else {
      idbKeyValue.removeItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE);
    }
  }
  if ("scriptureMemory" in data && data.scriptureMemory !== undefined) {
    kvStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(data.scriptureMemory));
  }
  if ("bibleTracker" in data && data.bibleTracker !== undefined) {
    kvStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(data.bibleTracker));
  }
  if ("defaultRelays" in data && data.defaultRelays !== undefined) {
    kvStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(data.defaultRelays));
  }
  if ("contacts" in data && data.contacts !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_LIGHTNING_CONTACTS, JSON.stringify(data.contacts));
  }
  if ("contactsSyncMeta" in data && data.contactsSyncMeta !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACTS_SYNC_META, JSON.stringify(data.contactsSyncMeta));
  }
  if (typeof data.nostrSk === "string" && data.nostrSk) {
    void nostrSkSet(data.nostrSk);
    notifyNostrKeyUpdated();
  }
  const cashuData = data.cashu as Partial<TaskifyBackupPayload["cashu"]> | undefined;
  if (cashuData && typeof cashuData === "object") {
    if ("proofs" in cashuData && cashuData.proofs !== undefined) {
      const proofStore = normalizeCashuProofStore(cashuData.proofs);
      if (proofStore) {
        saveProofStore(proofStore);
      }
    }
    if ("activeMint" in cashuData) {
      setActiveMint(cashuData.activeMint || null);
    }
    if ("history" in cashuData) {
      try {
        const history = Array.isArray(cashuData.history) ? cashuData.history : [];
        idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(history));
      } catch {
        idbKeyValue.removeItem(TASKIFY_STORE_WALLET, "cashuHistory");
      }
    }
    if ("trackedMints" in cashuData && cashuData.trackedMints !== undefined) {
      replaceMintList(Array.isArray(cashuData.trackedMints) ? cashuData.trackedMints : []);
    }
    if ("pendingTokens" in cashuData && cashuData.pendingTokens !== undefined) {
      const entries = Array.isArray(cashuData.pendingTokens)
        ? (cashuData.pendingTokens as PendingTokenEntry[])
        : [];
      replacePendingTokens(entries);
    }
    if ("walletSeed" in cashuData && cashuData.walletSeed) {
      restoreWalletSeedBackup(cashuData.walletSeed as WalletSeedBackupPayload);
    }
  }
}

export function readWalletConversionsEnabled(fallback?: boolean): boolean {
  if (typeof fallback === "boolean") return fallback;
  try {
    const raw = kvStorage.getItem(LS_SETTINGS);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed?.walletConversionEnabled !== false;
  } catch {
    return true;
  }
}

export function readCachedUsdPrice(): number | null {
  try {
    const raw = kvStorage.getItem(LS_BTC_USD_PRICE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const price = Number(parsed?.price);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

export function captureHistoryFiatValue(amountSat?: number | null, conversionsEnabled?: boolean): number | undefined {
  if (!conversionsEnabled || amountSat == null || !Number.isFinite(amountSat) || amountSat <= 0) {
    return undefined;
  }
  const cachedPrice = readCachedUsdPrice();
  if (cachedPrice == null || cachedPrice <= 0) return undefined;
  const usdValue = (amountSat / SATS_PER_BTC) * cachedPrice;
  return Number.isFinite(usdValue) ? Number(usdValue.toFixed(2)) : undefined;
}

export function appendWalletHistoryEntry(entry: WalletHistoryLogEntry, options?: { conversionsEnabled?: boolean }) {
  try {
    const conversionsEnabled = readWalletConversionsEnabled(options?.conversionsEnabled);
    const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
    const existing = raw ? JSON.parse(raw) : [];
    const createdAt = Date.now();
    const fiatValueUsd = captureHistoryFiatValue(entry.amountSat, conversionsEnabled);
    const normalized = {
      id: entry.id ?? `${entry.type}-${createdAt}`,
      summary: entry.summary,
      type: entry.type,
      direction: entry.direction,
      amountSat: entry.amountSat,
      detail: entry.detail,
      detailKind: entry.detailKind,
      mintUrl: entry.mintUrl,
      feeSat: entry.feeSat,
      entryKind: entry.entryKind,
      relatedTaskTitle: entry.relatedTaskTitle,
      createdAt,
      fiatValueUsd,
    };
    const next = Array.isArray(existing) ? [normalized, ...existing] : [normalized];
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(next));
    try {
      window.dispatchEvent(new Event("taskify:wallet-history-updated"));
    } catch {
      // ignore
    }
  } catch (error) {
    console.warn("Failed to append wallet history entry", error);
  }
}
