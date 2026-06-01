import type { Proof } from "@cashu/cashu-ts";
import {
  aggregateStoredProofStates,
  computeProofY,
  decodeCashuTokenLoose,
  deriveTimestampFromId,
  extractCashuUriPayload,
  isValidCashuTokenString,
  normalizeMintUrl,
  normalizeProofAmount,
  sanitizeProofStateValue,
  type ProofStateValue,
} from "./cashuProofHelpers";
import { containsNut16Frame } from "./nut16";

export type StoredProofForState = Omit<Pick<Proof, "secret" | "amount" | "id" | "C" | "witness">, "amount"> & {
  amount: number;
  Y?: string | null;
  lastState?: ProofStateValue;
};

export interface HistoryMintQuoteInfo {
  quote: string;
  amount: number;
  request?: string;
  mintUrl?: string;
  createdAt?: number;
  expiresAt?: number;
  state?: string;
  suppressChecks?: boolean;
  lastError?: string;
  lastErrorAt?: number;
  errorCount?: number;
}

export interface HistoryTokenState {
  mintUrl: string;
  proofs: StoredProofForState[];
  lastState?: ProofStateValue;
  lastSummary?: string;
  lastCheckedAt?: number;
  lastWitnesses?: Record<string, string>;
  notifiedSpent?: boolean;
  suppressChecks?: boolean;
  lastError?: string;
  lastErrorAt?: number;
  errorCount?: number;
}

export type HistoryEntryType = "lightning" | "ecash";
export type HistoryEntryDirection = "in" | "out";
export type HistoryDetailKind = "token" | "invoice" | "note";
export type HistoryEntryKind = "bounty-attachment";
export type HistoryFilter = "all" | "pending" | "bounty";

export type HistoryStatusEntry = {
  status: "idle" | "pending" | "success" | "error";
  message?: string;
};

export type HistoryStatusMap = Record<string, HistoryStatusEntry>;

export interface HistoryItem {
  id: string;
  summary: string;
  detail?: string;
  detailKind?: HistoryDetailKind;
  revertToken?: string;
  tokenState?: HistoryTokenState;
  mintQuote?: HistoryMintQuoteInfo;
  pendingTokenId?: string;
  pendingTokenAmount?: number;
  pendingTokenMint?: string;
  pendingStatus?: "pending" | "redeemed";
  type?: HistoryEntryType;
  direction?: HistoryEntryDirection;
  amountSat?: number;
  feeSat?: number;
  mintUrl?: string;
  createdAt?: number;
  fiatValueUsd?: number;
  stateLabel?: string;
  entryKind?: HistoryEntryKind;
  relatedTaskTitle?: string;
}

export type HistoryEntryInput = Partial<HistoryItem> & {
  id?: string;
  summary: string;
};

export function markHistoryTokenStateSpent(
  tokenState: HistoryTokenState,
  timestamp: number,
): HistoryTokenState {
  const nextProofs = tokenState.proofs.map((proof) =>
    proof.lastState === "SPENT" ? proof : { ...proof, lastState: "SPENT" as const },
  );
  const nextTokenState: HistoryTokenState = {
    ...tokenState,
    proofs: nextProofs,
    lastState: "SPENT",
    lastSummary: tokenState.lastSummary || "SPENT",
    lastCheckedAt: timestamp,
    notifiedSpent: true,
    suppressChecks: true,
  };
  delete (nextTokenState as Partial<HistoryTokenState>).lastError;
  delete (nextTokenState as Partial<HistoryTokenState>).lastErrorAt;
  delete (nextTokenState as Partial<HistoryTokenState>).errorCount;
  return nextTokenState;
}

export function deriveHistoryTokenStateFromToken(token: string): HistoryTokenState | undefined {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return undefined;
  try {
    const decoded: any = decodeCashuTokenLoose(trimmed);
    if (!decoded) return undefined;
    const tokenEntries: any[] = Array.isArray(decoded?.token)
      ? decoded.token
      : decoded?.proofs
        ? [decoded]
        : [];
    for (const entry of tokenEntries) {
      const mint = typeof entry?.mint === "string" ? normalizeMintUrl(entry.mint) : null;
      const proofsRaw = Array.isArray(entry?.proofs) ? entry.proofs : [];
      const storedProofs = proofsRaw
        .map((proof: any): StoredProofForState | null => {
          if (!proof || typeof proof !== "object") return null;
          const secret = typeof proof.secret === "string" ? proof.secret : null;
          const id = typeof proof.id === "string" ? proof.id : null;
          const C = typeof proof.C === "string" ? proof.C : null;
          if (!secret || !id || !C) return null;
          const stored: StoredProofForState = {
            secret,
            id,
            C,
            amount: normalizeProofAmount(proof.amount),
          };
          if (typeof proof.witness === "string" && proof.witness) {
            stored.witness = proof.witness;
          }
          const computed = typeof proof.Y === "string" && proof.Y ? proof.Y : computeProofY(secret);
          if (computed) stored.Y = computed;
          const proofState =
            typeof proof.lastState === "string" && proof.lastState
              ? sanitizeProofStateValue(proof.lastState.toUpperCase())
              : undefined;
          if (proofState) stored.lastState = proofState;
          return stored;
        })
        .filter((proof: StoredProofForState | null): proof is StoredProofForState => !!proof);
      if (!mint || !storedProofs.length) continue;
      return {
        mintUrl: mint,
        proofs: storedProofs,
        lastState: aggregateStoredProofStates(storedProofs) ?? "UNSPENT",
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function deriveSpentHistoryTokenStateFromToken(
  token: string,
  timestamp: number,
): HistoryTokenState | undefined {
  const derived = deriveHistoryTokenStateFromToken(token);
  if (!derived) return undefined;
  return markHistoryTokenStateSpent(derived, timestamp);
}

export function isCashuTokenDetail(
  detail: string | undefined,
  detailKind?: HistoryDetailKind,
): boolean {
  if (!detail) return false;
  if (detailKind === "token") return true;
  const trimmed = detail.trim();
  if (!trimmed) return false;
  if (containsNut16Frame(trimmed)) return false;
  const candidate = extractCashuUriPayload(trimmed) || trimmed;
  if (/^cashuA:/i.test(candidate)) return false;
  if (!/^cashu[a-z0-9]/i.test(candidate)) return false;
  return isValidCashuTokenString(candidate);
}

export function parseStoredHistory(parsed: unknown): HistoryItem[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, any>;
      const { id, summary } = raw;
      if (typeof id !== "string" || typeof summary !== "string") return null;
      const normalized: HistoryItem = { id, summary };
      if (typeof raw.detail === "string" && raw.detail) {
        normalized.detail = raw.detail;
      }
      if (typeof raw.detailKind === "string") {
        const detailKind = raw.detailKind;
        if (detailKind === "token" || detailKind === "invoice" || detailKind === "note") {
          normalized.detailKind = detailKind;
        }
      }
      if (typeof raw.revertToken === "string" && raw.revertToken) {
        normalized.revertToken = raw.revertToken;
      }
      const isBountyAttachmentId = typeof id === "string" && id.startsWith("attach-bounty-");
      if (raw.entryKind === "bounty-attachment") {
        normalized.entryKind = "bounty-attachment";
      } else if (isBountyAttachmentId) {
        normalized.entryKind = "bounty-attachment";
      }
      if (typeof raw.relatedTaskTitle === "string" && raw.relatedTaskTitle.trim()) {
        normalized.relatedTaskTitle = raw.relatedTaskTitle.trim();
      }
      const typeLabel = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
      if (typeLabel === "lightning" || typeLabel === "ecash") {
        normalized.type = typeLabel;
      }
      const directionLabel = typeof raw.direction === "string" ? raw.direction.toLowerCase() : "";
      if (directionLabel === "in" || directionLabel === "out") {
        normalized.direction = directionLabel;
      }
      const amountValue = Number(raw.amountSat);
      if (Number.isFinite(amountValue) && amountValue >= 0) {
        normalized.amountSat = amountValue;
      }
      const feeValue = Number(raw.feeSat);
      if (Number.isFinite(feeValue) && feeValue >= 0) {
        normalized.feeSat = feeValue;
      }
      if (typeof raw.mintUrl === "string" && raw.mintUrl) {
        normalized.mintUrl = raw.mintUrl;
      }
      if (typeof raw.stateLabel === "string" && raw.stateLabel.trim()) {
        normalized.stateLabel = raw.stateLabel;
      }
      const createdAtValue = Number(raw.createdAt);
      normalized.createdAt =
        Number.isFinite(createdAtValue) && createdAtValue > 0
          ? createdAtValue
          : deriveTimestampFromId(id);
      const fiatValue = Number(raw.fiatValueUsd);
      if (Number.isFinite(fiatValue) && fiatValue >= 0) {
        normalized.fiatValueUsd = fiatValue;
      }
      if (typeof raw.pendingTokenId === "string" && raw.pendingTokenId) {
        normalized.pendingTokenId = raw.pendingTokenId;
      }
      const pendingAmountValue = Number(raw.pendingTokenAmount);
      if (Number.isFinite(pendingAmountValue) && pendingAmountValue > 0) {
        normalized.pendingTokenAmount = pendingAmountValue;
      }
      if (typeof raw.pendingTokenMint === "string" && raw.pendingTokenMint) {
        normalized.pendingTokenMint = raw.pendingTokenMint;
      }
      if (raw.pendingStatus === "pending" || raw.pendingStatus === "redeemed") {
        normalized.pendingStatus = raw.pendingStatus;
      }
      const rawMintQuote = raw.mintQuote;
      if (rawMintQuote && typeof rawMintQuote === "object") {
        const quoteId =
          typeof (rawMintQuote as any).quote === "string" ? (rawMintQuote as any).quote : null;
        const amount = Number((rawMintQuote as any).amount);
        if (quoteId && Number.isFinite(amount)) {
          const mintQuote: HistoryMintQuoteInfo = { quote: quoteId, amount };
          if (typeof (rawMintQuote as any).request === "string") {
            mintQuote.request = (rawMintQuote as any).request;
          }
          if (typeof (rawMintQuote as any).mintUrl === "string") {
            mintQuote.mintUrl = normalizeMintUrl((rawMintQuote as any).mintUrl);
          }
          const createdAt = Number((rawMintQuote as any).createdAt);
          if (Number.isFinite(createdAt) && createdAt > 0) {
            mintQuote.createdAt = createdAt;
          }
          const expiresAt = Number((rawMintQuote as any).expiresAt);
          if (Number.isFinite(expiresAt) && expiresAt > 0) {
            mintQuote.expiresAt = expiresAt;
          }
          if (typeof (rawMintQuote as any).state === "string") {
            mintQuote.state = (rawMintQuote as any).state;
          }
          if ((rawMintQuote as any).suppressChecks === true) {
            mintQuote.suppressChecks = true;
          }
          if (
            typeof (rawMintQuote as any).lastError === "string" &&
            (rawMintQuote as any).lastError
          ) {
            mintQuote.lastError = (rawMintQuote as any).lastError;
          }
          const mintQuoteErrorAt = Number((rawMintQuote as any).lastErrorAt);
          if (Number.isFinite(mintQuoteErrorAt) && mintQuoteErrorAt > 0) {
            mintQuote.lastErrorAt = mintQuoteErrorAt;
          }
          const mintQuoteErrorCount = Number((rawMintQuote as any).errorCount);
          if (Number.isFinite(mintQuoteErrorCount) && mintQuoteErrorCount > 0) {
            mintQuote.errorCount = mintQuoteErrorCount;
          }
          normalized.mintQuote = mintQuote;
        }
      }
      const rawTokenState = raw.tokenState;
      if (rawTokenState && typeof rawTokenState === "object") {
        const mintUrl = typeof rawTokenState.mintUrl === "string" ? rawTokenState.mintUrl : null;
        const proofsRaw = Array.isArray(rawTokenState.proofs) ? rawTokenState.proofs : [];
        if (mintUrl && proofsRaw.length) {
          const normalizedProofs = proofsRaw
            .map((proof: any): StoredProofForState | null => {
              if (!proof || typeof proof !== "object") return null;
              const secret = typeof proof.secret === "string" ? proof.secret : null;
              const proofId = typeof proof.id === "string" ? proof.id : null;
              const C = typeof proof.C === "string" ? proof.C : null;
              if (!secret || !proofId || !C) return null;
              const amount = normalizeProofAmount(proof.amount);
              const stored: StoredProofForState = { secret, id: proofId, C, amount };
              if (typeof proof.witness === "string") stored.witness = proof.witness;
              const Y = typeof proof.Y === "string" ? proof.Y : computeProofY(secret);
              if (Y) stored.Y = Y;
              const rawState =
                typeof proof.lastState === "string" ? proof.lastState.toUpperCase() : undefined;
              const normalizedState = sanitizeProofStateValue(rawState);
              if (normalizedState) {
                stored.lastState = normalizedState;
              }
              return stored;
            })
            .filter((proof: StoredProofForState | null): proof is StoredProofForState => !!proof);
          if (normalizedProofs.length) {
            const tokenState: HistoryTokenState = { mintUrl, proofs: normalizedProofs };
            if (typeof rawTokenState.lastState === "string") {
              const normalizedState = sanitizeProofStateValue(rawTokenState.lastState.toUpperCase());
              if (normalizedState) {
                tokenState.lastState = normalizedState;
              }
            }
            if (typeof rawTokenState.lastSummary === "string") {
              tokenState.lastSummary = rawTokenState.lastSummary;
            }
            if (
              typeof rawTokenState.lastCheckedAt === "number" &&
              Number.isFinite(rawTokenState.lastCheckedAt)
            ) {
              tokenState.lastCheckedAt = rawTokenState.lastCheckedAt;
            }
            if (rawTokenState.lastWitnesses && typeof rawTokenState.lastWitnesses === "object") {
              const witnessEntries = Object.entries(
                rawTokenState.lastWitnesses as Record<string, unknown>,
              ).filter((entry): entry is [string, string] => {
                const [key, value] = entry;
                return typeof key === "string" && typeof value === "string";
              });
              if (witnessEntries.length) {
                tokenState.lastWitnesses = Object.fromEntries(witnessEntries);
              }
            }
            if (rawTokenState.notifiedSpent === true) {
              tokenState.notifiedSpent = true;
            }
            if (rawTokenState.suppressChecks === true) {
              tokenState.suppressChecks = true;
            }
            if (typeof rawTokenState.lastError === "string" && rawTokenState.lastError) {
              tokenState.lastError = rawTokenState.lastError;
            }
            const tokenStateErrorAt = Number(rawTokenState.lastErrorAt);
            if (Number.isFinite(tokenStateErrorAt) && tokenStateErrorAt > 0) {
              tokenState.lastErrorAt = tokenStateErrorAt;
            }
            const tokenStateErrorCount = Number(rawTokenState.errorCount);
            if (Number.isFinite(tokenStateErrorCount) && tokenStateErrorCount > 0) {
              tokenState.errorCount = tokenStateErrorCount;
            }
            const summaryMarkedSpent =
              typeof normalized.summary === "string" && normalized.summary.includes("(spent)");
            if (summaryMarkedSpent && tokenState.lastState !== "SPENT") {
              tokenState.lastState = "SPENT";
              tokenState.lastSummary = tokenState.lastSummary ?? "SPENT";
              tokenState.suppressChecks = true;
              tokenState.notifiedSpent = true;
              tokenState.proofs = tokenState.proofs.map((proof) =>
                proof.lastState ? proof : { ...proof, lastState: "SPENT" },
              );
            }
            normalized.tokenState = tokenState;
          }
        }
      }
      if (!normalized.tokenState && typeof normalized.detail === "string" && normalized.detail.trim()) {
        const shouldInferTokenState =
          normalized.entryKind === "bounty-attachment" ||
          normalized.detailKind === "token" ||
          isCashuTokenDetail(normalized.detail, normalized.detailKind);
        if (shouldInferTokenState) {
          const inferred = deriveHistoryTokenStateFromToken(normalized.detail);
          if (inferred) {
            normalized.tokenState = inferred;
          }
        }
      }
      return normalized;
    })
    .filter((item): item is HistoryItem => !!item);
}
