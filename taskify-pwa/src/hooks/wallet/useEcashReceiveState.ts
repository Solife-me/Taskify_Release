import { useState } from "react";
import type { ActivePaymentRequest } from "../../wallet/paymentRequestTypes";

export type EcashReceiveView = "overview" | "amount" | "request";
export type EcashRequestMode = "multi" | "single";

export function useEcashReceiveState() {
  const [receiveLockVisible, setReceiveLockVisible] = useState(false);
  const [ecashReceiveView, setEcashReceiveView] = useState<EcashReceiveView>("overview");
  const [lastCreatedEcashRequest, setLastCreatedEcashRequest] =
    useState<ActivePaymentRequest | null>(null);
  const [ecashRequestAmt, setEcashRequestAmt] = useState("");
  const [ecashRequestMode, setEcashRequestMode] = useState<EcashRequestMode>("multi");
  const [pendingPrimaryP2pkKeyId, setPendingPrimaryP2pkKeyId] = useState<string | null>(null);

  return {
    receiveLockVisible,
    setReceiveLockVisible,
    ecashReceiveView,
    setEcashReceiveView,
    lastCreatedEcashRequest,
    setLastCreatedEcashRequest,
    ecashRequestAmt,
    setEcashRequestAmt,
    ecashRequestMode,
    setEcashRequestMode,
    pendingPrimaryP2pkKeyId,
    setPendingPrimaryP2pkKeyId,
  };
}
