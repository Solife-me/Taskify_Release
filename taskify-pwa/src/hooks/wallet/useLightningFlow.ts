import { useCallback, useEffect, useRef, useState } from "react";

export type LnurlPayData = {
  lnurl: string;
  callback: string;
  domain: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed: number;
  metadata?: string;
};

export type LightningReceiveView = "address" | "amount" | "invoice";
export type LightningSendView = "input" | "invoice" | "address";
export type MintQuoteState = "idle" | "waiting" | "minted" | "error";
export type LightningSendState = "idle" | "sending" | "done" | "error";

export type MintQuoteRecord = { request: string; quote: string; expiry: number };
export type ActiveMintInvoiceRecord = {
  request: string;
  quote: string;
  expiry: number;
  amountSat: number;
  mintUrl?: string;
};

export type LnInputSetter = (
  next: string | ((previous: string) => string),
  options?: { defer?: boolean },
) => void;

export function useLightningFlow() {
  // Receive state
  const [mintAmt, setMintAmt] = useState("");
  const [mintQuote, setMintQuote] = useState<MintQuoteRecord | null>(null);
  const [lightningReceiveView, setLightningReceiveView] = useState<LightningReceiveView>("address");
  const [activeMintInvoice, setActiveMintInvoice] = useState<ActiveMintInvoiceRecord | null>(null);
  const [mintStatus, setMintStatus] = useState<MintQuoteState>("idle");
  const [mintError, setMintError] = useState("");
  const [creatingMintInvoice, setCreatingMintInvoice] = useState(false);
  const [lightningAddressCopied, setLightningAddressCopied] = useState(false);

  useEffect(() => {
    if (!lightningAddressCopied) return;
    const timer = window.setTimeout(() => setLightningAddressCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [lightningAddressCopied]);

  // Send state
  const [lnInput, setLnInputState] = useState("");
  const lnInputValueRef = useRef("");
  const lnInputCommitTimerRef = useRef<number | null>(null);
  const setLnInput = useCallback<LnInputSetter>((next, options) => {
    const resolveNext = (previous: string) => {
      const resolved = typeof next === "function" ? next(previous) : next;
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    };
    if (options?.defer && typeof window !== "undefined") {
      const resolved = resolveNext(lnInputValueRef.current);
      lnInputValueRef.current = resolved;
      if (lnInputCommitTimerRef.current !== null) {
        window.clearTimeout(lnInputCommitTimerRef.current);
      }
      lnInputCommitTimerRef.current = window.setTimeout(() => {
        lnInputCommitTimerRef.current = null;
        setLnInputState(lnInputValueRef.current);
      }, 140);
      return;
    }
    if (typeof window !== "undefined" && lnInputCommitTimerRef.current !== null) {
      window.clearTimeout(lnInputCommitTimerRef.current);
      lnInputCommitTimerRef.current = null;
    }
    setLnInputState((previous) => {
      const resolved = resolveNext(previous);
      lnInputValueRef.current = resolved;
      return resolved;
    });
  }, []);
  useEffect(() => {
    return () => {
      if (lnInputCommitTimerRef.current !== null) {
        window.clearTimeout(lnInputCommitTimerRef.current);
        lnInputCommitTimerRef.current = null;
      }
    };
  }, []);
  const [lnAddrAmt, setLnAddrAmt] = useState("");
  const [lnState, setLnState] = useState<LightningSendState>("idle");
  const [lnError, setLnError] = useState("");
  const [lnurlPayData, setLnurlPayData] = useState<LnurlPayData | null>(null);
  const [lightningSendView, setLightningSendView] = useState<LightningSendView>("input");

  return {
    // Receive
    mintAmt,
    setMintAmt,
    mintQuote,
    setMintQuote,
    lightningReceiveView,
    setLightningReceiveView,
    activeMintInvoice,
    setActiveMintInvoice,
    mintStatus,
    setMintStatus,
    mintError,
    setMintError,
    creatingMintInvoice,
    setCreatingMintInvoice,
    lightningAddressCopied,
    setLightningAddressCopied,
    // Send
    lnInput,
    setLnInput,
    lnInputValueRef,
    lnAddrAmt,
    setLnAddrAmt,
    lnState,
    setLnState,
    lnError,
    setLnError,
    lnurlPayData,
    setLnurlPayData,
    lightningSendView,
    setLightningSendView,
  };
}
