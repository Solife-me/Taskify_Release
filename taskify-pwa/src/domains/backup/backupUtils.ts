// Backup utility functions extracted from App.tsx

import type { TaskifyBackupPayload, WalletHistoryLogEntry } from "./backupTypes";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { kvStorage } from "../../storage/kvStorage";
import { TASKIFY_STORE_TASKS, TASKIFY_STORE_WALLET, TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import {
  LS_TASKS,
  LS_CALENDAR_EVENTS,
  LS_EXTERNAL_CALENDAR_EVENTS,
  LS_BOARDS,
  LS_SETTINGS,
  LS_BIBLE_TRACKER,
  LS_SCRIPTURE_MEMORY,
  LS_BACKGROUND_IMAGE,
} from "../storageKeys";
import { LS_NOSTR_RELAYS, LS_NOSTR_SK } from "../../nostrKeys";
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
import { getPublicKey, nip19 } from "nostr-tools";

// ---- Constants ----

export const LS_LAST_CLOUD_BACKUP = "taskify_cloud_backup_last_v1";
export const LS_LAST_MANUAL_CLOUD_BACKUP = "taskify_cloud_backup_manual_last_v1";
export const CLOUD_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const MANUAL_CLOUD_BACKUP_INTERVAL_MS = 60 * 1000;
export const SATS_PER_BTC = 100_000_000;

// ---- Crypto helpers (self-contained, no external import needed) ----

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CLOUD_BACKUP_KEY_LABEL = new TextEncoder().encode("taskify-cloud-backup-v1");

async function deriveBackupAesKey(skHex: string): Promise<CryptoKey> {
  const raw = concatBytes(hexToBytes(skHex), CLOUD_BACKUP_KEY_LABEL);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptBackupWithSecretKey(skHex: string, plain: string): Promise<{ iv: string; ciphertext: string }> {
  const key = await deriveBackupAesKey(skHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { iv: b64encode(iv), ciphertext: b64encode(ctBuf) };
}

async function decryptBackupWithSecretKey(
  skHex: string,
  payload: { iv: string; ciphertext: string },
): Promise<string> {
  const key = await deriveBackupAesKey(skHex);
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.ciphertext);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

function deriveNpubFromSecretKeyHex(skHex: string): string | null {
  try {
    const pkHex = getPublicKey(hexToBytes(skHex));
    if (typeof (nip19 as any)?.npubEncode === "function") {
      return (nip19 as any).npubEncode(pkHex);
    }
    return pkHex;
  } catch {
    return null;
  }
}

function normalizeSecretKeyInput(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("nsec")) {
    try {
      const dec = nip19.decode(value);
      if (dec.type !== "nsec") return null;
      value = typeof dec.data === "string" ? dec.data : bytesToHex(dec.data as Uint8Array);
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
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
  if ("tasks" in data && data.tasks !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_TASKS, JSON.stringify(data.tasks));
  }
  if ("calendarEvents" in data && data.calendarEvents !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_CALENDAR_EVENTS, JSON.stringify(data.calendarEvents));
  }
  if ("externalCalendarEvents" in data && data.externalCalendarEvents !== undefined) {
    idbKeyValue.setItem(
      TASKIFY_STORE_TASKS,
      LS_EXTERNAL_CALENDAR_EVENTS,
      JSON.stringify(data.externalCalendarEvents),
    );
  }
  if ("boards" in data && data.boards !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARDS, JSON.stringify(data.boards));
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
    kvStorage.setItem(LS_NOSTR_SK, data.nostrSk);
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

export async function loadCloudBackupPayload(
  workerBaseUrl: string,
  secretKeyInput: string,
): Promise<Partial<TaskifyBackupPayload>> {
  if (!workerBaseUrl) {
    throw new Error("Cloud backup service is unavailable.");
  }
  const normalized = normalizeSecretKeyInput(secretKeyInput);
  if (!normalized) {
    throw new Error("Enter a valid nsec or 64-hex private key.");
  }
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Browser crypto APIs are unavailable.");
  }
  const npub = deriveNpubFromSecretKeyHex(normalized);
  if (!npub) {
    throw new Error("Unable to derive npub from the provided key.");
  }
  const res = await fetch(`${workerBaseUrl}/api/backups?npub=${encodeURIComponent(npub)}`);
  if (res.status === 404) {
    throw new Error("No cloud backup found for that key.");
  }
  if (!res.ok) {
    throw new Error(`Backup request failed (${res.status})`);
  }
  const body = await res.json();
  const backup = body?.backup;
  if (!backup || typeof backup !== "object" || typeof backup.ciphertext !== "string" || typeof backup.iv !== "string") {
    throw new Error("Invalid backup payload received.");
  }
  const decrypted = await decryptBackupWithSecretKey(normalized, {
    ciphertext: backup.ciphertext,
    iv: backup.iv,
  });
  try {
    return parseBackupJsonPayload(decrypted);
  } catch {
    throw new Error("Cloud backup could not be decoded.");
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
