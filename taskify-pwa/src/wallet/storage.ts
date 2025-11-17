import type { Proof } from "@cashu/cashu-ts";

const LS_KEY = "cashu_proofs_v1";
const LS_ACTIVE_MINT = "cashu_active_mint_v1";
const LS_PENDING_TOKENS = "cashu_pending_tokens_v1";
const LS_MINT_LIST = "cashu_tracked_mints_v1";
export const DEFAULT_CASHU_MINT_URL = "<CASHU_MINT_URL>";

export type PendingTokenEntry = {
  id: string;
  mint: string;
  token: string;
  addedAt: number;
  attempts: number;
  amount?: number;
  lastTriedAt?: number;
  lastError?: string;
};

export type ProofStore = {
  [mintUrl: string]: Proof[];
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

function generatePendingTokenId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pending_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function loadStore(): ProofStore {
  return safeParse<ProofStore>(localStorage.getItem(LS_KEY), {});
}

function loadMintListRaw(): string[] {
  try {
    return safeParse<string[]>(localStorage.getItem(LS_MINT_LIST), []);
  } catch {
    return [];
  }
}

function persistMintList(urls: string[]) {
  try {
    localStorage.setItem(LS_MINT_LIST, JSON.stringify(urls));
  } catch {
    // ignore persistence errors
  }
}

function sanitizeMintList(raw: string[]): string[] {
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
  return safeParse<PendingTokenEntry[]>(localStorage.getItem(LS_PENDING_TOKENS), []);
}

function savePendingTokenEntries(entries: PendingTokenEntry[]) {
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
    });
  }
  localStorage.setItem(LS_PENDING_TOKENS, JSON.stringify(normalized));
}

export function saveStore(store: ProofStore) {
  const normalized: ProofStore = {};
  for (const [mintUrl, proofs] of Object.entries(store)) {
    if (Array.isArray(proofs)) {
      normalized[mintUrl] = proofs;
    }
  }
  localStorage.setItem(LS_KEY, JSON.stringify(normalized));
  ensureActiveMintSelection(normalized);
}

export function listPendingTokens(): PendingTokenEntry[] {
  return loadPendingTokenEntries();
}

export function addPendingToken(mintUrl: string, token: string, amount?: number): PendingTokenEntry {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const entry: PendingTokenEntry = {
    id: generatePendingTokenId(),
    mint: normalizedMint,
    token,
    addedAt: Date.now(),
    attempts: 0,
    amount: typeof amount === "number" && Number.isFinite(amount) ? amount : undefined,
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
    return localStorage.getItem(LS_ACTIVE_MINT) || DEFAULT_CASHU_MINT_URL;
  } catch {
    return DEFAULT_CASHU_MINT_URL;
  }
}

export function setActiveMint(url: string | null) {
  if (!url) localStorage.removeItem(LS_ACTIVE_MINT);
  else localStorage.setItem(LS_ACTIVE_MINT, url);
}

function normalizeMintUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

function ensureActiveMintSelection(store: ProofStore) {
  try {
    const mintsWithBalance = Object.entries(store)
      .filter(([, proofs]) => Array.isArray(proofs) && proofs.some((p) => (p?.amount ?? 0) > 0))
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
      ? (activeEntry?.[1] as Proof[]).reduce((sum, proof) => sum + (proof?.amount ?? 0), 0)
      : 0;

    if (activeBalance > 0) {
      return;
    }

    const fallbackMint = mintsWithBalance[0];
    if (fallbackMint) {
      setActiveMint(fallbackMint);
    }
  } catch {
    // noop: localStorage might be unavailable during SSR/tests
  }
}

function rememberMintFromProofs(mintUrl: string, proofs: Proof[]) {
  if (!Array.isArray(proofs) || !mintUrl) return;
  const hasBalance = proofs.some((proof) => (proof?.amount ?? 0) > 0);
  if (!hasBalance) return;
  addMintToList(mintUrl);
}
