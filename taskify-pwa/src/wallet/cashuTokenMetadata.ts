import { getDecodedToken, type Proof } from "@cashu/cashu-ts";

function amountToNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const amountLike = value as { value?: unknown; toNumber?: () => number; toNumberUnsafe?: () => number; toString?: () => string };
  if (typeof amountLike?.value === "bigint") return Number(amountLike.value);
  if (typeof amountLike?.value === "number") return Number.isFinite(amountLike.value) ? amountLike.value : 0;
  if (typeof amountLike?.toNumber === "function") return amountLike.toNumber();
  if (typeof amountLike?.toNumberUnsafe === "function") return amountLike.toNumberUnsafe();
  if (typeof amountLike?.toString === "function") {
    const parsed = Number(amountLike.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function getCashuTokenMetadata(token: string): {
  amount: number;
  incompleteProofs: Proof[];
  mint?: string;
  unit?: string;
} {
  const decoded: any = getDecodedToken(token, []);
  const entries: any[] = Array.isArray(decoded?.token)
    ? decoded.token
    : decoded?.proofs
      ? [decoded]
      : [];
  if (!entries.length) {
    throw new Error("Invalid Cashu token");
  }
  const incompleteProofs = entries.flatMap((entry) => Array.isArray(entry?.proofs) ? entry.proofs : []) as Proof[];
  const amount = incompleteProofs.reduce((sum, proof) => sum + amountToNumber((proof as any)?.amount), 0);
  const mint = entries.find((entry) => typeof entry?.mint === "string" && entry.mint)?.mint;
  const unit = entries.find((entry) => typeof entry?.unit === "string" && entry.unit)?.unit;
  return { amount, incompleteProofs, mint, unit };
}
