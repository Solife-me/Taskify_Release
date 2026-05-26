import { getDecodedToken, hashToCurve } from "@cashu/cashu-ts";
import { getCashuTokenMetadata } from "./cashuTokenMetadata";

export const HISTORY_ID_TIMESTAMP_REGEX = /(\d{10,})/;

export const PROOF_STATE_VALUES = ["UNSPENT", "PENDING", "SPENT"] as const;
export type ProofStateValue = (typeof PROOF_STATE_VALUES)[number];
export const KNOWN_PROOF_STATES = new Set<ProofStateValue>(PROOF_STATE_VALUES);

export function deriveTimestampFromId(value: string): number {
  if (typeof value !== "string" || !value) return Date.now();
  const match = value.match(HISTORY_ID_TIMESTAMP_REGEX);
  if (!match) return Date.now();
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  if (parsed >= 1_000_000_000_000) return parsed;
  return parsed * 1000;
}

export function normalizeProofAmount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Number(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
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

export function sumProofAmounts(proofs: any[]): number {
  if (!Array.isArray(proofs)) return 0;
  return proofs.reduce((sum: number, proof: any) => sum + normalizeProofAmount(proof?.amount), 0);
}

export function decodeCashuTokenLoose(token: string): any | null {
  try {
    return getDecodedToken(token, []);
  } catch {
    return null;
  }
}

export function readCashuTokenMetadata(token: string): any | null {
  try {
    return getCashuTokenMetadata(token);
  } catch {
    return null;
  }
}

export function isValidCashuTokenString(token: string): boolean {
  return !!readCashuTokenMetadata(token) || !!decodeCashuTokenLoose(token);
}

export function amountFromCashuToken(token: string): number {
  const metadata = readCashuTokenMetadata(token);
  const metadataAmount = normalizeProofAmount(metadata?.amount);
  if (metadataAmount > 0) return metadataAmount;
  const decoded = decodeCashuTokenLoose(token);
  const entries: any[] = decoded
    ? Array.isArray(decoded?.token)
      ? decoded.token
      : decoded?.proofs
        ? [decoded]
        : []
    : [];
  return entries.reduce(
    (outer, entry) => outer + sumProofAmounts(Array.isArray(entry?.proofs) ? entry.proofs : []),
    0,
  );
}

export function normalizeMintUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export function extractCashuUriPayload(raw: string): string {
  const rest = raw.replace(/^cashu:/i, "").trim();
  if (!rest) return rest;

  if (rest.startsWith("?")) {
    const params = new URLSearchParams(rest.slice(1));
    const paramCandidate =
      params.get("token") ||
      params.get("cashu") ||
      params.get("proofs") ||
      params.get("t") ||
      params.get("payment_request") ||
      params.get("request") ||
      params.get("pr");
    if (paramCandidate) {
      return paramCandidate.trim();
    }
    return rest;
  }

  const keyValueMatch = rest.match(/(?:^|[?&])(token|cashu|proofs|t|payment_request|request|pr)=([^&]+)/i);
  if (keyValueMatch?.[2]) {
    return keyValueMatch[2].trim();
  }

  if (rest.startsWith("//")) {
    const withoutScheme = rest.replace(/^\/+/, "");
    const tryParse = () => {
      const url = new URL(`https://${withoutScheme}`);
      const paramCandidate =
        url.searchParams.get("token") ||
        url.searchParams.get("cashu") ||
        url.searchParams.get("proofs") ||
        url.searchParams.get("t") ||
        url.searchParams.get("payment_request") ||
        url.searchParams.get("request") ||
        url.searchParams.get("pr");
      if (paramCandidate) {
        return paramCandidate.trim();
      }
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length) {
        return segments[segments.length - 1]!.trim();
      }
      return withoutScheme;
    };

    try {
      return tryParse();
    } catch {
      const parts = withoutScheme.split("/").filter(Boolean);
      if (parts.length) {
        return parts[parts.length - 1]!.trim();
      }
      return withoutScheme;
    }
  }

  return rest;
}

export function computeProofY(secret: string): string | null {
  try {
    if (!secret) return null;
    return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  } catch {
    return null;
  }
}

export function sanitizeProofStateValue(state: string | null | undefined): ProofStateValue | undefined {
  if (!state) return undefined;
  const normalized = state.trim().toUpperCase();
  return KNOWN_PROOF_STATES.has(normalized as ProofStateValue)
    ? (normalized as ProofStateValue)
    : undefined;
}

export function aggregateStoredProofStates(
  proofs: Array<{ lastState?: ProofStateValue }>,
): ProofStateValue | undefined {
  const values = proofs
    .map((proof) => proof.lastState)
    .filter((state): state is ProofStateValue => !!state && KNOWN_PROOF_STATES.has(state));
  if (!values.length) return undefined;
  const unique = new Set(values);
  if (unique.size === 1) {
    const [only] = Array.from(unique);
    return only;
  }
  if (unique.has("PENDING")) return "PENDING";
  if (unique.has("SPENT") && unique.has("UNSPENT")) return "PENDING";
  return undefined;
}

export function summarizeStoredProofStates(
  proofs: Array<{ lastState?: ProofStateValue }>,
): string {
  const counts = new Map<ProofStateValue, number>();
  for (const proof of proofs) {
    const state = proof.lastState;
    if (!state || !KNOWN_PROOF_STATES.has(state)) continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  if (!counts.size) return "";
  return Array.from(counts.entries())
    .map(([state, count]) => (count > 1 ? `${state} ×${count}` : state))
    .join(", ");
}
