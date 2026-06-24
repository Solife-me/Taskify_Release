// @ts-nocheck
import { useCallback, useMemo } from "react";
import {
  DEFAULT_WALLET_DENOMINATION_DISPLAY,
  formatSatAmount as formatSatAmountValue,
  normalizeWalletDenominationDisplay,
  satInputUnitLabel as getSatInputUnitLabel,
  satUnitLabel as getSatUnitLabel,
} from "../../wallet/denomination";

export function useWalletFormatters(walletDenominationDisplay = DEFAULT_WALLET_DENOMINATION_DISPLAY) {
  const normalizedWalletDenominationDisplay = normalizeWalletDenominationDisplay(walletDenominationDisplay);
  const satFormatter = useMemo(
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    [],
  );

  const formatSatAmount = useCallback(
    (amount, options = {}) =>
      formatSatAmountValue(amount, satFormatter, normalizedWalletDenominationDisplay, options),
    [normalizedWalletDenominationDisplay, satFormatter],
  );

  const satInputUnitLabel = useMemo(
    () => getSatInputUnitLabel(normalizedWalletDenominationDisplay),
    [normalizedWalletDenominationDisplay],
  );

  const satDisplayUnitLabel = useMemo(
    () => getSatUnitLabel(normalizedWalletDenominationDisplay, "SAT"),
    [normalizedWalletDenominationDisplay],
  );

  const usdFormatterLarge = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [],
  );

  const usdFormatterSmall = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
    [],
  );

  const relativeTimeFormatter = useMemo(
    () => new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }),
    [],
  );

  return {
    formatSatAmount,
    satDisplayUnitLabel,
    satFormatter,
    satInputUnitLabel,
    usdFormatterLarge,
    usdFormatterSmall,
    relativeTimeFormatter,
    walletDenominationDisplay: normalizedWalletDenominationDisplay,
  };
}
