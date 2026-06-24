import type { WalletDenominationDisplay } from "../domains/tasks/settingsTypes";

export const BITCOIN_DENOMINATION_SYMBOL = "₿";
export const DEFAULT_WALLET_DENOMINATION_DISPLAY: WalletDenominationDisplay = "bitcoin-symbol";

export type SatAmountUnitStyle = "sat" | "sats" | "SAT" | "auto";

export type FormatSatAmountOptions = {
  fallback?: string;
  sign?: string;
  unit?: SatAmountUnitStyle;
};

export function normalizeWalletDenominationDisplay(value: unknown): WalletDenominationDisplay {
  return value === "sat" ? "sat" : DEFAULT_WALLET_DENOMINATION_DISPLAY;
}

export function satInputUnitLabel(display: WalletDenominationDisplay): string {
  return display === "bitcoin-symbol" ? BITCOIN_DENOMINATION_SYMBOL : "sats";
}

export function satUnitLabel(display: WalletDenominationDisplay, fallback: "sat" | "SAT" = "SAT"): string {
  return display === "bitcoin-symbol" ? BITCOIN_DENOMINATION_SYMBOL : fallback;
}

export function formatSatAmount(
  amount: number | null | undefined,
  formatter: Intl.NumberFormat,
  display: WalletDenominationDisplay,
  options: FormatSatAmountOptions = {},
): string {
  if (amount == null || !Number.isFinite(Number(amount))) {
    return options.fallback ?? "—";
  }

  const numeric = Number(amount);
  const sign = options.sign ?? (numeric < 0 ? "-" : "");
  const absAmount = Math.abs(Math.floor(numeric));
  const formattedAmount = formatter.format(absAmount);

  if (display === "bitcoin-symbol") {
    return `${sign}${BITCOIN_DENOMINATION_SYMBOL}${formattedAmount}`;
  }

  const unit =
    options.unit === "auto"
      ? absAmount === 1
        ? "sat"
        : "sats"
      : options.unit ?? "sat";
  return `${sign}${formattedAmount} ${unit}`;
}
