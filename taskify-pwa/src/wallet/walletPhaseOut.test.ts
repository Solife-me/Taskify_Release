import { describe, expect, test } from "vitest";
import { isWalletRemoved, walletRemovalDate, walletScanAllowed } from "./walletPhaseOut";

describe("wallet phase-out", () => {
  test("the wallet is removed from the start of December 1, 2026, local time", () => {
    expect(walletRemovalDate()).toEqual(new Date(2026, 11, 1));
    expect(isWalletRemoved(new Date(2026, 10, 30, 23, 59))).toBe(false);
    expect(isWalletRemoved(new Date(2026, 11, 1, 0, 0))).toBe(true);
  });

  test("the scanner pays out but never takes money in", () => {
    expect(walletScanAllowed("bolt11")).toBe(true);
    expect(walletScanAllowed("lightningAddress")).toBe(true);
    expect(walletScanAllowed("lnurlPay")).toBe(true);
    expect(walletScanAllowed("paymentRequest")).toBe(true);
    expect(walletScanAllowed("ecash")).toBe(false);
    expect(walletScanAllowed("lnurlWithdraw")).toBe(false);
  });
});
