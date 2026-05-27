import type { PaymentRequest } from "@cashu/cashu-ts";

export type IncomingPaymentRequest = {
  eventId: string;
  id?: string | null;
  token: string;
  amount: number;
  mint: string;
  unit: string;
  sender: string;
  receivedAt: number;
  fingerprint?: string | null;
};

export type ActivePaymentRequest = {
  id: string;
  encoded: string;
  request: PaymentRequest;
  amountSat?: number;
  lockPubkey?: string | null;
};

export function isSamePaymentRequest(
  a: ActivePaymentRequest | null | undefined,
  b: ActivePaymentRequest | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.encoded === b.encoded &&
    (a.lockPubkey ?? null) === (b.lockPubkey ?? null) &&
    (a.amountSat ?? null) === (b.amountSat ?? null) &&
    a.request.singleUse === b.request.singleUse
  );
}
