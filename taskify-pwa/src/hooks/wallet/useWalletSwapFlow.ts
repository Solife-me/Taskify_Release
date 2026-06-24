import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { SATS_PER_BTC } from "./useWalletPrice";
import type { MintEntry } from "./useMintBackup";
import type { SwapOptionMeta } from "./useMintSelection";
import type { FormatSatAmountOptions } from "../../wallet/denomination";
import type {
  HistoryEntryInput,
  HistoryItem,
} from "../../wallet/walletHistoryTypes";

export type NwcFundState = "idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error";
export type NwcWithdrawState = "idle" | "requesting" | "paying" | "done" | "error";
export type MintSwapState = "idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error";
export type SwapScenario = "mint-to-mint" | "mint-to-nwc" | "nwc-to-mint" | null;

type ParsedAmount = {
  sats: number;
  raw: number;
  error?: string;
  usd?: number;
};

type MintInvoiceQuote = {
  request: string;
  quote: string;
  mintUrl?: string;
};

type MintPaymentResult = {
  feeReserveSat?: number;
  mintUrl?: string;
  state?: string;
};

type UseWalletSwapFlowOptions = {
  amountInputUnitLabel: string;
  btcUsdPrice: number | null;
  buildHistoryEntry: (entry: HistoryEntryInput) => HistoryItem;
  checkMintQuote: (quote: string, options?: { mintUrl?: string }) => Promise<string>;
  claimMint: (quote: string, amount: number, options?: { mintUrl?: string }) => Promise<unknown>;
  closeNwcSheets: () => void;
  createMintInvoice: (
    amount: number,
    memo?: string,
    options?: { mintUrl?: string },
  ) => Promise<MintInvoiceQuote>;
  formatSatAmount: (amount: number, options?: FormatSatAmountOptions) => string;
  formatUsdAmount: (amount: number | null) => string;
  getNwcBalanceMsat: () => Promise<number | null>;
  getSwapOptionMeta: (value: string) => SwapOptionMeta;
  hasNwcConnection: boolean;
  makeNwcInvoice: (amountMsat: number, memo?: string) => Promise<{ invoice: string }>;
  mintEntriesByNormalized: Map<string, MintEntry>;
  mintSwapState: MintSwapState;
  parseAmountInput: (raw: string) => ParsedAmount;
  payMintInvoice: (invoice: string, options?: { mintUrl?: string }) => Promise<MintPaymentResult>;
  payWithNwc: (invoice: string) => Promise<unknown>;
  primaryCurrency: "usd" | "sat";
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  setMintSwapMessage: Dispatch<SetStateAction<string>>;
  setMintSwapState: Dispatch<SetStateAction<MintSwapState>>;
  setNwcFundInvoice: Dispatch<SetStateAction<string>>;
  setNwcFundMessage: Dispatch<SetStateAction<string>>;
  setNwcFundState: Dispatch<SetStateAction<NwcFundState>>;
  setNwcWithdrawInvoice: Dispatch<SetStateAction<string>>;
  setNwcWithdrawMessage: Dispatch<SetStateAction<string>>;
  setNwcWithdrawState: Dispatch<SetStateAction<NwcWithdrawState>>;
  setSwapAmount: Dispatch<SetStateAction<string>>;
  showToast: (message: string, durationMs?: number) => void;
  swapAmount: string;
  swapFromValue: string;
  swapToValue: string;
  walletConversionEnabled: boolean;
  nwcFundState: NwcFundState;
  nwcWithdrawState: NwcWithdrawState;
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function useWalletSwapFlow({
  amountInputUnitLabel,
  btcUsdPrice,
  buildHistoryEntry,
  checkMintQuote,
  claimMint,
  closeNwcSheets,
  createMintInvoice,
  formatSatAmount,
  formatUsdAmount,
  getNwcBalanceMsat,
  getSwapOptionMeta,
  hasNwcConnection,
  makeNwcInvoice,
  mintEntriesByNormalized,
  mintSwapState,
  parseAmountInput,
  payMintInvoice,
  payWithNwc,
  primaryCurrency,
  setHistory,
  setMintSwapMessage,
  setMintSwapState,
  setNwcFundInvoice,
  setNwcFundMessage,
  setNwcFundState,
  setNwcWithdrawInvoice,
  setNwcWithdrawMessage,
  setNwcWithdrawState,
  setSwapAmount,
  showToast,
  swapAmount,
  swapFromValue,
  swapToValue,
  walletConversionEnabled,
  nwcFundState,
  nwcWithdrawState,
}: UseWalletSwapFlowOptions) {
  const nwcFundInProgress =
    nwcFundState === "creating" ||
    nwcFundState === "paying" ||
    nwcFundState === "waiting" ||
    nwcFundState === "claiming";
  const nwcWithdrawInProgress =
    nwcWithdrawState === "requesting" || nwcWithdrawState === "paying";
  const mintSwapInProgress =
    mintSwapState === "creating" ||
    mintSwapState === "paying" ||
    mintSwapState === "waiting" ||
    mintSwapState === "claiming";

  const nwcFundStatusText = useMemo(() => {
    switch (nwcFundState) {
      case "creating":
        return "Creating invoice…";
      case "paying":
        return "Paying via NWC…";
      case "waiting":
        return "Waiting on mint…";
      case "claiming":
        return "Claiming ecash…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcFundState]);

  const nwcWithdrawStatusText = useMemo(() => {
    switch (nwcWithdrawState) {
      case "requesting":
        return "Requesting invoice…";
      case "paying":
        return "Paying from wallet…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcWithdrawState]);

  const swapFromIsNwc = swapFromValue === "nwc";
  const swapToIsNwc = swapToValue === "nwc";

  const swapScenario = useMemo<SwapScenario>(() => {
    if (!swapFromValue || !swapToValue) return null;
    if (swapFromValue === swapToValue) return null;
    if (swapFromIsNwc && swapToIsNwc) return null;
    if (swapFromIsNwc) return "nwc-to-mint";
    if (swapToIsNwc) return "mint-to-nwc";
    return "mint-to-mint";
  }, [swapFromIsNwc, swapFromValue, swapToIsNwc, swapToValue]);

  const parsedSwapAmount = useMemo(() => parseAmountInput(swapAmount), [parseAmountInput, swapAmount]);

  const swapPrimaryAmountText = useMemo(() => {
    const trimmed = swapAmount.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return formatSatAmount(Number(trimmed || "0"));
  }, [formatSatAmount, swapAmount, primaryCurrency]);

  const swapSecondaryAmountText = useMemo(() => {
    if (parsedSwapAmount.error || parsedSwapAmount.sats <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (primaryCurrency === "usd") {
      return `≈ ${formatSatAmount(parsedSwapAmount.sats)}`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const usdValue = (parsedSwapAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    amountInputUnitLabel,
    btcUsdPrice,
    formatSatAmount,
    formatUsdAmount,
    parsedSwapAmount,
    primaryCurrency,
    walletConversionEnabled,
  ]);

  const swapInProgress = useMemo(() => {
    if (swapScenario === "mint-to-mint") return mintSwapInProgress;
    if (swapScenario === "nwc-to-mint") return nwcFundInProgress;
    if (swapScenario === "mint-to-nwc") return nwcWithdrawInProgress;
    return false;
  }, [mintSwapInProgress, nwcFundInProgress, nwcWithdrawInProgress, swapScenario]);

  const canSubmitSwap = useMemo(() => {
    if (!swapScenario) return false;
    if (parsedSwapAmount.error || parsedSwapAmount.sats <= 0) return false;
    if (swapScenario === "mint-to-mint") {
      return mintEntriesByNormalized.has(swapFromValue) && mintEntriesByNormalized.has(swapToValue);
    }
    if (!hasNwcConnection) return false;
    const mintValue = swapScenario === "mint-to-nwc" ? swapFromValue : swapToValue;
    return !!mintValue && mintEntriesByNormalized.has(mintValue);
  }, [
    hasNwcConnection,
    mintEntriesByNormalized,
    parsedSwapAmount,
    swapFromValue,
    swapScenario,
    swapToValue,
  ]);

  const mintSwapStatusText = useMemo(() => {
    switch (mintSwapState) {
      case "creating":
        return "Creating invoice…";
      case "paying":
        return "Paying invoice…";
      case "waiting":
        return "Waiting for mint…";
      case "claiming":
        return "Claiming eCash…";
      case "done":
        return "Swap complete";
      default:
        return "";
    }
  }, [mintSwapState]);

  const handleSwapAmountKeypadInput = useCallback(
    (key: string) => {
      setSwapAmount((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          return current.slice(0, -1);
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
      if (mintSwapState === "error") {
        setMintSwapState("idle");
        setMintSwapMessage("");
      }
      if (nwcFundState === "error") {
        setNwcFundMessage("");
      }
      if (nwcWithdrawState === "error") {
        setNwcWithdrawMessage("");
      }
    },
    [
      mintSwapState,
      nwcFundState,
      nwcWithdrawState,
      primaryCurrency,
      setMintSwapMessage,
      setMintSwapState,
      setNwcFundMessage,
      setNwcWithdrawMessage,
      setSwapAmount,
    ],
  );

  const handleNwcFund = useCallback(
    async (amount: number, targetMintNormalized: string) => {
      setNwcFundMessage("");
      try {
        if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
        if (!targetMintNormalized) throw new Error("Select a receiving mint");
        const targetMintEntry = mintEntriesByNormalized.get(targetMintNormalized);
        const targetMintUrl = targetMintEntry?.url ?? targetMintNormalized;
        setNwcFundState("creating");
        const quote = await createMintInvoice(amount, `Taskify via NWC (${amount} sat)`, {
          mintUrl: targetMintUrl,
        });
        setNwcFundInvoice(quote.request);
        setNwcFundState("paying");
        await payWithNwc(quote.request);
        setNwcFundState("waiting");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
          if (state === "ISSUED") {
            throw new Error("Mint quote is already issued. Restore from wallet seed if balance is missing.");
          }
          if (state === "PAID") {
            setNwcFundState("claiming");
            await claimMint(quote.quote, amount, { mintUrl: quote.mintUrl });
            setNwcFundState("done");
            setNwcFundMessage("");
            setHistory((h) => [
              buildHistoryEntry({
                id: `nwc-fund-${Date.now()}`,
                summary: `Funded ${amount} sats via NWC`,
                detail: quote.request,
                detailKind: "invoice",
                type: "lightning",
                direction: "in",
                amountSat: amount,
                mintUrl: quote.mintUrl ?? targetMintUrl ?? undefined,
                stateLabel: "Paid",
              }),
              ...h,
            ]);
            setNwcFundInvoice("");
            await getNwcBalanceMsat().catch(() => null);
            showToast(`received ${formatSatAmount(amount)}`, 3500);
            closeNwcSheets();
            return;
          }
          await sleep(2500);
        }
        throw new Error("Mint invoice not paid yet. Try again in a moment.");
      } catch (e: any) {
        setNwcFundState("error");
        setNwcFundMessage(e?.message || String(e));
      }
    },
    [
      buildHistoryEntry,
      checkMintQuote,
      claimMint,
      closeNwcSheets,
      createMintInvoice,
      formatSatAmount,
      getNwcBalanceMsat,
      hasNwcConnection,
      mintEntriesByNormalized,
      payWithNwc,
      setHistory,
      setNwcFundInvoice,
      setNwcFundMessage,
      setNwcFundState,
      showToast,
    ],
  );

  const handleNwcWithdraw = useCallback(
    async (amount: number, sourceMintNormalized: string) => {
      setNwcWithdrawMessage("");
      try {
        if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
        if (!sourceMintNormalized) throw new Error("Select a sending mint");
        const sourceMintEntry = mintEntriesByNormalized.get(sourceMintNormalized);
        const sourceMintUrl = sourceMintEntry?.url ?? sourceMintNormalized;
        setNwcWithdrawState("requesting");
        const msat = amount * 1000;
        const invoiceRes = await makeNwcInvoice(msat, `Taskify withdrawal ${amount} sat`);
        setNwcWithdrawInvoice(invoiceRes.invoice);
        setNwcWithdrawState("paying");
        const paymentResult = await payMintInvoice(invoiceRes.invoice, { mintUrl: sourceMintUrl });
        setHistory((h) => [
          buildHistoryEntry({
            id: `nwc-withdraw-${Date.now()}`,
            summary: `Withdrew ${amount} sats via NWC`,
            detail: invoiceRes.invoice,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat: amount,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? sourceMintUrl ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
        setNwcWithdrawState("done");
        setNwcWithdrawMessage("");
        await getNwcBalanceMsat().catch(() => null);
        showToast(`sent ${formatSatAmount(amount)}`, 3500);
        closeNwcSheets();
      } catch (e: any) {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(e?.message || String(e));
      }
    },
    [
      buildHistoryEntry,
      closeNwcSheets,
      formatSatAmount,
      getNwcBalanceMsat,
      hasNwcConnection,
      makeNwcInvoice,
      mintEntriesByNormalized,
      payMintInvoice,
      setHistory,
      setNwcWithdrawInvoice,
      setNwcWithdrawMessage,
      setNwcWithdrawState,
      showToast,
    ],
  );

  const handleMintSwap = useCallback(
    async (amount: number, fromNormalized: string, toNormalized: string) => {
      setMintSwapMessage("");
      try {
        if (!fromNormalized || !toNormalized) throw new Error("Select mints for the swap");
        const fromEntry = mintEntriesByNormalized.get(fromNormalized);
        const toEntry = mintEntriesByNormalized.get(toNormalized);
        const fromUrl = fromEntry?.url ?? fromNormalized;
        const toUrl = toEntry?.url ?? toNormalized;
        setMintSwapState("creating");
        const quote = await createMintInvoice(amount, `Taskify swap ${amount} sat`, { mintUrl: toUrl });
        setMintSwapState("paying");
        const paymentResult = await payMintInvoice(quote.request, { mintUrl: fromUrl });
        setMintSwapState("waiting");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
          if (state === "ISSUED") {
            throw new Error("Mint quote is already issued. Restore from wallet seed if balance is missing.");
          }
          if (state === "PAID") {
            setMintSwapState("claiming");
            await claimMint(quote.quote, amount, { mintUrl: quote.mintUrl });
            setMintSwapState("done");
            const fromMeta = getSwapOptionMeta(fromNormalized);
            const toMeta = getSwapOptionMeta(toNormalized);
            const timestamp = Date.now();
            setHistory((h) => [
              buildHistoryEntry({
                id: `swap-out-${timestamp}`,
                summary: `Swapped ${amount} sats from ${fromMeta.label} to ${toMeta.label}`,
                detail: quote.request,
                detailKind: "invoice",
                type: "lightning",
                direction: "out",
                amountSat: amount,
                feeSat: paymentResult?.feeReserveSat ?? undefined,
                mintUrl: paymentResult?.mintUrl ?? fromUrl ?? undefined,
                stateLabel: paymentResult?.state || "Paid",
              }),
              buildHistoryEntry({
                id: `swap-in-${timestamp + 1}`,
                summary: `Received ${amount} sats on ${toMeta.label}`,
                detail: quote.request,
                detailKind: "invoice",
                type: "lightning",
                direction: "in",
                amountSat: amount,
                mintUrl: quote.mintUrl ?? toUrl ?? undefined,
                stateLabel: "Paid",
              }),
              ...h,
            ]);
            showToast(`swapped ${formatSatAmount(amount)}`, 3500);
            closeNwcSheets();
            return;
          }
          await sleep(2500);
        }
        throw new Error("Swap still pending. Try again shortly.");
      } catch (error: any) {
        setMintSwapState("error");
        setMintSwapMessage(error?.message || String(error));
      }
    },
    [
      buildHistoryEntry,
      checkMintQuote,
      claimMint,
      closeNwcSheets,
      createMintInvoice,
      formatSatAmount,
      getSwapOptionMeta,
      mintEntriesByNormalized,
      payMintInvoice,
      setHistory,
      setMintSwapMessage,
      setMintSwapState,
      showToast,
    ],
  );

  const handleSwapSubmit = useCallback(async () => {
    const scenario = swapScenario;
    if (!scenario) {
      const message = "Select swap options";
      setMintSwapState("error");
      setMintSwapMessage(message);
      if (swapFromValue === "nwc") {
        setNwcFundState("error");
        setNwcFundMessage(message);
      }
      if (swapToValue === "nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(message);
      }
      return;
    }
    const { sats: amount, error } = parseAmountInput(swapAmount);
    if (error) {
      if (scenario === "mint-to-mint") {
        setMintSwapState("error");
        setMintSwapMessage(error);
      } else if (scenario === "nwc-to-mint") {
        setNwcFundState("error");
        setNwcFundMessage(error);
      } else if (scenario === "mint-to-nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(error);
      }
      return;
    }
    if (!amount) {
      const message = `Enter amount in ${amountInputUnitLabel}`;
      if (scenario === "mint-to-mint") {
        setMintSwapState("error");
        setMintSwapMessage(message);
      } else if (scenario === "nwc-to-mint") {
        setNwcFundState("error");
        setNwcFundMessage(message);
      } else if (scenario === "mint-to-nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(message);
      }
      return;
    }

    if (scenario === "nwc-to-mint") {
      await handleNwcFund(amount, swapToValue);
      return;
    }
    if (scenario === "mint-to-nwc") {
      await handleNwcWithdraw(amount, swapFromValue);
      return;
    }
    await handleMintSwap(amount, swapFromValue, swapToValue);
  }, [
    amountInputUnitLabel,
    handleMintSwap,
    handleNwcFund,
    handleNwcWithdraw,
    parseAmountInput,
    setMintSwapMessage,
    setMintSwapState,
    setNwcFundMessage,
    setNwcFundState,
    setNwcWithdrawMessage,
    setNwcWithdrawState,
    swapAmount,
    swapFromValue,
    swapScenario,
    swapToValue,
  ]);

  return {
    canSubmitSwap,
    handleSwapAmountKeypadInput,
    handleSwapSubmit,
    mintSwapInProgress,
    mintSwapStatusText,
    nwcFundInProgress,
    nwcFundStatusText,
    nwcWithdrawInProgress,
    nwcWithdrawStatusText,
    swapInProgress,
    swapPrimaryAmountText,
    swapScenario,
    swapSecondaryAmountText,
  };
}
