// @ts-nocheck
import { useMemo } from "react";
import {
  PaymentRequestTransportType,
  type PaymentRequestTransport,
} from "@cashu/cashu-ts";
import { SATS_PER_BTC } from "./useWalletPrice";

export interface UsePaymentRequestDerivedOptions {
  paymentRequestState: any;
  info: any;
  paymentRequestManualAmount: string;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: string;
  btcUsdPrice: number | null;
  satFormatter: Intl.NumberFormat;
  formatSatAmount: (amount: number) => string;
  satInputUnitLabel: string;
}

export function usePaymentRequestDerived({
  paymentRequestState,
  info,
  paymentRequestManualAmount,
  walletConversionEnabled,
  walletPrimaryCurrency,
  btcUsdPrice,
  satFormatter,
  formatSatAmount,
  satInputUnitLabel,
}: UsePaymentRequestDerivedOptions) {
  const paymentRequestUnitLabel = useMemo(
    () => (paymentRequestState?.request.unit || info?.unit || "sat").toLowerCase(),
    [paymentRequestState?.request.unit, info?.unit],
  );

  const paymentRequestFixedAmount = useMemo(() => {
    if (!paymentRequestState) return null;
    const value = Number(paymentRequestState.request.amount);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  }, [paymentRequestState]);

  const paymentRequestHasFixedAmount = paymentRequestFixedAmount !== null;

  const canToggleCurrency = walletConversionEnabled;

  const paymentRequestInputCurrency =
    walletConversionEnabled && walletPrimaryCurrency === "usd" ? "usd" : "sat";

  const paymentRequestInputUnitLabel = paymentRequestInputCurrency === "usd" ? "USD" : satInputUnitLabel;

  const canTogglePaymentRequestCurrency = canToggleCurrency && !paymentRequestHasFixedAmount;

  const paymentRequestAmountTextValue = useMemo(() => {
    if (paymentRequestHasFixedAmount) {
      if (paymentRequestFixedAmount != null) {
        return satFormatter.format(paymentRequestFixedAmount);
      }
      return "0";
    }
    return paymentRequestManualAmount.trim() || "0";
  }, [
    paymentRequestHasFixedAmount,
    paymentRequestFixedAmount,
    paymentRequestManualAmount,
    satFormatter,
  ]);

  const paymentRequestPrimaryAmountText = useMemo(() => {
    if (paymentRequestHasFixedAmount) {
      if (paymentRequestUnitLabel === "sat" && paymentRequestFixedAmount != null) {
        return formatSatAmount(paymentRequestFixedAmount);
      }
      return `${paymentRequestAmountTextValue} ${paymentRequestUnitLabel}`;
    }
    const trimmed = paymentRequestManualAmount.trim();
    if (paymentRequestInputCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return formatSatAmount(Number(trimmed || "0"));
  }, [
    formatSatAmount,
    paymentRequestAmountTextValue,
    paymentRequestFixedAmount,
    paymentRequestHasFixedAmount,
    paymentRequestInputCurrency,
    paymentRequestManualAmount,
    paymentRequestUnitLabel,
  ]);

  const paymentRequestSecondaryAmountText = useMemo(() => {
    const unitDisplay = paymentRequestUnitLabel === "sat" ? satInputUnitLabel : paymentRequestUnitLabel;
    if (paymentRequestHasFixedAmount) {
      if (paymentRequestFixedAmount != null) {
        return paymentRequestUnitLabel === "sat"
          ? `Request requires ${formatSatAmount(paymentRequestFixedAmount)}`
          : `Request requires ${satFormatter.format(paymentRequestFixedAmount)} ${unitDisplay}`;
      }
      return `Request requires amount in ${unitDisplay}`;
    }
    const inputUnitDisplay = paymentRequestInputUnitLabel;
    const trimmed = paymentRequestManualAmount.trim();
    if (!trimmed) {
      return `Enter amount in ${inputUnitDisplay}`;
    }
    const numericAmount = Number(trimmed);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return `Enter amount in ${inputUnitDisplay}`;
    }
    if (paymentRequestInputCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        return `Enter amount in ${inputUnitDisplay}`;
      }
      const sats = Math.floor((numericAmount / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return `Enter amount in ${inputUnitDisplay}`;
      }
      return `≈ ${formatSatAmount(sats)}`;
    }
    return `Ready to send ${trimmed} ${inputUnitDisplay}`;
  }, [
    paymentRequestHasFixedAmount,
    paymentRequestManualAmount,
    paymentRequestInputCurrency,
    paymentRequestInputUnitLabel,
    paymentRequestUnitLabel,
    paymentRequestFixedAmount,
    walletConversionEnabled,
    btcUsdPrice,
    formatSatAmount,
    satInputUnitLabel,
    satFormatter,
  ]);

  const paymentRequestPrimaryTransportType = useMemo(() => {
    if (!paymentRequestState) return null;
    const request = paymentRequestState.request;
    let transports = Array.isArray((request as any)?.transport)
      ? ((request as any).transport as PaymentRequestTransport[])
      : [];
    transports = transports.filter(
      (entry): entry is PaymentRequestTransport =>
        !!entry && typeof entry.type === "string" && typeof entry.target === "string",
    );
    if (!transports.length) {
      const fallback = new Map<PaymentRequestTransportType, PaymentRequestTransport>();
      const nostr = request.getTransport(
        PaymentRequestTransportType.NOSTR,
      ) as PaymentRequestTransport | undefined;
      if (nostr) fallback.set(PaymentRequestTransportType.NOSTR, nostr);
      const post = request.getTransport(
        PaymentRequestTransportType.POST,
      ) as PaymentRequestTransport | undefined;
      if (post) fallback.set(PaymentRequestTransportType.POST, post);
      transports = [...fallback.values()];
    }
    if (!transports.length) {
      return null;
    }
    return transports[0].type;
  }, [paymentRequestState]);

  const paymentRequestActionLabel = useMemo(() => {
    switch (paymentRequestPrimaryTransportType) {
      case PaymentRequestTransportType.NOSTR:
        return "Pay via nostr";
      case PaymentRequestTransportType.POST:
        return "Pay via http";
      default:
        return "Send";
    }
  }, [paymentRequestPrimaryTransportType]);

  const canEditPaymentRequestAmount = !paymentRequestHasFixedAmount;

  const paymentRequestAmountButtonEnabled = canEditPaymentRequestAmount || canTogglePaymentRequestCurrency;

  return {
    paymentRequestUnitLabel,
    paymentRequestFixedAmount,
    paymentRequestHasFixedAmount,
    canToggleCurrency,
    paymentRequestInputCurrency,
    paymentRequestInputUnitLabel,
    canTogglePaymentRequestCurrency,
    paymentRequestAmountTextValue,
    paymentRequestPrimaryAmountText,
    paymentRequestSecondaryAmountText,
    paymentRequestPrimaryTransportType,
    paymentRequestActionLabel,
    canEditPaymentRequestAmount,
    paymentRequestAmountButtonEnabled,
  };
}
