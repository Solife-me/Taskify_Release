import type { Proof } from "@cashu/cashu-ts";
import type { MeltQuoteResponse } from "./cashuTypes";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../storage/taskifyDb";

const LS_KEY = "cashu_proofs_v1";
const LS_ACTIVE_MINT = "cashu_active_mint_v1";
const LS_PENDING_TOKENS = "cashu_pending_tokens_v1";
const LS_MINT_LIST = "cashu_tracked_mints_v1";
const LS_PENDING_MELTS = "cashu_pending_melts_v1";
const LS_LOCKED_MINT_QUOTES = "cashu_locked_mint_quotes_v1";

export type PendingTokenEntry = {
  id: string;
  mint: string;
  token: string;
  addedAt: number;
  attempts: number;
  amount?: number;
  lastTriedAt?: number;
  lastError?: string;
  source?: PendingTokenSource;
};

export type PendingTokenSource =
  | {
      type: "nutzap";
      eventId: string;
      senderPubkey?: string;
      relay?: string;
    };

export type ProofStore = {
  [mintUrl: string]: Proof[];
};

export type PendingMeltRecord = {
  quoteId: string;
  mint: string;
  quote: MeltQuoteResponse;
  keep: Proof[];
  send: Proof[];
  preview?: SerializedMeltPreview;
  createdAt: number;
  updatedAt: number;
};

export type SerializedOutputData = {
  blindedMessage: unknown;
  blindingFactor: string;
  secret: string;
  ephemeralE?: string;
};

export type SerializedMeltPreview = {
  method: string;
  inputs: Proof[];
  outputData: SerializedOutputData[];
  keysetId: string;
  quote: MeltQuoteResponse;
};

export type LockedMintQuotePayload = {
  quote: string;
  request?: string;
  unit?: string;
  amount?: unknown;
  state?: string;
  expiry?: number | null;
  pubkey?: string;
  [key: string]: unknown;
};

export type LockedMintQuoteRecord = {
  quoteId: string;
  mint: string;
  quote: LockedMintQuotePayload;
  pubkey: string;
  privkey: string;
  createdAt: number;
  updatedAt: number;
};

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function amountToNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Number(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const amountLike = value as { toNumber?: () => number; toNumberUnsafe?: () => number };
  try {
    if (typeof amountLike?.toNumber === "function") {
      const numeric = amountLike.toNumber();
      return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof amountLike?.toNumberUnsafe === "function") {
      const numeric = amountLike.toNumberUnsafe();
      return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    }
  } catch {
    // fall through
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function generatePendingTokenId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pending_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function loadStore(): ProofStore {
  return safeParse<ProofStore>(idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_KEY), {});
}

function loadMintListRaw(): string[] {
  try {
    return safeParse<string[]>(idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_MINT_LIST), []);
  } catch {
    return [];
  }
}

function persistMintList(urls: string[]) {
  try {
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_MINT_LIST, JSON.stringify(urls));
  } catch {
    // ignore persistence errors
  }
}

export function sanitizeMintList(raw: string[]): string[] {
  const sanitized: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeMintUrl(entry);
    if (!normalized || seen.has(normalized)) continue;
    sanitized.push(normalized);
    seen.add(normalized);
  }
  return sanitized;
}

export function getMintList(): string[] {
  const raw = loadMintListRaw();
  const sanitized = sanitizeMintList(raw);
  if (sanitized.length !== raw.length) {
    persistMintList(sanitized);
  }
  return sanitized;
}

export function replaceMintList(urls: string[]): string[] {
  const sanitized = sanitizeMintList(Array.isArray(urls) ? urls : []);
  persistMintList(sanitized);
  return sanitized;
}

export function addMintToList(url: string): string[] {
  const normalized = normalizeMintUrl(url);
  if (!normalized) return getMintList();
  const existing = getMintList();
  if (existing.includes(normalized)) return existing;
  const next = [...existing, normalized];
  persistMintList(next);
  return next;
}

export function removeMintFromList(url: string): string[] {
  const normalized = normalizeMintUrl(url);
  if (!normalized) return getMintList();
  const existing = getMintList();
  const next = existing.filter((entry) => entry !== normalized);
  persistMintList(next);
  return next;
}

function loadPendingTokenEntries(): PendingTokenEntry[] {
  return safeParse<PendingTokenEntry[]>(idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_PENDING_TOKENS), []);
}

function loadPendingMeltEntries(): PendingMeltRecord[] {
  return safeParse<PendingMeltRecord[]>(idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_PENDING_MELTS), []);
}

function loadLockedMintQuoteEntries(): LockedMintQuoteRecord[] {
  return safeParse<LockedMintQuoteRecord[]>(idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_LOCKED_MINT_QUOTES), []);
}

function normalizePendingTokenSource(source: any): PendingTokenSource | undefined {
  if (!source || typeof source !== "object") return undefined;
  if (source.type !== "nutzap") return undefined;
  const eventId = typeof source.eventId === "string" ? source.eventId.trim() : "";
  if (!eventId) return undefined;
  const senderPubkey = typeof source.senderPubkey === "string" ? source.senderPubkey.trim() : undefined;
  const relay = typeof source.relay === "string" ? source.relay.trim() : undefined;
  return {
    type: "nutzap",
    eventId,
    senderPubkey: senderPubkey || undefined,
    relay: relay || undefined,
  };
}

function normalizePendingTokens(entries: PendingTokenEntry[]): PendingTokenEntry[] {
  const normalized: PendingTokenEntry[] = [];
  for (const entry of entries) {
    if (!entry?.mint || !entry?.token) continue;
    normalized.push({
      id: entry.id,
      mint: entry.mint,
      token: entry.token,
      addedAt: entry.addedAt,
      attempts: entry.attempts ?? 0,
      amount: typeof entry.amount === "number" && Number.isFinite(entry.amount) ? entry.amount : undefined,
      lastTriedAt: entry.lastTriedAt,
      lastError: entry.lastError,
      source: normalizePendingTokenSource((entry as any).source),
    });
  }
  return normalized;
}

function savePendingTokenEntries(entries: PendingTokenEntry[]) {
  const normalized = normalizePendingTokens(entries);
  idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_PENDING_TOKENS, JSON.stringify(normalized));
}

function normalizePendingMelts(entries: PendingMeltRecord[]): PendingMeltRecord[] {
  const normalized: PendingMeltRecord[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const quoteId = typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "";
    const mint = normalizeMintUrl(entry?.mint ?? "");
    if (!quoteId || !mint || !entry?.quote) continue;
    const key = `${mint}::${quoteId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      quoteId,
      mint,
      quote: entry.quote,
      keep: Array.isArray(entry.keep) ? entry.keep : [],
      send: Array.isArray(entry.send) ? entry.send : [],
      preview: normalizeSerializedMeltPreview((entry as any).preview),
      createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    });
  }
  return normalized;
}

function normalizeSerializedMeltPreview(preview: unknown): SerializedMeltPreview | undefined {
  if (!preview || typeof preview !== "object") return undefined;
  const value = preview as SerializedMeltPreview;
  const quoteId = typeof value.quote?.quote === "string" ? value.quote.quote.trim() : "";
  if (!quoteId || typeof value.method !== "string" || typeof value.keysetId !== "string") return undefined;
  if (!Array.isArray(value.inputs) || !Array.isArray(value.outputData)) return undefined;
  const outputData = value.outputData
    .map((entry): SerializedOutputData | null => {
      if (!entry || typeof entry !== "object") return null;
      const blindingFactor = typeof entry.blindingFactor === "string" ? entry.blindingFactor : "";
      const secret = typeof entry.secret === "string" ? entry.secret : "";
      if (!entry.blindedMessage || !blindingFactor || !secret) return null;
      return {
        blindedMessage: entry.blindedMessage,
        blindingFactor,
        secret,
        ephemeralE: typeof entry.ephemeralE === "string" ? entry.ephemeralE : undefined,
      } satisfies SerializedOutputData;
    })
    .filter((entry): entry is SerializedOutputData => !!entry);
  return {
    method: value.method,
    inputs: value.inputs,
    outputData,
    keysetId: value.keysetId,
    quote: value.quote,
  };
}

function savePendingMeltEntries(entries: PendingMeltRecord[]) {
  const normalized = normalizePendingMelts(entries);
  idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_PENDING_MELTS, JSON.stringify(normalized));
}

function normalizeLockedMintQuotes(entries: LockedMintQuoteRecord[]): LockedMintQuoteRecord[] {
  const normalized: LockedMintQuoteRecord[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const quoteId = typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "";
    const mint = normalizeMintUrl(entry?.mint ?? "");
    const pubkey = typeof entry?.pubkey === "string" ? entry.pubkey.trim() : "";
    const privkey = typeof entry?.privkey === "string" ? entry.privkey.trim() : "";
    if (!quoteId || !mint || !entry?.quote || typeof entry.quote.quote !== "string" || !pubkey || !privkey) continue;
    const key = `${mint}::${quoteId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      quoteId,
      mint,
      quote: entry.quote,
      pubkey,
      privkey,
      createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    });
  }
  return normalized;
}

function saveLockedMintQuoteEntries(entries: LockedMintQuoteRecord[]) {
  const normalized = normalizeLockedMintQuotes(entries);
  idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_LOCKED_MINT_QUOTES, JSON.stringify(normalized));
}

export function saveStore(store: ProofStore) {
  const normalized: ProofStore = {};
  for (const [mintUrl, proofs] of Object.entries(store)) {
    if (Array.isArray(proofs)) {
      normalized[mintUrl] = proofs;
    }
  }
  idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_KEY, JSON.stringify(normalized));
  ensureActiveMintSelection(normalized);
}

export async function flushWalletStorage(): Promise<void> {
  await idbKeyValue.flushStore(TASKIFY_STORE_WALLET);
}

export function listPendingTokens(): PendingTokenEntry[] {
  return loadPendingTokenEntries();
}

export function addPendingToken(
  mintUrl: string,
  token: string,
  amount?: number,
  source?: PendingTokenSource,
): PendingTokenEntry {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const entry: PendingTokenEntry = {
    id: generatePendingTokenId(),
    mint: normalizedMint,
    token,
    addedAt: Date.now(),
    attempts: 0,
    amount: typeof amount === "number" && Number.isFinite(amount) ? amount : undefined,
    source: normalizePendingTokenSource(source),
  };
  const existing = loadPendingTokenEntries();
  const deduped = existing.filter((item) => item.token !== token);
  deduped.push(entry);
  savePendingTokenEntries(deduped);
  return entry;
}

export function removePendingToken(id: string) {
  const existing = loadPendingTokenEntries();
  const next = existing.filter((entry) => entry.id !== id);
  savePendingTokenEntries(next);
}

export function markPendingTokenAttempt(id: string, error?: string) {
  const existing = loadPendingTokenEntries();
  let changed = false;
  const next = existing.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return {
      ...entry,
      attempts: (entry.attempts ?? 0) + 1,
      lastTriedAt: Date.now(),
      lastError: error,
    };
  });
  if (changed) {
    savePendingTokenEntries(next);
  }
}

export function setPendingTokenSource(id: string, source: PendingTokenSource | null | undefined) {
  if (!id) return;
  const existing = loadPendingTokenEntries();
  let changed = false;
  const normalizedSource = source ? normalizePendingTokenSource(source) : undefined;
  const next = existing.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return {
      ...entry,
      source: normalizedSource,
    };
  });
  if (changed) {
    savePendingTokenEntries(next);
  }
}

export function replacePendingTokens(entries: PendingTokenEntry[]): PendingTokenEntry[] {
  const normalized = normalizePendingTokens(Array.isArray(entries) ? entries : []);
  savePendingTokenEntries(normalized);
  return normalized;
}

export function listPendingMelts(mintUrl?: string): PendingMeltRecord[] {
  const entries = normalizePendingMelts(loadPendingMeltEntries());
  if (!mintUrl) return entries;
  const normalizedMint = normalizeMintUrl(mintUrl);
  return entries.filter((entry) => entry.mint === normalizedMint);
}

export function getPendingMelt(mintUrl: string, quoteId: string): PendingMeltRecord | null {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedQuote = quoteId.trim();
  if (!normalizedMint || !normalizedQuote) return null;
  return (
    listPendingMelts().find(
      (entry) => entry.mint === normalizedMint && entry.quoteId === normalizedQuote,
    ) ?? null
  );
}

export function upsertPendingMelt(record: PendingMeltRecord): PendingMeltRecord | null {
  const normalized = normalizePendingMelts([record])[0];
  if (!normalized) return null;
  const existing = loadPendingMeltEntries();
  const next = existing.filter(
    (entry) =>
      normalizeMintUrl(entry?.mint ?? "") !== normalized.mint ||
      (typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "") !== normalized.quoteId,
  );
  next.push({ ...normalized, updatedAt: Date.now() });
  savePendingMeltEntries(next);
  return normalized;
}

export function removePendingMelt(mintUrl: string, quoteId: string) {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedQuote = quoteId.trim();
  if (!normalizedMint || !normalizedQuote) return;
  const existing = loadPendingMeltEntries();
  const next = existing.filter(
    (entry) =>
      normalizeMintUrl(entry?.mint ?? "") !== normalizedMint ||
      (typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "") !== normalizedQuote,
  );
  savePendingMeltEntries(next);
}

export function getLockedMintQuote(mintUrl: string, quoteId: string): LockedMintQuoteRecord | null {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedQuote = quoteId.trim();
  if (!normalizedMint || !normalizedQuote) return null;
  return (
    normalizeLockedMintQuotes(loadLockedMintQuoteEntries()).find(
      (entry) => entry.mint === normalizedMint && entry.quoteId === normalizedQuote,
    ) ?? null
  );
}

export function upsertLockedMintQuote(record: LockedMintQuoteRecord): LockedMintQuoteRecord | null {
  const normalized = normalizeLockedMintQuotes([record])[0];
  if (!normalized) return null;
  const existing = loadLockedMintQuoteEntries();
  const next = existing.filter(
    (entry) =>
      normalizeMintUrl(entry?.mint ?? "") !== normalized.mint ||
      (typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "") !== normalized.quoteId,
  );
  next.push({ ...normalized, updatedAt: Date.now() });
  saveLockedMintQuoteEntries(next);
  return normalized;
}

export function removeLockedMintQuote(mintUrl: string, quoteId: string) {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedQuote = quoteId.trim();
  if (!normalizedMint || !normalizedQuote) return;
  const existing = loadLockedMintQuoteEntries();
  const next = existing.filter(
    (entry) =>
      normalizeMintUrl(entry?.mint ?? "") !== normalizedMint ||
      (typeof entry?.quoteId === "string" ? entry.quoteId.trim() : "") !== normalizedQuote,
  );
  saveLockedMintQuoteEntries(next);
}

export function getProofs(mintUrl: string): Proof[] {
  const s = loadStore();
  return Array.isArray(s[mintUrl]) ? s[mintUrl] : [];
}

export function setProofs(mintUrl: string, proofs: Proof[]) {
  const s = loadStore();
  s[mintUrl] = proofs;
  saveStore(s);
  rememberMintFromProofs(mintUrl, proofs);
}

export function addProofs(mintUrl: string, proofs: Proof[]) {
  const current = getProofs(mintUrl);
  // dedupe by secret
  const merged = [...current, ...proofs];
  const seen = new Set<string>();
  const deduped: Proof[] = [];
  for (const p of merged) {
    if (!p?.secret) continue;
    if (seen.has(p.secret)) continue;
    seen.add(p.secret);
    deduped.push(p);
  }
  setProofs(mintUrl, deduped);
}

export function clearProofs(mintUrl: string) {
  const s = loadStore();
  delete s[mintUrl];
  saveStore(s);
}

export function getActiveMint(): string {
  try {
    return idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_ACTIVE_MINT) || "https://mint.solife.me";
  } catch {
    return "https://mint.solife.me";
  }
}

export function setActiveMint(url: string | null) {
  if (!url) idbKeyValue.removeItem(TASKIFY_STORE_WALLET, LS_ACTIVE_MINT);
  else idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_ACTIVE_MINT, url);
}

export function normalizeMintUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

function ensureActiveMintSelection(store: ProofStore) {
  try {
    const mintsWithBalance = Object.entries(store)
      .filter(([, proofs]) => Array.isArray(proofs) && proofs.some((p) => amountToNumber((p as any)?.amount) > 0))
      .map(([mintUrl]) => mintUrl);

    if (mintsWithBalance.length === 0) {
      return;
    }

    const currentActive = getActiveMint();
    const normalizedActive = normalizeMintUrl(currentActive);
    const activeEntry = Object.entries(store).find(
      ([mintUrl]) => normalizeMintUrl(mintUrl) === normalizedActive,
    );
    const activeBalance = Array.isArray(activeEntry?.[1])
      ? (activeEntry?.[1] as Proof[]).reduce((sum, proof) => sum + amountToNumber((proof as any)?.amount), 0)
      : 0;

    if (activeBalance > 0) {
      return;
    }

    const fallbackMint = mintsWithBalance[0];
    if (fallbackMint) {
      setActiveMint(fallbackMint);
    }
  } catch {
    // noop: persistence might be unavailable during SSR/tests
  }
}

function rememberMintFromProofs(mintUrl: string, proofs: Proof[]) {
  if (!Array.isArray(proofs) || !mintUrl) return;
  const hasBalance = proofs.some((proof) => amountToNumber((proof as any)?.amount) > 0);
  if (!hasBalance) return;
  addMintToList(mintUrl);
}
