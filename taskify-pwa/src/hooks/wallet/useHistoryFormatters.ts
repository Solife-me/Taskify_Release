// @ts-nocheck
import { useCallback } from "react";
import { normalizeMintUrl } from "../../wallet/cashuProofHelpers";
import type { FormatSatAmountOptions } from "../../wallet/denomination";
import { formatMintDisplayName } from "../../ui/wallet/walletModalUi";
import type { HistoryItem } from "../../wallet/walletHistoryTypes";

interface UseHistoryFormattersOptions {
  formatSatAmount: (amount: number, options?: FormatSatAmountOptions) => string;
  mintInfoByUrl: Record<string, any>;
  relativeTimeFormatter: Intl.RelativeTimeFormat;
  satFormatter: Intl.NumberFormat;
}

export function useHistoryFormatters(opts: UseHistoryFormattersOptions) {
  const { formatSatAmount, mintInfoByUrl, relativeTimeFormatter } = opts;

  const formatRelativeTime = useCallback(
    (timestamp?: number | null) => {
      if (!timestamp) return "";
      const diff = timestamp - Date.now();
      const absDiff = Math.abs(diff);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const week = 7 * day;
      const month = 30 * day;
      const year = 365 * day;
      if (absDiff < minute) {
        return relativeTimeFormatter.format(Math.round(diff / 1000), "second");
      }
      if (absDiff < hour) {
        return relativeTimeFormatter.format(Math.round(diff / minute), "minute");
      }
      if (absDiff < day) {
        return relativeTimeFormatter.format(Math.round(diff / hour), "hour");
      }
      if (absDiff < week) {
        return relativeTimeFormatter.format(Math.round(diff / day), "day");
      }
      if (absDiff < month) {
        return relativeTimeFormatter.format(Math.round(diff / week), "week");
      }
      if (absDiff < year) {
        return relativeTimeFormatter.format(Math.round(diff / month), "month");
      }
      return relativeTimeFormatter.format(Math.round(diff / year), "year");
    },
    [relativeTimeFormatter],
  );

  const formatHistoryAmount = useCallback(
    (entry: HistoryItem) => {
      if (entry.amountSat == null) return "";
      const amount = formatSatAmount(entry.amountSat);
      return entry.direction === "out" ? `(${amount})` : amount;
    },
    [formatSatAmount],
  );

  const resolveMintDisplay = useCallback(
    (entry: HistoryItem) => {
      const target =
        entry.mintUrl || entry.pendingTokenMint || entry.tokenState?.mintUrl || entry.mintQuote?.mintUrl;
      if (!target) return "";
      const normalized = normalizeMintUrl(target);
      const info = normalized ? mintInfoByUrl[normalized] : undefined;
      return info?.name || formatMintDisplayName(target);
    },
    [mintInfoByUrl],
  );

  const deriveHistoryStatus = useCallback((entry: HistoryItem) => {
    const isLightningEntry = entry.type === "lightning" || entry.detailKind === "invoice";
    const prefersReceivedLabel = isLightningEntry && entry.direction === "in";
    if (entry.pendingTokenId && entry.pendingStatus !== "redeemed") {
      return { label: "Pending redemption", tone: "pending" as const };
    }
    if (entry.tokenState) {
      if (entry.tokenState.lastState === "SPENT") {
        if (entry.direction === "in") {
          return { label: "Received", tone: "success" as const };
        }
        return { label: "Sent", tone: "success" as const };
      }
      if (entry.tokenState.lastSummary) {
        return { label: entry.tokenState.lastSummary, tone: "pending" as const };
      }
      return { label: entry.tokenState.lastState || "Pending", tone: "pending" as const };
    }
    if (entry.mintQuote) {
      const state = entry.mintQuote.state?.toLowerCase();
      if (state === "expired") {
        return { label: "Expired", tone: "danger" as const };
      }
      if (state === "paid" || state === "issued") {
        return { label: prefersReceivedLabel ? "Received" : "Paid", tone: "success" as const };
      }
      return { label: state ? state.charAt(0).toUpperCase() + state.slice(1) : "Pending", tone: "pending" as const };
    }
    if (entry.stateLabel) {
      const normalized = entry.stateLabel.toLowerCase();
      if (normalized === "expired") {
        return { label: entry.stateLabel, tone: "danger" as const };
      }
      if (normalized === "paid" || normalized === "completed") {
        return { label: prefersReceivedLabel ? "Received" : entry.stateLabel, tone: "success" as const };
      }
      return { label: entry.stateLabel, tone: undefined };
    }
    if (entry.direction === "in") {
      return { label: "Received", tone: "success" as const };
    }
    if (entry.direction === "out") {
      return { label: "Sent", tone: undefined };
    }
    return { label: "Activity", tone: undefined };
  }, []);

  return { formatRelativeTime, formatHistoryAmount, resolveMintDisplay, deriveHistoryStatus };
}
