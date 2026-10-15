/**
 * Payments that answer a NUT-18 payment request arrive as a JSON payload carrying proofs.
 * Anything else that holds ecash (a cashuA/cashuB token in a DM's text, or a legacy JSON
 * wrapper around one) is a token someone pasted into a chat. With the Taskify wallet being
 * phased out, those are left unredeemed and shown with a Copy token button instead.
 */
export function isPaymentRequestPayment(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const proofs = (payload as { proofs?: unknown }).proofs;
  return Array.isArray(proofs) && proofs.length > 0;
}
