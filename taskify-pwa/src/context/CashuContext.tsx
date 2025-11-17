import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MeltProofsResponse, MeltQuoteResponse, MintQuoteResponse, Proof, ProofState } from "@cashu/cashu-ts";
import { getDecodedToken } from "@cashu/cashu-ts";
import { CashuManager, type CreateSendTokenOptions, type SendTokenLockInfo } from "../wallet/CashuManager";
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
    options?: CreateSendTokenOptions,
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

const CashuContext = createContext<CashuContextType | null>(null);

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

function deriveTokenAmount(token: string): number {
  try {
    const decoded: any = getDecodedToken(token);
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
        proofs.reduce((sum, proof) => {
          const amt = typeof proof?.amount === "number" ? proof.amount : 0;
          return sum + (Number.isFinite(amt) ? amt : 0);
        }, 0)
      );
    }, 0);
  } catch {
    return 0;
  }
}

function normalizeMintUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function CashuProvider({ children }: { children: React.ReactNode }) {
  const [mintUrl, setMintUrlState] = useState<string>(() => getActiveMint());
  const [manager, setManager] = useState<CashuManager | null>(null);
  const [ready, setReady] = useState(false);
  const [balance, setBalance] = useState(0);
  const [balanceSnapshot, setBalanceSnapshot] = useState<BalanceSnapshot>(() => calculateBalances());
  const totalBalance = balanceSnapshot.total;
  const pendingBalance = balanceSnapshot.pending;
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [info, setInfo] = useState<MintInfo | null>(null);
  const redeemingPendingRef = useRef(false);
  const { getPrivateKeyForPubkey: getStoredP2PKPrivkey, markKeyUsed } = useP2PK();

  function calculateBalances(): BalanceSnapshot {
    try {
      const store = loadStore();
      const base = Object.values(store).reduce((outerTotal, proofsForMint) => {
        if (!Array.isArray(proofsForMint)) return outerTotal;
        const mintProofs = proofsForMint as Proof[];
        const mintSum = mintProofs.reduce((sum, proof) => sum + (proof?.amount || 0), 0);
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
      try {
        const raw = localStorage.getItem(LS_NOSTR_SK) || "";
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
    [getStoredP2PKPrivkey],
  );

  const refreshTotalBalance = useCallback(() => {
    setBalanceSnapshot(calculateBalances());
    syncActiveMintFromStorage();
  }, [syncActiveMintFromStorage]);

  const ensureManagerForMint = useCallback(
    async (mintUrl: string) => {
      const mgr = new CashuManager(mintUrl, {
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      await mgr.init();
      return mgr;
    },
    [getLocalP2PKPrivkey, markKeyUsed],
  );

  const processPendingEntry = useCallback(
    async (entry: PendingTokenEntry) => {
      const normalizedEntryMint = entry.mint.replace(/\/$/, "");
      const activeMint = manager ? manager.mintUrl.replace(/\/$/, "") : null;
      const targetManager =
        manager && activeMint === normalizedEntryMint ? manager : await ensureManagerForMint(entry.mint);
      const proofs = await targetManager.receiveToken(entry.token);
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
        decoded = getDecodedToken(tokenInput);
      } catch {
        decoded = null;
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
              proofs.reduce((sum, proof) => {
                const amt = typeof proof?.amount === "number" ? proof.amount : 0;
                return sum + (Number.isFinite(amt) ? amt : 0);
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
          redeemPendingTokens().catch(() => {});
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
    async function boot() {
      setReady(false);
      setInfo(null);
      refreshTotalBalance();
      if (!mintUrl) {
        setManager(null);
        setBalance(0);
        setProofs([]);
        setReady(true);
        return;
      }
      try {
        const m = new CashuManager(mintUrl, {
          getP2PKPrivkey: getLocalP2PKPrivkey,
          onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
        });
        await m.init();
        if (cancelled) return;
        setManager(m);
        setBalance(m.balance);
        setProofs(m.proofs);
        const mi = await m.wallet.getMintInfo();
        setInfo({ name: mi?.name, unit: (mi as any)?.unit ?? "sat", version: mi?.version });
        refreshTotalBalance();
      } catch (e) {
        console.error("Failed to init Cashu", e);
        setManager(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    boot();
    return () => { cancelled = true; };
  }, [mintUrl, refreshTotalBalance, getLocalP2PKPrivkey, markKeyUsed]);

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

      let targetManager: CashuManager | null = null;
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
      const derivedAmount = typeof q.amount === "number" ? q.amount : amount;
      const derivedUnit = (q as any)?.unit ?? (targetManager === manager ? info?.unit : targetManager.unit);
      const mintUrlValue = normalizeMintUrl(targetManager.mintUrl);
      return {
        request: q.request,
        quote: q.quote,
        expiry: q.expiry,
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

      let targetManager: CashuManager | null = null;
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
      return q.state;
    },
    [ensureManagerForMint, manager],
  );

  const claimMint = useCallback(
    async (quoteId: string, amount: number, options?: { mintUrl?: string }) => {
      const overrideUrl = options?.mintUrl;
      const normalizedOverride = overrideUrl ? normalizeMintUrl(overrideUrl) : null;
      const activeNormalized = manager ? normalizeMintUrl(manager.mintUrl) : null;

      let targetManager: CashuManager | null = null;
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
        decoded = getDecodedToken(tokenInput);
      } catch {
        decoded = null;
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
              proofs.reduce((sum, proof) => {
                const amt = typeof proof?.amount === "number" ? proof.amount : 0;
                return sum + (Number.isFinite(amt) ? amt : 0);
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

      const receiveWithManager = async (target: CashuManager, cross: boolean): Promise<ReceiveTokenResult> => {
        const proofs = await target.receiveToken(tokenInput);
        if (cross) {
          refreshTotalBalance();
        } else {
          setBalance(manager.balance);
          setProofs(manager.proofs);
          refreshTotalBalance();
        }
        redeemPendingTokens().catch(() => {});
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
    options?: CreateSendTokenOptions,
  ) => {
    if (!manager) throw new Error("Wallet not ready");
    const res = await manager.createSendToken(amount, options);
    setBalance(manager.balance);
    setProofs(manager.proofs);
    refreshTotalBalance();
    return { token: res.token, proofs: res.send, mintUrl: manager.mintUrl, lockInfo: res.lockInfo };
  }, [manager, refreshTotalBalance]);

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

      let targetManager: CashuManager | null = null;
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
      const required = (baseQuote.amount || 0) + (baseQuote.fee_reserve || 0);
      const baseFeeReserve =
        typeof baseQuote.fee_reserve === "number" && Number.isFinite(baseQuote.fee_reserve)
          ? baseQuote.fee_reserve
          : null;
      const baseAmount =
        typeof baseQuote.amount === "number" && Number.isFinite(baseQuote.amount)
          ? baseQuote.amount
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
      const managerCache = new Map<string, CashuManager>();
      managerCache.set(normalizedActive, manager);

      const ensureManager = async (mintUrl: string) => {
        const normalized = normalizeMintUrl(mintUrl);
        if (managerCache.has(normalized)) {
          return managerCache.get(normalized)!;
        }
        const temp = new CashuManager(mintUrl, {
          getP2PKPrivkey: getLocalP2PKPrivkey,
          onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
        });
        await temp.init();
        managerCache.set(normalized, temp);
        return temp;
      };

      type CandidateInfo = {
        manager: CashuManager;
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
      const plans: Array<{ manager: CashuManager; quote: MeltQuoteResponse; amount: number }> = [];
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
    const activeNormalized = manager ? manager.mintUrl.replace(/\/$/, "") : "";
    if (manager && normalizedTarget === activeNormalized) {
      return manager.checkProofStates(proofsToCheck);
    }
    const temp = new CashuManager(normalizedTarget, {
      getP2PKPrivkey: getLocalP2PKPrivkey,
      onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
    });
    await temp.init();
    return temp.checkProofStates(proofsToCheck);
  }, [manager, getLocalP2PKPrivkey, markKeyUsed]);

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

      const ensureSubscription = async (mgr: CashuManager) => {
        const supported = await mgr.supportsProofStateSubscriptions();
        if (!supported) {
          throw new Error("Mint does not support proof_state subscriptions");
        }
        return mgr.subscribeProofStateUpdates(proofsToSubscribe, callback, onError);
      };

      const activeNormalized = manager ? manager.mintUrl.replace(/\/$/, "") : "";
      if (manager && normalizedTarget === activeNormalized) {
        return ensureSubscription(manager);
      }

      const temp = new CashuManager(normalizedTarget, {
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      await temp.init();
      const cancel = await ensureSubscription(temp);
      return () => {
        cancel();
      };
    },
    [manager, getLocalP2PKPrivkey, markKeyUsed],
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

      const ensureSubscription = async (mgr: CashuManager) => {
        const supported = await mgr.supportsMintQuoteSubscriptions();
        if (!supported) {
          throw new Error("Mint does not support mint quote subscriptions");
        }
        return mgr.subscribeMintQuoteUpdates(quoteIds, callback, onError);
      };

      const activeNormalized = manager ? manager.mintUrl.replace(/\/$/, "") : "";
      if (manager && normalizedTarget === activeNormalized) {
        return ensureSubscription(manager);
      }

      const temp = new CashuManager(normalizedTarget, {
        getP2PKPrivkey: getLocalP2PKPrivkey,
        onP2PKUsage: (pubkey, count) => markKeyUsed(pubkey, count),
      });
      await temp.init();
      const cancel = await ensureSubscription(temp);
      return () => {
        cancel();
      };
    },
    [manager, getLocalP2PKPrivkey, markKeyUsed],
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
