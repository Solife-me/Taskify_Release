// @ts-nocheck
import { useCallback } from "react";
import { SATS_PER_BTC } from "./useWalletPrice";

export type LightningSendInputKind = "empty" | "invoice" | "address" | "lnurl" | "unknown";

interface UseAmountKeypadHandlersOptions {
  activeMintInvoice: any;
  btcUsdPrice: number | null;
  canToggleCurrency: boolean;
  canTogglePaymentRequestCurrency: boolean;
  commitLightningInputFromDom: () => string;
  handleTogglePrimary: () => void;
  mintQuote: any;
  npubCashIdentity: { address?: string } | null;
  parsedMintAmount: { sats: number; error?: string };
  paymentRequestInputCurrency: "usd" | "sat";
  paymentRequestManualAmount: string;
  primaryCurrency: "usd" | "sat";
  refreshMintEntries: () => void;
  resetLightningInvoiceState: () => void;
  setEcashReceiveView: (view: string) => void;
  setEcashRequestAmt: React.Dispatch<React.SetStateAction<string>>;
  setEcashSendView: (view: string) => void;
  setLastCreatedEcashRequest: (req: any) => void;
  setLightningAddressCopied: (copied: boolean) => void;
  setLightningReceiveView: (view: string) => void;
  setLightningSendView: (view: string) => void;
  setLnAddrAmt: (amt: string) => void;
  setLnError: (err: string) => void;
  setLnInput: (input: string) => void;
  setLnState: (state: string) => void;
  setMintAmt: React.Dispatch<React.SetStateAction<string>>;
  setMintError: (err: string) => void;
  setPaymentRequestError: (err: string) => void;
  setPaymentRequestManualAmount: React.Dispatch<React.SetStateAction<string>>;
  setEcashRequestMode: (mode: string) => void;
  setRecvMsg: (msg: string) => void;
  setSendAmt: React.Dispatch<React.SetStateAction<string>>;
  setSendLockError: (err: string) => void;
  showToast: (msg: string, ms?: number) => void;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: string;
}

export function useAmountKeypadHandlers(opts: UseAmountKeypadHandlersOptions) {
  const {
    activeMintInvoice,
    btcUsdPrice,
    canToggleCurrency,
    canTogglePaymentRequestCurrency,
    commitLightningInputFromDom,
    handleTogglePrimary,
    mintQuote,
    npubCashIdentity,
    parsedMintAmount,
    paymentRequestInputCurrency,
    paymentRequestManualAmount,
    primaryCurrency,
    refreshMintEntries,
    resetLightningInvoiceState,
    setEcashReceiveView,
    setEcashRequestAmt,
    setEcashRequestMode,
    setEcashSendView,
    setLastCreatedEcashRequest,
    setLightningAddressCopied,
    setLightningReceiveView,
    setLightningSendView,
    setLnAddrAmt,
    setLnError,
    setLnInput,
    setLnState,
    setMintAmt,
    setMintError,
    setPaymentRequestError,
    setPaymentRequestManualAmount,
    setRecvMsg,
    setSendAmt,
    setSendLockError,
    showToast,
    walletConversionEnabled,
    walletPrimaryCurrency,
  } = opts;

  const handleCopyLightningAddress = useCallback(async () => {
    const address = npubCashIdentity?.address;
    if (!address) return;
    try {
      await navigator.clipboard?.writeText(address);
      setLightningAddressCopied(true);
      showToast("Lightning address copied", 2000);
    } catch (error) {
      console.warn("Failed to copy lightning address", error);
    }
  }, [npubCashIdentity?.address, showToast]);

  const handleOpenLightningAmountView = useCallback(() => {
    resetLightningInvoiceState();
    setLightningReceiveView("amount");
    refreshMintEntries();
  }, [resetLightningInvoiceState, refreshMintEntries]);

  const handleLightningInvoiceBack = useCallback(() => {
    resetLightningInvoiceState();
    setLightningReceiveView("amount");
  }, [resetLightningInvoiceState]);

  const handleLightningAmountUnitToggle = useCallback(() => {
    if (!canToggleCurrency) return;
    const nextCurrency = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    const satsAmount = parsedMintAmount.error ? 0 : parsedMintAmount.sats;
    handleTogglePrimary();
    if (!satsAmount || satsAmount <= 0) {
      setMintAmt("");
      return;
    }
    if (nextCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        setMintAmt("");
        return;
      }
      const usdValue = (satsAmount / SATS_PER_BTC) * btcUsdPrice;
      const rounded = Math.round(usdValue * 100) / 100;
      setMintAmt(rounded.toFixed(2));
      return;
    }
    setMintAmt(String(satsAmount));
  }, [
    canToggleCurrency,
    walletPrimaryCurrency,
    parsedMintAmount,
    handleTogglePrimary,
    walletConversionEnabled,
    btcUsdPrice,
  ]);

  const handleLightningAmountKeypadInput = useCallback(
    (key: string) => {
      setMintAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          const trimmed = current.slice(0, -1);
          return trimmed;
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
      setMintError("");
      if (mintQuote || activeMintInvoice) {
        resetLightningInvoiceState();
      }
    },
    [primaryCurrency, mintQuote, activeMintInvoice, resetLightningInvoiceState],
  );

  const handleOpenEcashRequestAmountView = useCallback(() => {
    refreshMintEntries();
    setEcashReceiveView("amount");
    setRecvMsg("");
    setPaymentRequestError("");
    setLastCreatedEcashRequest(null);
  }, [refreshMintEntries, setPaymentRequestError]);

  const handleEcashRequestKeypadInput = useCallback(
    (key: string) => {
      setEcashRequestAmt((prev) => {
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
    },
    [primaryCurrency],
  );

  const handleLightningSendAmountKeypadInput = useCallback(
    (key: string) => {
      setLnAddrAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          const trimmed = current.slice(0, -1);
          return trimmed;
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
    },
    [primaryCurrency],
  );

  const evaluateLightningSendInput = useCallback(
    (rawValue: string): LightningSendInputKind => {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        setLightningSendView("input");
        return "empty";
      }
      const normalized = trimmed.replace(/^lightning:/i, "").trim();
      if (/^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalized)) {
        setLightningSendView("invoice");
        return "invoice";
      }
      if (/^[^@\s]+@[^@\s]+$/.test(normalized)) {
        setLightningSendView("address");
        return "address";
      }
      if (/^lnurl[0-9a-z]+$/i.test(normalized)) {
        setLightningSendView("address");
        return "lnurl";
      }
      setLightningSendView("input");
      return "unknown";
    },
    [],
  );

  const handleLightningInputReview = useCallback(() => {
    const currentInput = commitLightningInputFromDom();
    const kind = evaluateLightningSendInput(currentInput);
    if (kind === "invoice") {
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
    } else if (kind === "address" || kind === "lnurl") {
      setLnState("idle");
      setLnError("");
    } else if (kind === "empty") {
      setLnError("Paste an invoice or enter a lightning address");
    } else if (kind === "unknown") {
      setLnError("Unsupported input. Paste a Lightning invoice, address, or LNURL.");
    }
    return kind;
  }, [commitLightningInputFromDom, evaluateLightningSendInput]);

  const handlePasteLightningInput = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      setLnInput(text);
      const kind = evaluateLightningSendInput(text);
      setLnState("idle");
      setLnError("");
      if (kind === "invoice") {
        setLnAddrAmt("");
      } else if (kind === "address" || kind === "lnurl") {
        setLnAddrAmt("");
      } else if (kind === "unknown") {
        alert("Clipboard does not contain a valid Lightning invoice, address, or LNURL.");
        setLnError("Clipboard does not contain a valid Lightning invoice, address, or LNURL.");
      }
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [evaluateLightningSendInput, setLnInput]);

  const handlePaymentRequestKeypadInput = useCallback((key: string) => {
    setPaymentRequestManualAmount((prev) => {
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
  }, [primaryCurrency]);

  const handlePaymentRequestAmountUnitToggle = useCallback(() => {
    if (!canTogglePaymentRequestCurrency) return;
    const nextCurrency = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    const trimmed = paymentRequestManualAmount.trim();
    let satsAmount = 0;
    if (trimmed) {
      const numeric = Number(trimmed);
      if (paymentRequestInputCurrency === "usd") {
        if (
          walletConversionEnabled &&
          btcUsdPrice != null &&
          btcUsdPrice > 0 &&
          Number.isFinite(numeric) &&
          numeric > 0
        ) {
          satsAmount = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
        }
      } else if (Number.isFinite(numeric) && numeric > 0) {
        satsAmount = Math.floor(numeric);
      }
    }
    handleTogglePrimary();
    if (!satsAmount || satsAmount <= 0) {
      setPaymentRequestManualAmount("");
      return;
    }
    if (nextCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        setPaymentRequestManualAmount("");
        return;
      }
      const usdValue = (satsAmount / SATS_PER_BTC) * btcUsdPrice;
      const rounded = Math.round(usdValue * 100) / 100;
      setPaymentRequestManualAmount(rounded.toFixed(2));
      return;
    }
    setPaymentRequestManualAmount(String(satsAmount));
  }, [
    btcUsdPrice,
    canTogglePaymentRequestCurrency,
    handleTogglePrimary,
    paymentRequestInputCurrency,
    paymentRequestManualAmount,
    walletConversionEnabled,
    walletPrimaryCurrency,
  ]);

  const handleSetEcashRequestMode = useCallback((mode: "multi" | "single") => {
    setEcashRequestMode(mode);
    setRecvMsg("");
  }, []);

  const handleOpenEcashAmountView = useCallback(() => {
    refreshMintEntries();
    setEcashSendView("amount");
  }, [refreshMintEntries]);

  const handleEcashAmountKeypadInput = useCallback(
    (key: string) => {
      setSendAmt((prev) => {
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
      setSendLockError("");
    },
    [primaryCurrency],
  );

  return {
    handleCopyLightningAddress,
    handleOpenLightningAmountView,
    handleLightningInvoiceBack,
    handleLightningAmountUnitToggle,
    handleLightningAmountKeypadInput,
    handleOpenEcashRequestAmountView,
    handleEcashRequestKeypadInput,
    handleLightningSendAmountKeypadInput,
    evaluateLightningSendInput,
    handleLightningInputReview,
    handlePasteLightningInput,
    handlePaymentRequestKeypadInput,
    handlePaymentRequestAmountUnitToggle,
    handleSetEcashRequestMode,
    handleOpenEcashAmountView,
    handleEcashAmountKeypadInput,
  };
}
