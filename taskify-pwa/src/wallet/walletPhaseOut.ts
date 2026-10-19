/**
 * The Taskify wallet's phase-out rules, shared by the wallet UI and the phase-out notice.
 *
 * Until the removal date the wallet is withdraw-only: money already in it, or already owed to it
 * (npub.cash claims, paid payment requests, pending quotes), can be moved out; nothing new comes
 * in. From the removal date the wallet is replaced by a recovery view (C6-2).
 */

/** The wallet's last day is the day before; from this date only recovery remains. */
export const WALLET_REMOVAL_DATE_ISO = "2026-12-01";

export function walletRemovalDate(): Date {
  // Local midnight, so the change happens at the start of the day wherever the user is.
  const [year, month, day] = WALLET_REMOVAL_DATE_ISO.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function walletRemovalDateLabel(locale?: string): string {
  return walletRemovalDate().toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}

/** Whether the full wallet has been replaced by the recovery view. */
export function isWalletRemoved(now: Date = new Date()): boolean {
  return now.getTime() >= walletRemovalDate().getTime();
}

/** Codes the wallet's scanner may act on. Anything that would bring money in is refused. */
export type WalletScanKind = "ecash" | "bolt11" | "lightningAddress" | "lnurlPay" | "lnurlWithdraw" | "paymentRequest";

export function walletScanAllowed(kind: WalletScanKind): boolean {
  return kind !== "ecash" && kind !== "lnurlWithdraw";
}

export const WALLET_NO_INCOMING_MESSAGE =
  "The Taskify wallet no longer takes in new funds. Copy this into another Cashu or Lightning wallet instead.";
