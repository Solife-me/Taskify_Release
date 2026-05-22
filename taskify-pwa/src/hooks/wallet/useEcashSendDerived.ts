// @ts-nocheck
import { useMemo } from "react";
import { SATS_PER_BTC } from "./useWalletPrice";

export function useEcashSendDerived({
  parseAmountInput,
  formatUsdAmount,
  primaryCurrency,
  amountInputUnitLabel,
  usdBalance,
  sendAmt,
  sendTokenStr,
  lastSendTokenFingerprint,
  lockSendToPubkey,
  sendLockPubkeyInput,
  satFormatter,
  usdFormatterLarge,
  btcUsdPrice,
  walletConversionEnabled,
  mintUrl,
  priceStatus,
  priceUpdatedAt,
  totalBalance,
  pendingBalance,
  scannerMessage,
  normalizeNostrPubkey,
}) {
  const normalizedSendLockPubkey = useMemo(() => {
    if (!lockSendToPubkey) return null;
    return normalizeNostrPubkey(sendLockPubkeyInput);
  }, [lockSendToPubkey, sendLockPubkeyInput]);

  const parsedSendAmount = useMemo(() => parseAmountInput(sendAmt), [parseAmountInput, sendAmt]);

  const currentSendTokenFingerprint = useMemo(() => {
    const parsed = parsedSendAmount;
    if (parsed.error || parsed.sats <= 0) return null;
    if (lockSendToPubkey) {
      if (!normalizedSendLockPubkey) return null;
      return `${parsed.sats}|p2pk:${normalizedSendLockPubkey}`;
    }
    return `${parsed.sats}|standard`;
  }, [lockSendToPubkey, normalizedSendLockPubkey, parsedSendAmount]);

  const tokenAlreadyCreatedForAmount = useMemo(() => {
    if (!sendTokenStr || !lastSendTokenFingerprint || !currentSendTokenFingerprint) return false;
    return lastSendTokenFingerprint === currentSendTokenFingerprint;
  }, [currentSendTokenFingerprint, lastSendTokenFingerprint, sendTokenStr]);

  const ecashPrimaryAmountText = useMemo(() => {
    const trimmed = sendAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return `${trimmed || "0"} sat`;
  }, [primaryCurrency, sendAmt]);

  const ecashSecondaryAmountText = useMemo(() => {
    if (parsedSendAmount.error || parsedSendAmount.sats <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedSendAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const usdValue = (parsedSendAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    amountInputUnitLabel,
    btcUsdPrice,
    formatUsdAmount,
    parsedSendAmount,
    primaryCurrency,
    satFormatter,
    walletConversionEnabled,
  ]);

  const canCreateSendTokenAmount = useMemo(
    () => parsedSendAmount.sats > 0 && !parsedSendAmount.error && !!mintUrl,
    [parsedSendAmount, mintUrl],
  );

  const primaryAmountDisplay = useMemo(() => {
    if (primaryCurrency === "usd") {
      if (usdBalance == null) {
        if (!walletConversionEnabled) return "$0.00";
        return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
      }
      return formatUsdAmount(usdBalance);
    }
    return `${satFormatter.format(Math.max(0, Math.floor(totalBalance)))} sat`;
  }, [primaryCurrency, usdBalance, walletConversionEnabled, priceStatus, formatUsdAmount, satFormatter, totalBalance]);

  const secondaryAmountDisplay = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(Math.max(0, Math.floor(totalBalance)))} sat`;
    }
    if (usdBalance == null) {
      return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
    }
    return `≈ ${formatUsdAmount(usdBalance)}`;
  }, [walletConversionEnabled, primaryCurrency, satFormatter, totalBalance, usdBalance, priceStatus, formatUsdAmount]);

  const priceMeta = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (btcUsdPrice == null || btcUsdPrice <= 0) {
      return priceStatus === "error" ? "BTC/USD price unavailable" : "Fetching BTC/USD price…";
    }
    const base = `${usdFormatterLarge.format(btcUsdPrice)} / BTC`;
    if (priceStatus === "error") {
      return `${base} • Using last update`;
    }
    if (priceUpdatedAt) {
      const timeStr = new Date(priceUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${base} • Updated ${timeStr}`;
    }
    return base;
  }, [walletConversionEnabled, btcUsdPrice, priceStatus, priceUpdatedAt, usdFormatterLarge]);

  const pendingBalanceDisplay = useMemo(() => {
    if (pendingBalance <= 0) return null;
    const pendingSat = Math.max(0, Math.floor(pendingBalance));
    return `${satFormatter.format(pendingSat)} sat pending redemption`;
  }, [pendingBalance, satFormatter]);

  const scannerMessageTone = useMemo(() => {
    if (!scannerMessage) return "info";
    return /denied|unsupported|not supported|unrecognized|error|unable/i.test(scannerMessage) ? "error" : "info";
  }, [scannerMessage]);

  return {
    normalizedSendLockPubkey,
    parsedSendAmount,
    currentSendTokenFingerprint,
    tokenAlreadyCreatedForAmount,
    ecashPrimaryAmountText,
    ecashSecondaryAmountText,
    canCreateSendTokenAmount,
    primaryAmountDisplay,
    secondaryAmountDisplay,
    priceMeta,
    pendingBalanceDisplay,
    scannerMessageTone,
  };
}
