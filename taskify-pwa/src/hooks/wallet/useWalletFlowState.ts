// @ts-nocheck
import { useState } from "react";
import type { LnurlWithdrawData } from "../../wallet/walletModalHelpers";
import type { PaymentRequest } from "@cashu/cashu-ts";

export function useWalletFlowState() {
  const [lnurlWithdrawInfo, setLnurlWithdrawInfo] = useState<LnurlWithdrawData | null>(null);
  const [lnurlWithdrawAmt, setLnurlWithdrawAmt] = useState("");
  const [lnurlWithdrawState, setLnurlWithdrawState] = useState<"idle" | "creating" | "waiting" | "done" | "error">("idle");
  const [lnurlWithdrawMessage, setLnurlWithdrawMessage] = useState("");
  const [lnurlWithdrawInvoice, setLnurlWithdrawInvoice] = useState("");

  const [paymentRequestState, setPaymentRequestState] = useState<{ encoded: string; request: PaymentRequest } | null>(null);
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [paymentRequestMessage, setPaymentRequestMessage] = useState("");

  const [swapAmount, setSwapAmount] = useState("");
  const [swapFromValue, setSwapFromValue] = useState<string>("");
  const [swapToValue, setSwapToValue] = useState<string>("");
  const [nwcFundState, setNwcFundState] = useState<"idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error">("idle");
  const [nwcFundMessage, setNwcFundMessage] = useState("");
  const [nwcFundInvoice, setNwcFundInvoice] = useState("");

  const [nwcWithdrawState, setNwcWithdrawState] = useState<"idle" | "requesting" | "paying" | "done" | "error">("idle");
  const [nwcWithdrawMessage, setNwcWithdrawMessage] = useState("");
  const [nwcWithdrawInvoice, setNwcWithdrawInvoice] = useState("");
  const [mintSwapState, setMintSwapState] = useState<"idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error">("idle");
  const [mintSwapMessage, setMintSwapMessage] = useState("");

  return {
    lnurlWithdrawInfo,
    setLnurlWithdrawInfo,
    lnurlWithdrawAmt,
    setLnurlWithdrawAmt,
    lnurlWithdrawState,
    setLnurlWithdrawState,
    lnurlWithdrawMessage,
    setLnurlWithdrawMessage,
    lnurlWithdrawInvoice,
    setLnurlWithdrawInvoice,
    paymentRequestState,
    setPaymentRequestState,
    paymentRequestStatus,
    setPaymentRequestStatus,
    paymentRequestMessage,
    setPaymentRequestMessage,
    swapAmount,
    setSwapAmount,
    swapFromValue,
    setSwapFromValue,
    swapToValue,
    setSwapToValue,
    nwcFundState,
    setNwcFundState,
    nwcFundMessage,
    setNwcFundMessage,
    nwcFundInvoice,
    setNwcFundInvoice,
    nwcWithdrawState,
    setNwcWithdrawState,
    nwcWithdrawMessage,
    setNwcWithdrawMessage,
    nwcWithdrawInvoice,
    setNwcWithdrawInvoice,
    mintSwapState,
    setMintSwapState,
    mintSwapMessage,
    setMintSwapMessage,
  };
}
