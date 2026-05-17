// @ts-nocheck
import { useCallback, useMemo } from "react";
import { SATS_PER_BTC } from "./useWalletPrice";

export interface UseAmountFormattersOptions {
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: string;
  setWalletPrimaryCurrency: (v: string) => void;
  btcUsdPrice: number | null;
  totalBalance: number;
  usdFormatterLarge: Intl.NumberFormat;
  usdFormatterSmall: Intl.NumberFormat;
  satFormatter: Intl.NumberFormat;
  mintAmt: string;
  lnAddrAmt: string;
  mintUrl: string;
  activeMintInvoice: any;
  lightningInvoiceAmountSat: number | null;
  mintStatus: string;
  canToggleCurrency: boolean;
}

export function useAmountFormatters({
  walletConversionEnabled,
  walletPrimaryCurrency,
  setWalletPrimaryCurrency,
  btcUsdPrice,
  totalBalance,
  usdFormatterLarge,
  usdFormatterSmall,
  satFormatter,
  mintAmt,
  lnAddrAmt,
  mintUrl,
  activeMintInvoice,
  lightningInvoiceAmountSat,
  mintStatus,
  canToggleCurrency,
}: UseAmountFormattersOptions) {
  const effectivePrimaryCurrency = walletConversionEnabled ? walletPrimaryCurrency : "sat";
  const primaryCurrency = effectivePrimaryCurrency === "usd" ? "usd" : "sat";
  const unitLabel = primaryCurrency === "usd" ? "USD" : "SAT";
  const amountInputUnitLabel = primaryCurrency === "usd" ? "USD" : "sats";
  const amountInputPlaceholder = `Amount (${amountInputUnitLabel})`;

  const usdBalance = useMemo(() => {
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    return (totalBalance / SATS_PER_BTC) * btcUsdPrice;
  }, [walletConversionEnabled, btcUsdPrice, totalBalance]);

  const formatUsdAmount = useCallback((amount: number | null) => {
    if (amount == null || !Number.isFinite(amount)) return "—";
    if (amount <= 0) return "$0.00";
    if (amount >= 1) return usdFormatterLarge.format(amount);
    return usdFormatterSmall.format(amount);
  }, [usdFormatterLarge, usdFormatterSmall]);

  const handleTogglePrimary = useCallback(() => {
    if (!walletConversionEnabled) return;
    const next = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    setWalletPrimaryCurrency(next);
  }, [walletConversionEnabled, walletPrimaryCurrency, setWalletPrimaryCurrency]);

  const parseAmountInput = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const unitLabelLocal = primaryCurrency === "usd" ? "USD" : "sats";
    if (!trimmed) {
      return { sats: 0, raw: 0 };
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    if (primaryCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        return { sats: 0, raw: numeric, error: "USD price unavailable. Try again in a moment." };
      }
      const sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return { sats: 0, raw: numeric, error: "Amount too small. Increase the USD value." };
      }
      return { sats, raw: numeric, usd: numeric };
    }
    const sats = Math.floor(numeric);
    if (sats <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    return { sats, raw: numeric };
  }, [primaryCurrency, walletConversionEnabled, btcUsdPrice]);

  const parsedMintAmount = useMemo(() => parseAmountInput(mintAmt), [parseAmountInput, mintAmt]);

  const mintAmountSecondaryDisplay = useMemo(() => {
    if (parsedMintAmount.error || parsedMintAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedMintAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedMintAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    parsedMintAmount,
    primaryCurrency,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
    formatUsdAmount,
  ]);

  const canCreateMintInvoice = useMemo(
    () => parsedMintAmount.sats > 0 && !parsedMintAmount.error && !!mintUrl,
    [parsedMintAmount, mintUrl],
  );

  const parsedLightningSendAmount = useMemo(
    () => parseAmountInput(lnAddrAmt),
    [parseAmountInput, lnAddrAmt],
  );

  const lightningSendAmountSecondaryDisplay = useMemo(() => {
    if (parsedLightningSendAmount.error || parsedLightningSendAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedLightningSendAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedLightningSendAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    parsedLightningSendAmount,
    primaryCurrency,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
    formatUsdAmount,
  ]);

  const lightningSendPrimaryAmountText = useMemo(() => {
    const trimmedAmount = lnAddrAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return `${trimmedAmount || "0"} sat`;
  }, [lnAddrAmt, primaryCurrency]);

  const lightningSendSecondaryAmountText = useMemo(() => {
    if (lightningSendAmountSecondaryDisplay) return lightningSendAmountSecondaryDisplay;
    const trimmedAmount = lnAddrAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? "sat" : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [
    lightningSendAmountSecondaryDisplay,
    lnAddrAmt,
    amountInputUnitLabel,
    canToggleCurrency,
    primaryCurrency,
  ]);

  const lightningInvoiceAmountSecondaryDisplay = useMemo(() => {
    if (lightningInvoiceAmountSat == null) return null;
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (lightningInvoiceAmountSat / SATS_PER_BTC) * btcUsdPrice;
    return formatUsdAmount(usdValue);
  }, [lightningInvoiceAmountSat, walletConversionEnabled, btcUsdPrice, formatUsdAmount]);

  const lightningPrimaryAmountText = useMemo(() => {
    const trimmedAmount = mintAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return `${trimmedAmount || "0"} sat`;
  }, [mintAmt, primaryCurrency]);

  const lightningSecondaryAmountText = useMemo(() => {
    if (mintAmountSecondaryDisplay) return mintAmountSecondaryDisplay;
    const trimmedAmount = mintAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? "sat" : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [
    amountInputUnitLabel,
    canToggleCurrency,
    mintAmt,
    mintAmountSecondaryDisplay,
    primaryCurrency,
  ]);

  const invoiceAmountSecondary = useMemo(() => {
    if (!activeMintInvoice) return null;
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (activeMintInvoice.amountSat / SATS_PER_BTC) * btcUsdPrice;
    return formatUsdAmount(usdValue);
  }, [activeMintInvoice, walletConversionEnabled, btcUsdPrice, formatUsdAmount]);

  const lightningInvoiceStatusLabel = useMemo(() => {
    switch (mintStatus) {
      case "waiting":
        return "Pending";
      case "minted":
        return "Received";
      case "error":
        return "Error";
      default:
        return "Unpaid";
    }
  }, [mintStatus]);

  return {
    primaryCurrency,
    unitLabel,
    amountInputUnitLabel,
    amountInputPlaceholder,
    usdBalance,
    formatUsdAmount,
    handleTogglePrimary,
    parseAmountInput,
    parsedMintAmount,
    mintAmountSecondaryDisplay,
    canCreateMintInvoice,
    parsedLightningSendAmount,
    lightningSendAmountSecondaryDisplay,
    lightningSendPrimaryAmountText,
    lightningSendSecondaryAmountText,
    lightningInvoiceAmountSecondaryDisplay,
    lightningPrimaryAmountText,
    lightningSecondaryAmountText,
    invoiceAmountSecondary,
    lightningInvoiceStatusLabel,
  };
}
