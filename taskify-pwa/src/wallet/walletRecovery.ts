/**
 * What is left in a closed Taskify wallet, as tokens any Cashu wallet can redeem. Built from the
 * stored notes, saved tokens and history alone: no mint is contacted and no Cashu SDK is loaded,
 * so recovery keeps working after the wallet code is gone (C6-2).
 *
 * Tokens use the V3 format (`cashuA`): JSON, which Cashu.me, Minibits and the other Cashu
 * wallets read.
 */
import type { PendingTokenEntry, ProofStore } from "./storage";

type StoredProof = { id?: unknown; amount?: unknown; secret?: unknown; C?: unknown; witness?: unknown; dleq?: unknown };

export type RecoverableMint = { mintUrl: string; sat: number; token: string };
export type RecoverableToken = { id: string; mintUrl: string; sat: number; token: string; label: string };

export type RecoverableFunds = {
  mints: RecoverableMint[];
  /** Tokens the wallet saved to redeem later. */
  savedTokens: RecoverableToken[];
  /** Tokens this wallet sent that nobody has claimed yet, as far as it knows. */
  sentTokens: RecoverableToken[];
  totalSat: number;
};

function amountOf(value: unknown): number {
  const amount = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A V3 (`cashuA`) token holding `proofs` from `mintUrl`. */
export function encodeCashuTokenV3(mintUrl: string, proofs: StoredProof[], unit = "sat"): string {
  const clean = proofs.map((proof) => ({
    id: String(proof.id ?? ""),
    amount: amountOf(proof.amount),
    secret: String(proof.secret ?? ""),
    C: String(proof.C ?? ""),
    ...(proof.witness !== undefined ? { witness: proof.witness } : {}),
    ...(proof.dleq !== undefined ? { dleq: proof.dleq } : {}),
  }));
  return `cashuA${base64Url(JSON.stringify({ token: [{ mint: mintUrl, proofs: clean }], unit }))}`;
}

function usableProofs(list: unknown): StoredProof[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (proof): proof is StoredProof =>
      !!proof && typeof proof === "object" && typeof (proof as StoredProof).secret === "string" &&
      typeof (proof as StoredProof).C === "string" && amountOf((proof as StoredProof).amount) > 0,
  );
}

type HistoryLike = {
  id?: unknown;
  summary?: unknown;
  direction?: unknown;
  revertToken?: unknown;
  amountSat?: unknown;
  mintUrl?: unknown;
  tokenState?: { lastState?: unknown; mintUrl?: unknown } | null;
};

export function collectRecoverableFunds(input: {
  proofStore: ProofStore | Record<string, unknown>;
  pendingTokens: PendingTokenEntry[];
  history: unknown;
}): RecoverableFunds {
  const mints: RecoverableMint[] = [];
  for (const [mintUrl, list] of Object.entries(input.proofStore)) {
    const proofs = usableProofs(list);
    const sat = proofs.reduce((sum, proof) => sum + amountOf(proof.amount), 0);
    if (sat > 0) mints.push({ mintUrl, sat, token: encodeCashuTokenV3(mintUrl, proofs) });
  }
  mints.sort((a, b) => b.sat - a.sat);

  const savedTokens: RecoverableToken[] = input.pendingTokens
    .filter((entry) => typeof entry.token === "string" && entry.token.trim())
    .map((entry) => ({
      id: entry.id,
      mintUrl: entry.mint,
      sat: amountOf(entry.amount),
      token: entry.token.trim(),
      label: "Saved token",
    }));

  const sentTokens: RecoverableToken[] = (Array.isArray(input.history) ? (input.history as HistoryLike[]) : [])
    .filter(
      (item) =>
        !!item &&
        item.direction === "out" &&
        typeof item.revertToken === "string" &&
        item.revertToken.trim() !== "" &&
        item.tokenState?.lastState !== "SPENT",
    )
    .map((item) => ({
      id: String(item.id ?? ""),
      mintUrl: String(item.tokenState?.mintUrl ?? item.mintUrl ?? ""),
      sat: amountOf(item.amountSat),
      token: (item.revertToken as string).trim(),
      label: typeof item.summary === "string" && item.summary ? item.summary : "Sent token",
    }));

  const totalSat = [...mints, ...savedTokens].reduce((sum, entry) => sum + entry.sat, 0);
  return { mints, savedTokens, sentTokens, totalSat };
}
