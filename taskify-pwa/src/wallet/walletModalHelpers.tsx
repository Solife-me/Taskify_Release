// @ts-nocheck
import { bech32 } from "bech32";
import { type ProofState } from "@cashu/cashu-ts";


import {
  extractCashuUriPayload,
  isValidCashuTokenString,
  normalizeProofAmount,
} from "./cashuProofHelpers";
import { assembleNut16FromText, containsNut16Frame } from "./nut16";
// Chat, contact and profile helpers now live in chat/chatHelpers; the wallet re-exports them.
export * from "../chat/chatHelpers";

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

export const LNURL_DECODE_LIMIT = 2048;
export const MINT_QUOTE_SUBSCRIPTION_WINDOW_MS = 60 * 60 * 1000;
export const UNPAID_MINT_QUOTE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export function extractMinibitsPaymentSender(value: string): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const match = /(?:^|\s)(?:nostr:)?(npub1[0-9a-z]{20,})\s+sent\s+you\b/i.exec(trimmed);
  return match?.[1] ?? null;
}

export function normalizeCashuTokenCandidate(value: string): string | null {
  let candidate = (value || "").trim();
  if (!candidate) return null;
  const invisibleSeparatorsPattern = new RegExp("\\u200b|\\u200c|\\u200d|\\ufeff", "g");
  candidate = candidate
    .replace(/^[("'`<‘’“”]+/, "")
    .replace(/[)"'`>‘’“”]+$/, "");
  candidate = candidate.replace(invisibleSeparatorsPattern, "").replace(/\s+/g, "");
  if (!candidate) return null;
  if (/^cashu:/i.test(candidate)) {
    candidate = extractCashuUriPayload(candidate);
    if (!candidate) return null;
    candidate = candidate.replace(invisibleSeparatorsPattern, "").replace(/\s+/g, "");
  }
  candidate = candidate.replace(/[)\]}>.,!?;:"'‘’“”`]+$/g, "");
  if (!candidate) return null;
  return isValidCashuTokenString(candidate) ? candidate : null;
}

export function extractFirstCashuTokenFromText(value: string): string | null {
  const text = value || "";
  if (!/cashu/i.test(text)) return null;

  try {
    if (containsNut16Frame(text)) {
      const assembled = assembleNut16FromText(text);
      const normalized = normalizeCashuTokenCandidate(assembled.token);
      if (normalized) return normalized;
    }
  } catch {
    // fall through to regex extraction
  }

  const matches = text.match(/cashu:[^\s]+|cashu[A-Za-z0-9_+/=-]{10,}/gi) ?? [];
  for (const match of matches) {
    const normalized = normalizeCashuTokenCandidate(match);
    if (normalized) return normalized;
  }

  // Some clients wrap long tokens across whitespace/newlines.
  const parts = text.split(/\s+/).filter(Boolean);
  const tokenChunkPattern = /^[A-Za-z0-9_+/=-]{10,}[)\]}>.,!?;:"'‘’“”`]*$/;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!/^cashu/i.test(part)) continue;
    let combined = part;
    let normalized = normalizeCashuTokenCandidate(combined);
    if (normalized) return normalized;
    for (let j = i + 1; j < parts.length && j < i + 32; j += 1) {
      const chunk = parts[j]!;
      if (!tokenChunkPattern.test(chunk)) break;
      combined += chunk;
      if (combined.length > 16_384) break;
      normalized = normalizeCashuTokenCandidate(combined);
      if (normalized) return normalized;
    }
  }
  return null;
}

type SubsetPathEntry = { prevSum: number; noteIndex: number };

export function computeSubsetSelectionInfo(
  notes: { amount: number; secret: string }[],
  target: number,
): {
  exactMatch: string[] | null;
  closestBelow: number | null;
  closestBelowSelection: string[] | null;
  closestAbove: number | null;
  closestAboveSelection: string[] | null;
} {
  const pathMap = new Map<number, SubsetPathEntry | null>();
  pathMap.set(0, null);
  notes.forEach((note, noteIndex) => {
    if (!Number.isFinite(note.amount) || note.amount <= 0) return;
    const normalizedAmount = Math.floor(note.amount);
    if (normalizedAmount <= 0) return;
    const existingSums = Array.from(pathMap.keys()).sort((a, b) => b - a);
    for (const sum of existingSums) {
      const nextSum = sum + normalizedAmount;
      if (pathMap.has(nextSum)) continue;
      pathMap.set(nextSum, { prevSum: sum, noteIndex });
    }
  });

  const positiveSums = Array.from(pathMap.keys())
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  let closestBelow: number | null = null;
  let closestAbove: number | null = null;
  for (const value of positiveSums) {
    if (value <= target) {
      closestBelow = value;
    }
    if (value >= target && closestAbove === null) {
      closestAbove = value;
    }
    if (closestBelow !== null && closestAbove !== null) {
      break;
    }
  }

  const reconstruct = (sum: number | null): string[] | null => {
    if (sum === null) return null;
    if (sum === 0) return [];
    const secrets: string[] = [];
    let current = sum;
    const seen = new Set<number>();
    while (current > 0) {
      if (seen.has(current)) {
        return null;
      }
      seen.add(current);
      const entry = pathMap.get(current);
      if (!entry) {
        return null;
      }
      const note = notes[entry.noteIndex];
      if (!note) {
        return null;
      }
      secrets.push(note.secret);
      current = entry.prevSum;
    }
    return secrets.reverse();
  };

  const exactMatch = pathMap.has(target) ? reconstruct(target) : null;

  return {
    exactMatch,
    closestBelow,
    closestBelowSelection: reconstruct(closestBelow),
    closestAbove,
    closestAboveSelection: reconstruct(closestAbove),
  };
}

export function totalForSelection(
  notes: { amount: number; secret: string }[],
  selection: string[] | null | undefined,
): number {
  if (!selection?.length) return 0;
  const amountBySecret = new Map<string, number>();
  notes.forEach((note) => {
    amountBySecret.set(note.secret, note.amount);
  });
  return selection.reduce((sum, secret) => sum + (amountBySecret.get(secret) ?? 0), 0);
}

export function decodeLnurlString(lnurl: string): string {
  try {
    const trimmed = lnurl.trim();
    const decoded = bech32.decode(trimmed.toLowerCase(), LNURL_DECODE_LIMIT);
    const bytes = bech32.fromWords(decoded.words);
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    throw new Error("Invalid LNURL");
  }
}

export type LnurlWithdrawData = {
  lnurl: string;
  callback: string;
  domain: string;
  k1: string;
  minWithdrawable: number;
  maxWithdrawable: number;
  defaultDescription?: string;
};

export type NormalizedIncomingPayment = {
  token: string;
  amount: number;
  mint: string;
  unit: string;
};

export function isMintTokenAlreadySpentError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const anyErr = err as Record<string, unknown>;
  const code = anyErr?.code;
  if (typeof code === "number" && code === 11001) {
    return true;
  }
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed) && parsed === 11001) {
      return true;
    }
  }
  const detail = typeof anyErr?.detail === "string" ? anyErr.detail.toLowerCase() : "";
  if (detail.includes("already spent")) {
    return true;
  }
  const message = typeof anyErr?.message === "string" ? anyErr.message.toLowerCase() : "";
  if (message.includes("already spent")) {
    return true;
  }
  const responseData =
    typeof anyErr?.response === "object" && anyErr?.response !== null
      ? (anyErr.response as Record<string, unknown>).data
      : null;
  if (responseData && typeof responseData === "object") {
    const dataCode = (responseData as Record<string, unknown>).code;
    if (typeof dataCode === "number" && dataCode === 11001) {
      return true;
    }
    if (typeof dataCode === "string") {
      const parsed = Number.parseInt(dataCode, 10);
      if (Number.isFinite(parsed) && parsed === 11001) {
        return true;
      }
    }
    const dataDetail = (responseData as Record<string, unknown>).detail;
    if (typeof dataDetail === "string" && dataDetail.toLowerCase().includes("already spent")) {
      return true;
    }
  }
  return false;
}

export const BACKGROUND_REFRESH_INTERVAL_MS = 300_000;
export const NPUB_CASH_REFRESH_STAGGER_MS = 20_000;
export const TOKEN_STATE_BACKGROUND_STAGGER_MS = 60_000;
export const TOKEN_STATE_BACKGROUND_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
export const SUBSCRIPTION_RETRY_DELAY_MS = 300_000;

export function buildTokenSpentToastMessage(proofs: Array<{ amount?: number | null }>): string {
  const totalSat = proofs.reduce(
    (sum, proof) => sum + normalizeProofAmount(proof.amount),
    0,
  );
  if (totalSat > 0) {
    return `sent ${totalSat} sat${totalSat === 1 ? "" : "s"}`;
  }
  const count = proofs.length;
  const tokenLabel = `ecash token${count === 1 ? "" : "s"}`;
  return `${tokenLabel} spent`;
}

export function extractWitnesses(states: ProofState[]): Record<string, string> | undefined {
  const collected: Record<string, string> = {};
  for (const entry of states) {
    if (entry.witness) {
      collected[entry.Y] = entry.witness;
    }
  }
  return Object.keys(collected).length ? collected : undefined;
}

export function shouldSuppressProofStateChecks(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const anyError = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; response?: { status?: unknown } };
  const rawStatus = typeof anyError.status === "number" ? anyError.status : typeof anyError.response?.status === "number" ? anyError.response.status : null;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const code = typeof anyError.code === "number" ? anyError.code : null;
  const name = typeof anyError.name === "string" ? anyError.name : "";
  const message = typeof anyError.message === "string" ? anyError.message : "";
  if (status === 400 || status === 404) return true;
  if (code === 11001 || code === 11002) return true;
  if (name.toLowerCase().includes("mintoperationerror")) return true;
  if (message && /unknown proof/i.test(message)) return true;
  return false;
}

