import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MeltProofsResponse, Proof, ProofState } from "@cashu/cashu-ts";
import { getDecodedToken, getEncodedToken, getTokenMetadata } from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MintSession, type MintConnection, type CreateSendTokenOptions, type SendTokenLockInfo } from "../mint/MintSession";
import {
  addPendingToken,
  addMintToList,
  getActiveMint,
  listPendingTokens,
  loadStore,
  markPendingTokenAttempt,
  removePendingToken,
  setActiveMint as persistActiveMint,
  type PendingTokenEntry,
} from "../wallet/storage";
import { LS_NOSTR_SK } from "../nostrKeys";
import { useP2PK } from "./P2PKContext";
import { normalizeNostrPubkey, deriveCompressedPubkeyFromSecret } from "../lib/nostr";
import { decodeBolt11Amount } from "../wallet/lightning";
import { getWalletSeedBytes } from "../wallet/seed";
import type { MeltQuoteResponse, MintQuoteResponse } from "../wallet/cashuTypes";
import { kvStorage } from "../storage/kvStorage";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../storage/taskifyDb";

type MintInfo = {
  name?: string;
  unit?: string;
  version?: string;
};

type ReceiveTokenResult = {
  proofs: Proof[];
  usedMintUrl: string;
  activeMintUrl: string;
  crossMint: boolean;
  savedForLater: boolean;
  pendingTokenId?: string;
  pendingTokenAmount?: number;
};

type SavePendingTokenResult = {
  id: string;
  amountSat?: number;
  mintUrl: string;
  crossMint: boolean;
};

type BalanceSnapshot = {
  total: number;
  pending: number;
};

type CashuContextType = {
  ready: boolean;
  mintUrl: string;
  setMintUrl: (url: string) => Promise<void>;
  balance: number;
  totalBalance: number;
  pendingBalance: number;
  proofs: Proof[];
  info: MintInfo | null;
  createMintInvoice: (
    amount: number,
    description?: string,
    options?: { mintUrl?: string },
  ) => Promise<{
    request: string;
    quote: string;
    expiry: number;
    amount?: number;
    unit?: string;
    mintUrl: string;
  }>;
  checkMintQuote: (
    quoteId: string,
    options?: { mintUrl?: string },
  ) => Promise<"UNPAID" | "PAID" | "ISSUED">;
  claimMint: (
    quoteId: string,
    amount: number,
    options?: { mintUrl?: string },
  ) => Promise<Proof[]>;
  savePendingTokenForRedemption: (encoded: string) => Promise<SavePendingTokenResult>;
  receiveToken: (encoded: string) => Promise<ReceiveTokenResult>;
  createSendToken: (
    amount: number,
    options?: CreateSendTokenOptions & { mintUrl?: string },
  ) => Promise<{ token: string; proofs: Proof[]; mintUrl: string; lockInfo?: SendTokenLockInfo }>;
  payInvoice: (
    invoice: string,
    options?: { mintUrl?: string },
  ) => Promise<{ state: string; amountSat?: number | null; feeReserveSat?: number | null; mintUrl?: string }>;
  checkProofStates: (mintUrl: string, proofs: Proof[]) => Promise<ProofState[]>;
  subscribeProofStateUpdates: (
    mintUrl: string,
    proofs: Proof[],
    callback: (payload: ProofState & { proof: Proof }) => void,
    onError: (e: Error) => void,
  ) => Promise<() => void>;
  subscribeMintQuoteUpdates: (
    mintUrl: string,
    quoteIds: string[],
    callback: (quote: MintQuoteResponse) => void,
    onError: (e: Error) => void,
  ) => Promise<() => void>;
  createTokenFromProofSelection: (
    secrets: string[],
  ) => Promise<{ token: string; proofs: Proof[]; mintUrl: string }>;
  redeemPendingToken: (id: string) => Promise<{ proofs: Proof[]; mintUrl: string }>;
};

const globalCtxKey = "__TASKIFY_CASHU_CONTEXT__";
const globalObj: any = typeof globalThis !== "undefined" ? (globalThis as any) : {};
const CashuContext: React.Context<CashuContextType | null> =
  globalObj[globalCtxKey] ?? (globalObj[globalCtxKey] = createContext<CashuContextType | null>(null));

function isLikelyOfflineError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (!error) return false;
  const message = typeof error === "string"
    ? error.toLowerCase()
    : typeof (error as any)?.message === "string"
      ? (error as any).message.toLowerCase()
      : "";
  if (!message) return false;
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("load failed") ||
    message.includes("offline") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection")
  );
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

function deriveTokenAmount(token: string): number {
  try {
    const metadata = getTokenMetadata(token);
    return amountToNumber((metadata as any)?.amount);
  } catch {
    // fall back to a full decode for legacy tokens with full keyset ids
  }
  try {
    const decoded: any = getDecodedToken(token, []);
    if (!decoded) return 0;
    const entries: any[] = Array.isArray(decoded?.token)
      ? decoded.token
      : decoded?.proofs
        ? [decoded]
        : [];
    if (!entries.length) return 0;
    return entries.reduce((outerTotal, entry) => {
      const proofs = Array.isArray(entry?.proofs) ? entry.proofs : [];
      return (
        outerTotal +
        proofs.reduce((sum: number, proof: Proof) => {
          return sum + amountToNumber((proof as any)?.amount);
        }, 0)
      );
    }, 0);
  } catch {
    return 0;
  }
}

function isTokenAlreadySpentError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as any)?.code;
  if (typeof code === "number" && code === 11001) return true;
  if (typeof code === "string" && Number.parseInt(code, 10) === 11001) return true;

  const detail = typeof (err as any)?.detail === "string" ? (err as any).detail.toLowerCase() : "";
  if (detail.includes("already spent")) return true;

  const message = typeof (err as any)?.message === "string" ? (err as any).message.toLowerCase() : "";
  if (message.includes("already spent")) return true;

  const responseData =
    typeof (err as any)?.response === "object" && (err as any).response !== null
      ? ((err as any).response as Record<string, unknown>).data
      : null;
  if (responseData && typeof responseData === "object") {
    const dataCode = (responseData as any)?.code;
    if (typeof dataCode === "number" && dataCode === 11001) return true;
    if (typeof dataCode === "string" && Number.parseInt(dataCode, 10) === 11001) return true;
    const dataDetail = typeof (responseData as any)?.detail === "string" ? (responseData as any).detail.toLowerCase() : "";
    if (dataDetail.includes("already spent")) return true;
  }

  return false;
}

function normalizeMintUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function extractProofsForMint(token: string, mintUrl: string, decodedToken?: any): Proof[] {
  const normalizedMint = normalizeMintUrl(mintUrl);
  if (!normalizedMint) return [];
  try {
    const decoded: any = decodedToken ?? getDecodedToken(token, []);
    const entries: any[] = decoded
      ? Array.isArray(decoded?.token)
        ? decoded.token
        : decoded?.proofs
          ? [decoded]
          : []
      : [];
    return entries
      .filter((item) => normalizeMintUrl(item?.mint ?? "") === normalizedMint)
      .flatMap((item) => (Array.isArray(item?.proofs) ? item.proofs : []))
      .filter((proof): proof is Proof => !!proof && typeof proof === "object");
  } catch {
    return [];
  }
}

const LEGACY_NIP60_STATE_KEY = "cashu_nip60_state_v1";
const WALLET_P2PK_PRIVKEY_KEY = "cashu_wallet_p2pk_privkey_v1";

function deriveWalletPrivkey(seed: Uint8Array): string {
  const domainSeparator = new TextEncoder().encode("cashu-nip60-wallet");
  const combined = new Uint8Array(seed.length + domainSeparator.length);
  combined.set(seed);
  combined.set(domainSeparator, seed.length);
  return bytesToHex(sha256(combined));
}

function normalizeStoredPrivkey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;
  return trimmed;
}

function loadLegacyWalletPrivkey(): string | null {
  const direct = normalizeStoredPrivkey(idbKeyValue.getItem(TASKIFY_STORE_WALLET, WALLET_P2PK_PRIVKEY_KEY));
  if (direct) return direct;
  try {
    const rawLegacy = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LEGACY_NIP60_STATE_KEY);
    if (!rawLegacy) return null;
    const parsed = JSON.parse(rawLegacy);
    const legacy = normalizeStoredPrivkey(
      parsed && typeof parsed === "object" && parsed.wallet && typeof parsed.wallet === "object"
        ? (parsed.wallet as Record<string, unknown>).privkey as string | undefined
        : null,
    );
    if (!legacy) return null;
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, WALLET_P2PK_PRIVKEY_KEY, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function CashuProvider({ children }: { children: React.ReactNode }) {
  const [mintUrl, setMintUrlState] = useState<string>(() => getActiveMint());
  const [manager, setManager] = useState<MintConnection | null>(null);
  const [ready, setReady] = useState(false);
  const [balance, setBalance] = useState(0);
  const [balanceSnapshot, setBalanceSnapshot] = useState<BalanceSnapshot>(() => calculateBalances());
  const totalBalance = balanceSnapshot.total;
  const pendingBalance = balanceSnapshot.pending;
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [info, setInfo] = useState<MintInfo | null>(null);
  const derivedWalletPrivkeyRef = useRef<string>(deriveWalletPrivkey(getWalletSeedBytes()));
  const legacyWalletPrivkeyRef = useRef<string | null>(loadLegacyWalletPrivkey());
  const redeemingPendingRef = useRef(false);
  const mintBootPromisesRef = useRef<
    Map<
      string | null,
      Promise<{
        manager: MintConnection | null;
        balance: number;
        proofs: Proof[];
        info: MintInfo | null;
      }>
    >
  >(new Map());
  const { getPrivateKeyForPubkey: getStoredP2PKPrivkey, markKeyUsed, primaryKey } = useP2PK();

  function calculateBalances(): BalanceSnapshot {
    try {
      const store = loadStore();
      const base = Object.values(store).reduce((outerTotal, proofsForMint) => {
        if (!Array.isArray(proofsForMint)) return outerTotal;
        const mintProofs = proofsForMint as Proof[];
        const mintSum = mintProofs.reduce((sum, proof) => sum + amountToNumber((proof as any)?.amount), 0);
        return outerTotal + mintSum;
      }, 0);
      let pendingSum = 0;
      try {
        const pendingEntries = listPendingTokens();
        pendingSum = pendingEntries.reduce((sum, entry) => {
          if (typeof entry.amount === "number" && Number.isFinite(entry.amount)) {
            return sum + entry.amount;
          }
          return sum + deriveTokenAmount(entry.token);
        }, 0);
      } catch {
        pendingSum = 0;
      }
      return { total: base + pendingSum, pending: pendingSum };
    } catch {
      return { total: 0, pending: 0 };
    }
  }

  const syncActiveMintFromStorage = useCallback(() => {
    try {
      const persisted = getActiveMint();
      setMintUrlState((prev) => (prev === persisted ? prev : persisted));
    } catch {
      // ignore storage access issues
    }
  }, []);

  const getLocalP2PKPrivkey = useCallback(
    (pubkey: string) => {
      const normalizedTarget = normalizeNostrPubkey(pubkey);
      if (!normalizedTarget) return null;
      const stored = getStoredP2PKPrivkey(normalizedTarget);
      if (stored) return stored;
      const walletPrivCandidates = [
        primaryKey?.privateKey,
        legacyWalletPrivkeyRef.current ?? undefined,
        derivedWalletPrivkeyRef.current,
      ].filter(Boolean) as string[];
      for (const candidate of walletPrivCandidates) {
        const derived = deriveCompressedPubkeyFromSecret(candidate);
        if (derived && derived === normalizedTarget) {
          return candidate.toLowerCase();
        }
      }
      try {
        const raw = kvStorage.getItem(LS_NOSTR_SK) || "";
        const trimmed = raw.trim();
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          const derived = deriveCompressedPubkeyFromSecret(trimmed);
          if (derived && derived === normalizedTarget) {
            return trimmed.toLowerCase();
          }
        }
      } catch {
        // ignore
      }
      return null;
    },
    [getStoredP2PKPrivkey, primaryKey],
  );

  const refreshTotalBalance = useCallback(() => {
    setBalanceSnapshot(calculateBalances());
    syncActiveMintFromStorage();
  }, [syncActiveMintFromStorage]);

  const ensureManagerForMint = useCallback(
    async (mintUrl: string) => {
      const session = MintSession.init({
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      return session.getConnection(mintUrl);
    },
    [getLocalP2PKPrivkey, markKeyUsed],
  );

  const processPendingEntry = useCallback(
    async (entry: PendingTokenEntry) => {
      const normalizedEntryMint = entry.mint.replace(/\/$/, "");
      const activeMint = manager ? manager.mintUrl.replace(/\/$/, "") : null;
      const targetManager =
        manager && activeMint === normalizedEntryMint ? manager : await ensureManagerForMint(entry.mint);
      const tokenProofs = extractProofsForMint(entry.token, targetManager.mintUrl);
      const existingSecrets = new Set(
        targetManager.proofs
          .map((proof) => (typeof proof?.secret === "string" ? proof.secret : ""))
          .filter(Boolean),
      );
      const freshProofs = tokenProofs.filter(
        (proof) => typeof proof?.secret === "string" && !existingSecrets.has(proof.secret),
      );
      let tokenToRedeem = entry.token;
      if (freshProofs.length && freshProofs.length < tokenProofs.length) {
        tokenToRedeem = getEncodedToken({
          mint: targetManager.mintUrl,
          proofs: freshProofs,
          unit: targetManager.unit,
        });
      }
      if (tokenProofs.length && freshProofs.length === 0) {
        removePendingToken(entry.id);
        if (targetManager === manager) {
          setBalance(targetManager.balance);
          setProofs(targetManager.proofs);
        }
        refreshTotalBalance();
        return { proofs: tokenProofs, mintUrl: targetManager.mintUrl };
      }
      const receiveTokenFromEntry = async () => targetManager.receiveToken(tokenToRedeem);
      const proofs = await receiveTokenFromEntry().catch(async (error) => {
        if (!isTokenAlreadySpentError(error)) {
          throw error;
        }

        const proofsToCheck = freshProofs.length ? freshProofs : tokenProofs;
        if (!proofsToCheck.length) {
          throw error;
        }
        const states = await MintSession.checkTokenStates(normalizeMintUrl(targetManager.mintUrl), proofsToCheck);
        const spendableProofs = proofsToCheck.filter((_proof, index) => {
          const stateLabel = typeof states[index]?.state === "string" ? states[index]!.state.toUpperCase() : "";
          return stateLabel !== "SPENT";
        });
        if (!spendableProofs.length) {
          removePendingToken(entry.id);
          throw new Error("Token already spent");
        }
        const partialToken = getEncodedToken({
          mint: targetManager.mintUrl,
          proofs: spendableProofs,
          unit: targetManager.unit,
        });
        return targetManager.receiveToken(partialToken);
      });
      removePendingToken(entry.id);
      if (targetManager === manager) {
        setBalance(targetManager.balance);
        setProofs(targetManager.proofs);
      }
      refreshTotalBalance();
      return { proofs, mintUrl: targetManager.mintUrl };
    },
    [ensureManagerForMint, manager, refreshTotalBalance, setBalance, setProofs],
  );

  const redeemPendingTokens = useCallback(async () => {
    if (redeemingPendingRef.current) return;
    let entries: PendingTokenEntry[] = [];
    try {
      entries = listPendingTokens();
    } catch {
      entries = [];
    }
    if (!entries.length) return;
    redeemingPendingRef.current = true;
    try {
      for (const entry of entries) {
        try {
          await processPendingEntry(entry);
        } catch (err: any) {
          const message = err?.message ? String(err.message) : String(err ?? "");
          markPendingTokenAttempt(entry.id, message);
          if (isLikelyOfflineError(err)) {
            break;
          }
        }
      }
    } finally {
      redeemingPendingRef.current = false;
      refreshTotalBalance();
    }
  }, [processPendingEntry, refreshTotalBalance]);

  const savePendingTokenForRedemption = useCallback(
    async (rawToken: string): Promise<SavePendingTokenResult> => {
      if (!manager) throw new Error("Wallet not ready");
      const tokenInput = rawToken.trim();
      if (!tokenInput) throw new Error("Paste a Cashu token");

      let decoded: any = null;
      try {
        const metadata = getTokenMetadata(tokenInput);
        decoded = metadata ? { mint: metadata.mint, proofs: metadata.incompleteProofs, unit: metadata.unit } : null;
      } catch {
        try {
          decoded = getDecodedToken(tokenInput, []);
        } catch {
          decoded = null;
        }
      }

      const entries: any[] = decoded
        ? Array.isArray(decoded?.token)
          ? decoded.token
          : decoded?.proofs
            ? [decoded]
            : []
        : [];

      const tokenAmount = entries.length
        ? entries.reduce((outer, entry) => {
            const proofs = Array.isArray(entry?.proofs) ? entry.proofs : [];
            return (
              outer +
              proofs.reduce((sum: number, proof: Proof) => {
                return sum + amountToNumber((proof as any)?.amount);
              }, 0)
            );
          }, 0)
        : deriveTokenAmount(tokenInput);

      const selectMint = (entry: any) => (entry && typeof entry.mint === "string" ? entry.mint : null);
      const primaryMint = entries.find((entry) => selectMint(entry))?.mint ?? null;
      const activeMint = manager.mintUrl;
      const targetMintUrl = primaryMint ?? activeMint;
      if (!targetMintUrl) {
        throw new Error("Unable to determine mint for token");
      }

      const normalizedTarget = normalizeMintUrl(targetMintUrl);
      addMintToList(normalizedTarget);

      const entry = addPendingToken(targetMintUrl, tokenInput, tokenAmount || undefined);
      refreshTotalBalance();

      const crossMint = normalizeMintUrl(activeMint) !== normalizedTarget;

      return {
        id: entry.id,
        amountSat: tokenAmount || undefined,
        mintUrl: targetMintUrl,
        crossMint,
      };
    },
    [manager, refreshTotalBalance],
  );

  const redeemPendingToken = useCallback(
    async (id: string) => {
      if (redeemingPendingRef.current) {
        throw new Error("Another redemption is already in progress. Please try again shortly.");
      }
      let entry: PendingTokenEntry | undefined;
      try {
        entry = listPendingTokens().find((item) => item.id === id);
      } catch {
        entry = undefined;
      }
      if (!entry) {
        throw new Error("Saved token not found");
      }
      redeemingPendingRef.current = true;
      try {
        const res = await processPendingEntry(entry);
        setTimeout(() => {
          redeemPendingTokens().catch((err) => {
            if ((import.meta as any)?.env?.DEV) console.warn("[cashu] redeemPendingTokens failed", err);
          });
        }, 0);
        return res;
      } catch (err: any) {
        const message = err?.message ? String(err.message) : String(err ?? "");
        markPendingTokenAttempt(entry.id, message);
        throw err;
      } finally {
        redeemingPendingRef.current = false;
        refreshTotalBalance();
      }
    },
    [processPendingEntry, redeemPendingTokens, refreshTotalBalance],
  );

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setInfo(null);
    refreshTotalBalance();
    const key = mintUrl || null;

    const existing = mintBootPromisesRef.current.get(key);
    const bootPromise =
      existing ||
      (async () => {
        if (!mintUrl) {
          return { manager: null, balance: 0, proofs: [], info: null };
        }
        try {
          const session = MintSession.init({
            getP2PKPrivkey: getLocalP2PKPrivkey,
            onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
          });
          const m = await session.getConnection(mintUrl);
          const mi = await m.getMintInfo();
          return {
            manager: m,
            balance: m.balance,
            proofs: m.proofs,
            info: { name: mi?.name, unit: (mi as any)?.unit ?? "sat", version: mi?.version },
          };
        } catch (e) {
          console.error("Failed to init Cashu", e);
          return { manager: null, balance: 0, proofs: [], info: null };
        }
      })().finally(() => {
        mintBootPromisesRef.current.delete(key);
      });

    mintBootPromisesRef.current.set(key, bootPromise);

    bootPromise
      .then((result) => {
        if (cancelled) return;
        setManager(result.manager);
        setBalance(result.balance);
        setProofs(result.proofs);
        setInfo(result.info);
        refreshTotalBalance();
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [getLocalP2PKPrivkey, markKeyUsed, mintUrl, refreshTotalBalance]);

  useEffect(() => {
    redeemPendingTokens();
  }, [redeemPendingTokens, manager]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      redeemPendingTokens();
    };
    window.addEventListener("online", handler);
    return () => {
      window.removeEventListener("online", handler);
    };
  }, [redeemPendingTokens]);

  const setMintUrl = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/$/, "");
    setMintUrlState(clean);
    persistActiveMint(clean);
    if (clean) {
      addMintToList(clean);
    }
  }, []);

  const createMintInvoice = useCallback(
    async (amount: number, description?: string, options?: { mintUrl?: string }) => {
      const overrideUrl = options?.mintUrl;
      const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
      const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

      let targetManager: MintConnection | null = null;
      if (normalizedOverride) {
        if (manager && normalizedOverride === activeNormalized) {
          targetManager = manager;
        } else if (overrideUrl) {
          targetManager = await ensureManagerForMint(overrideUrl);
        }
      } else if (manager) {
        targetManager = manager;
      }

      if (!targetManager) throw new Error("Wallet not ready");

      const q = await targetManager.createMintInvoice(amount, description);
      const derivedAmount = amountToNumber(q.amount) || amount;
      const derivedUnit = (q as any)?.unit ?? (targetManager === manager ? info?.unit : targetManager.unit);
      const mintUrlValue = normalizeMintUrl(targetManager.mintUrl);
      return {
        request: q.request ?? "",
        quote: q.quote,
        expiry: q.expiry ?? 0,
        amount: derivedAmount,
        unit: derivedUnit,
        mintUrl: mintUrlValue,
      };
    },
    [ensureManagerForMint, info?.unit, manager],
  );

  const checkMintQuote = useCallback(
    async (quoteId: string, options?: { mintUrl?: string }) => {
      const overrideUrl = options?.mintUrl;
      const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
      const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

      let targetManager: MintConnection | null = null;
      if (normalizedOverride) {
        if (manager && normalizedOverride === activeNormalized) {
          targetManager = manager;
        } else if (overrideUrl) {
          targetManager = await ensureManagerForMint(overrideUrl);
        }
      } else if (manager) {
        targetManager = manager;
      }

      if (!targetManager) throw new Error("Wallet not ready");
      const q = await targetManager.checkMintQuote(quoteId);
      const state = typeof q.state === "string" ? q.state.toUpperCase() : "UNPAID";
      if (state === "PAID" || state === "ISSUED") return state;
      return "UNPAID";
    },
    [ensureManagerForMint, manager],
  );

  const claimMint = useCallback(
    async (quoteId: string, amount: number, options?: { mintUrl?: string }) => {
      const overrideUrl = options?.mintUrl;
      const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
      const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

      let targetManager: MintConnection | null = null;
      if (normalizedOverride) {
        if (manager && normalizedOverride === activeNormalized) {
          targetManager = manager;
        } else if (overrideUrl) {
          targetManager = await ensureManagerForMint(overrideUrl);
        }
      } else if (manager) {
        targetManager = manager;
      }

      if (!targetManager) throw new Error("Wallet not ready");
      const proofs = await targetManager.claimMint(quoteId, amount);
      if (targetManager === manager) {
        setBalance(targetManager.balance);
        setProofs(targetManager.proofs);
      }
      refreshTotalBalance();
      return proofs;
    },
    [ensureManagerForMint, manager, refreshTotalBalance, setBalance, setProofs],
  );

  const receiveToken = useCallback(
    async (rawToken: string) => {
      if (!manager) throw new Error("Wallet not ready");
      const tokenInput = rawToken.trim();
      if (!tokenInput) throw new Error("Paste a Cashu token");

      let decoded: any = null;
      try {
        const metadata = getTokenMetadata(tokenInput);
        decoded = metadata ? { mint: metadata.mint, proofs: metadata.incompleteProofs, unit: metadata.unit } : null;
      } catch {
        try {
          decoded = getDecodedToken(tokenInput, []);
        } catch {
          decoded = null;
        }
      }

      const entries: any[] = decoded
        ? Array.isArray(decoded?.token)
          ? decoded.token
          : decoded?.proofs
            ? [decoded]
            : []
        : [];
      const tokenAmount = entries.length
        ? entries.reduce((outer, entry) => {
            const proofs = Array.isArray(entry?.proofs) ? entry.proofs : [];
            return (
              outer +
              proofs.reduce((sum: number, proof: Proof) => {
                return sum + amountToNumber((proof as any)?.amount);
              }, 0)
            );
          }, 0)
        : deriveTokenAmount(tokenInput);
      const selectMint = (entry: any) => (entry && typeof entry.mint === "string" ? entry.mint : null);
      const primaryMint = entries.find((entry) => selectMint(entry))?.mint ?? null;
      const activeMint = normalizeMintUrl(manager.mintUrl);
      const crossMintNeeded = primaryMint && normalizeMintUrl(primaryMint) !== activeMint;

      const queueForLater = (mintUrl: string, cross: boolean): ReceiveTokenResult => {
        const entry = addPendingToken(mintUrl, tokenInput, tokenAmount || undefined);
        refreshTotalBalance();
        return {
          proofs: [],
          usedMintUrl: mintUrl,
          activeMintUrl: manager.mintUrl,
          crossMint: cross,
          savedForLater: true,
          pendingTokenId: entry.id,
          pendingTokenAmount: tokenAmount || undefined,
        };
      };

      const receiveWithManager = async (target: MintConnection, cross: boolean): Promise<ReceiveTokenResult> => {
        let decodedForTarget: any = null;
        try {
          decodedForTarget = target.decodeToken(tokenInput);
        } catch {
          decodedForTarget = null;
        }
        const tokenProofs = extractProofsForMint(tokenInput, target.mintUrl, decodedForTarget);
        const existingSecrets = new Set(
          target.proofs
            .map((proof) => (typeof proof?.secret === "string" ? proof.secret : ""))
            .filter(Boolean),
        );
        const freshProofs = tokenProofs.filter(
          (proof) => typeof proof?.secret === "string" && !existingSecrets.has(proof.secret),
        );
        let tokenToRedeem = tokenInput;
        if (freshProofs.length && freshProofs.length < tokenProofs.length) {
          tokenToRedeem = getEncodedToken({
            mint: target.mintUrl,
            proofs: freshProofs,
            unit: target.unit,
          });
        }
        if (tokenProofs.length && freshProofs.length === 0) {
          if (cross) {
            refreshTotalBalance();
          } else {
            setBalance(manager.balance);
            setProofs(manager.proofs);
            refreshTotalBalance();
          }
          redeemPendingTokens().catch((err) => {
            if ((import.meta as any)?.env?.DEV) console.warn("[cashu] redeemPendingTokens failed", err);
          });
          return {
            proofs: tokenProofs,
            usedMintUrl: target.mintUrl,
            activeMintUrl: manager.mintUrl,
            crossMint: cross,
            savedForLater: false,
          };
        }
        const proofs = await target.receiveToken(tokenToRedeem);
        if (cross) {
          refreshTotalBalance();
        } else {
          setBalance(manager.balance);
          setProofs(manager.proofs);
          refreshTotalBalance();
        }
        redeemPendingTokens().catch((err) => {
            if ((import.meta as any)?.env?.DEV) console.warn("[cashu] redeemPendingTokens failed", err);
          });
        return {
          proofs,
          usedMintUrl: target.mintUrl,
          activeMintUrl: manager.mintUrl,
          crossMint: cross,
          savedForLater: false,
        };
      };

      if (crossMintNeeded && primaryMint) {
        try {
          const other = await ensureManagerForMint(primaryMint);
          return await receiveWithManager(other, true);
        } catch (err) {
          if (isLikelyOfflineError(err)) {
            return queueForLater(primaryMint, true);
          }
          throw err;
        }
      }

      try {
        return await receiveWithManager(manager, false);
      } catch (err: any) {
        const message = err?.message?.toLowerCase?.() ?? "";
        if (message.includes("different mint") && primaryMint) {
          try {
            const other = await ensureManagerForMint(primaryMint);
            return await receiveWithManager(other, true);
          } catch (innerErr) {
            if (isLikelyOfflineError(innerErr)) {
              return queueForLater(primaryMint, true);
            }
            throw innerErr;
          }
        }
        if (isLikelyOfflineError(err)) {
          const targetMint = primaryMint ?? manager.mintUrl;
          const cross = !!primaryMint && normalizeMintUrl(primaryMint) !== activeMint;
          return queueForLater(targetMint, cross);
        }
        throw err;
      }
    },
    [manager, ensureManagerForMint, refreshTotalBalance, setBalance, setProofs, redeemPendingTokens],
  );

  const createSendToken = useCallback(async (
    amount: number,
    options?: CreateSendTokenOptions & { mintUrl?: string },
  ) => {
    const overrideUrl = options?.mintUrl;
    const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
    const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

    let targetManager: MintConnection | null = null;
    if (normalizedOverride) {
      if (manager && normalizedOverride === activeNormalized) {
        targetManager = manager;
      } else if (overrideUrl) {
        targetManager = await ensureManagerForMint(overrideUrl);
      }
    } else if (manager) {
      targetManager = manager;
    }

    if (!targetManager) throw new Error("Wallet not ready");

    const sendOptions: CreateSendTokenOptions = options ?? {};
    const res = await targetManager.createSendToken(amount, sendOptions);

    if (targetManager === manager) {
      setBalance(manager.balance);
      setProofs(manager.proofs);
    } else {
      const normalizedTarget = normalizeMintUrl(targetManager.mintUrl);
      if (normalizedTarget === activeNormalized) {
        setBalance(targetManager.balance);
        setProofs(targetManager.proofs);
      }
    }
    refreshTotalBalance();

    return { token: res.token, proofs: res.send, mintUrl: targetManager.mintUrl, lockInfo: res.lockInfo };
  }, [ensureManagerForMint, manager, refreshTotalBalance]);

  const createTokenFromProofSelection = useCallback(
    async (secrets: string[]) => {
      if (!manager) throw new Error("Wallet not ready");
      const res = await manager.createTokenFromProofSecrets(secrets);
      setBalance(manager.balance);
      setProofs(manager.proofs);
      refreshTotalBalance();
      return { token: res.token, proofs: res.send, mintUrl: manager.mintUrl };
    },
    [manager, refreshTotalBalance],
  );

  const payInvoice = useCallback(
    async (invoice: string, options?: { mintUrl?: string }) => {
      const overrideUrl = options?.mintUrl;
      const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
      const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

      let targetManager: MintConnection | null = null;
      if (normalizedOverride) {
        if (manager && normalizedOverride === activeNormalized) {
          targetManager = manager;
        } else if (overrideUrl) {
          targetManager = await ensureManagerForMint(overrideUrl);
        }
      } else if (manager) {
        targetManager = manager;
      }

      if (!targetManager) throw new Error("Wallet not ready");

      let invoiceAmountSat: number | null = null;
      try {
        const { amountMsat } = decodeBolt11Amount(invoice);
        if (amountMsat !== null) {
          if (amountMsat < 0) throw new Error("Invalid invoice amount");
          const satValue = amountMsat / 1000n;
          if (satValue > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("Invoice amount too large");
          }
          invoiceAmountSat = Number(satValue);
        }
      } catch (error) {
        console.warn("Cashu: failed to decode invoice amount", error);
        invoiceAmountSat = null;
      }

      const baseQuote = await targetManager.createMeltQuote(invoice);
      const quoteAmount = amountToNumber(baseQuote.amount);
      const quoteFeeReserve = amountToNumber(baseQuote.fee_reserve);
      const required = quoteAmount + quoteFeeReserve;
      const baseFeeReserve =
        quoteFeeReserve > 0
          ? quoteFeeReserve
          : null;
      const baseAmount =
        quoteAmount > 0
          ? quoteAmount
          : invoiceAmountSat;

      if (targetManager.balance >= required) {
        const singleResult = await targetManager.payMeltQuote(baseQuote);
        if (targetManager === manager) {
          setBalance(manager.balance);
          setProofs(manager.proofs);
        }
        refreshTotalBalance();
        return {
          state: (singleResult.quote as any)?.state ?? "",
          amountSat: invoiceAmountSat ?? baseAmount ?? null,
          feeReserveSat: baseFeeReserve,
          mintUrl: targetManager.mintUrl,
        };
      }

      if (targetManager !== manager) {
        throw new Error("Insufficient balance for selected mint");
      }

      const resolvedTotalAmount =
        invoiceAmountSat != null
          ? invoiceAmountSat
          : typeof baseQuote.amount === "number" && Number.isFinite(baseQuote.amount) && baseQuote.amount > 0
            ? baseQuote.amount
            : null;
      if (resolvedTotalAmount == null || resolvedTotalAmount <= 0) {
        throw new Error("Invoice amount must be specified for multi-mint payments");
      }

      const store = loadStore();
      const normalizedActive = normalizeMintUrl(manager.mintUrl);
      const managerCache = new Map<string, MintConnection>();
      managerCache.set(normalizedActive, manager);
      const session = MintSession.init({
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });

      const ensureManager = async (mintUrl: string) => {
        const normalized = normalizeMintUrl(mintUrl);
        if (managerCache.has(normalized)) {
          return managerCache.get(normalized)!;
        }
        const temp = await session.getConnection(mintUrl);
        managerCache.set(normalized, temp);
        return temp;
      };

      type CandidateInfo = {
        manager: MintConnection;
        balance: number;
        isActive: boolean;
        supportsMPP: boolean;
      };
      const candidates: CandidateInfo[] = [];
      const seen = new Set<string>();

      const considerMint = async (mintUrl: string) => {
        const normalized = normalizeMintUrl(mintUrl);
        if (seen.has(normalized)) return;
        try {
          const mgr = await ensureManager(mintUrl);
          const balance = mgr.balance;
          if (!balance || balance <= 0) {
            seen.add(normalized);
            return;
          }
          let supportsMPP = false;
          try {
            supportsMPP = await mgr.supportsBolt11MultiPathPayments();
          } catch {
            supportsMPP = false;
          }
          candidates.push({
            manager: mgr,
            balance,
            isActive: normalized === normalizedActive,
            supportsMPP,
          });
          seen.add(normalized);
        } catch (error) {
          console.warn("Cashu: failed to prepare manager for multi-mint payment", error);
        }
      };

      await considerMint(manager.mintUrl);
      for (const mintUrl of Object.keys(store)) {
        await considerMint(mintUrl);
      }

      if (!candidates.length) {
        throw new Error("No available mints support multi-path payments");
      }

      candidates.sort((a, b) => {
        if (a.supportsMPP && !b.supportsMPP) return -1;
        if (!a.supportsMPP && b.supportsMPP) return 1;
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return b.balance - a.balance;
      });

      let remaining = resolvedTotalAmount;
      const plans: Array<{ manager: MintConnection; quote: MeltQuoteResponse; amount: number }> = [];
      let totalFeeReserve = 0;

      for (const info of candidates) {
        if (remaining <= 0) break;
        const target = Math.min(remaining, info.balance);
        if (target <= 0) continue;
        try {
          const prepared = await info.manager.prepareMultiPathMeltQuote(invoice, target);
          if (!prepared || prepared.amount <= 0) continue;
          plans.push({ manager: info.manager, quote: prepared.quote, amount: prepared.amount });
          const feeReserve = typeof prepared.quote.fee_reserve === "number" ? prepared.quote.fee_reserve : 0;
          if (Number.isFinite(feeReserve) && feeReserve > 0) {
            totalFeeReserve += feeReserve;
          }
          remaining -= prepared.amount;
        } catch (error) {
          console.warn("Cashu: failed to prepare multi-path quote", error);
        }
      }

      if (remaining > 0) {
        throw new Error("Insufficient balance across all mints for invoice + fees");
      }

      let finalResult: MeltProofsResponse | null = null;
      for (const plan of plans) {
        const result = await plan.manager.payMeltQuote(plan.quote);
        if (plan.manager === manager) {
          setBalance(manager.balance);
          setProofs(manager.proofs);
        }
        finalResult = result;
      }

      setBalance(manager.balance);
      setProofs(manager.proofs);
      refreshTotalBalance();

      if (!finalResult) {
        throw new Error("Failed to complete multi-mint payment");
      }

      return {
        state: (finalResult.quote as any)?.state ?? "",
        amountSat: resolvedTotalAmount,
        feeReserveSat: totalFeeReserve || null,
        mintUrl: manager.mintUrl,
      };
    },
    [
      ensureManagerForMint,
      getLocalP2PKPrivkey,
      manager,
      markKeyUsed,
      refreshTotalBalance,
      setBalance,
      setProofs,
    ],
  );

  const checkProofStates = useCallback(async (targetMintUrl: string, proofsToCheck: Proof[]) => {
    const normalizedTarget = targetMintUrl.trim().replace(/\/$/, "");
    if (!normalizedTarget) throw new Error("Missing mint URL");
    MintSession.init({
      getP2PKPrivkey: getLocalP2PKPrivkey,
      onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
    });
    return MintSession.checkTokenStates(normalizedTarget, proofsToCheck);
  }, [getLocalP2PKPrivkey, markKeyUsed]);

  const subscribeProofStateUpdates = useCallback(
    async (
      targetMintUrl: string,
      proofsToSubscribe: Proof[],
      callback: (payload: ProofState & { proof: Proof }) => void,
      onError: (e: Error) => void,
    ) => {
      const normalizedTarget = targetMintUrl.trim().replace(/\/$/, "");
      if (!normalizedTarget) throw new Error("Missing mint URL");
      if (!proofsToSubscribe.length) throw new Error("No proofs to subscribe");

      MintSession.init({
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      const cancel = await MintSession.subscribeToProofState(normalizedTarget, proofsToSubscribe, callback, onError);
      return () => cancel();
    },
    [getLocalP2PKPrivkey, markKeyUsed],
  );

  const subscribeMintQuoteUpdates = useCallback(
    async (
      targetMintUrl: string,
      quoteIds: string[],
      callback: (quote: MintQuoteResponse) => void,
      onError: (e: Error) => void,
    ) => {
      const normalizedTarget = targetMintUrl.trim().replace(/\/$/, "");
      if (!normalizedTarget) throw new Error("Missing mint URL");
      if (!quoteIds.length) throw new Error("No mint quote IDs provided");

      MintSession.init({
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      const cancel = await MintSession.subscribeToQuote(normalizedTarget, quoteIds, callback, onError);
      return () => cancel();
    },
    [getLocalP2PKPrivkey, markKeyUsed],
  );

  const value = useMemo<CashuContextType>(() => ({
    ready,
    mintUrl,
    setMintUrl,
    balance,
    totalBalance,
    pendingBalance,
    proofs,
    info,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    savePendingTokenForRedemption,
    receiveToken,
    createSendToken,
    payInvoice,
    checkProofStates,
    subscribeProofStateUpdates,
    subscribeMintQuoteUpdates,
    createTokenFromProofSelection,
    redeemPendingToken,
  }), [
    ready,
    mintUrl,
    setMintUrl,
    balance,
    totalBalance,
    pendingBalance,
    proofs,
    info,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    savePendingTokenForRedemption,
    receiveToken,
    createSendToken,
    payInvoice,
    checkProofStates,
    subscribeProofStateUpdates,
    subscribeMintQuoteUpdates,
    createTokenFromProofSelection,
    redeemPendingToken,
  ]);

  return <CashuContext.Provider value={value}>{children}</CashuContext.Provider>;
}

export function useCashu() {
  const ctx = useContext(CashuContext);
  if (!ctx) throw new Error("useCashu must be used within CashuProvider");
  return ctx;
}
