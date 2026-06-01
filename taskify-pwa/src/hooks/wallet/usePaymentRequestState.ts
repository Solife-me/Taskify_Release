import { useEffect, useRef, useState } from "react";
import type {
  ActivePaymentRequest,
  IncomingPaymentRequest,
} from "../../wallet/paymentRequestTypes";

export interface UsePaymentRequestStateOptions {
  paymentRequestsEnabled: boolean;
  activeP2pkPublicKey: string | null;
}

export function usePaymentRequestState({
  paymentRequestsEnabled,
  activeP2pkPublicKey,
}: UsePaymentRequestStateOptions) {
  const [paymentRequestManualAmount, setPaymentRequestManualAmount] = useState("");
  const [currentPaymentRequest, setCurrentPaymentRequest] = useState<ActivePaymentRequest | null>(
    null,
  );
  const [openPaymentRequest, setOpenPaymentRequest] = useState<ActivePaymentRequest | null>(null);
  const [paymentRequestError, setPaymentRequestError] = useState("");
  const [paymentRequestStatusMessage, setPaymentRequestStatusMessage] = useState("");
  const [paymentRequestLockEnabled, setPaymentRequestLockEnabled] = useState(false);
  const [paymentRequestLockPubkey, setPaymentRequestLockPubkey] = useState("");

  const incomingPaymentRequestsRef = useRef<IncomingPaymentRequest[]>([]);
  const spentIncomingPaymentsRef = useRef<Map<string, string>>(new Map());
  const spentIncomingTokenFingerprintsRef = useRef<Set<string>>(new Set());
  const textEncoderRef = useRef<TextEncoder | null>(null);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (!paymentRequestLockPubkey && activeP2pkPublicKey) {
      setPaymentRequestLockPubkey(activeP2pkPublicKey);
    }
    if (paymentRequestLockEnabled && !paymentRequestLockPubkey) {
      if (activeP2pkPublicKey) {
        setPaymentRequestLockPubkey(activeP2pkPublicKey);
      } else {
        setPaymentRequestLockEnabled(false);
      }
    }
  }, [
    paymentRequestsEnabled,
    paymentRequestLockEnabled,
    paymentRequestLockPubkey,
    activeP2pkPublicKey,
  ]);

  return {
    paymentRequestManualAmount,
    setPaymentRequestManualAmount,
    currentPaymentRequest,
    setCurrentPaymentRequest,
    openPaymentRequest,
    setOpenPaymentRequest,
    paymentRequestError,
    setPaymentRequestError,
    paymentRequestStatusMessage,
    setPaymentRequestStatusMessage,
    paymentRequestLockEnabled,
    setPaymentRequestLockEnabled,
    paymentRequestLockPubkey,
    setPaymentRequestLockPubkey,
    incomingPaymentRequestsRef,
    spentIncomingPaymentsRef,
    spentIncomingTokenFingerprintsRef,
    textEncoderRef,
  };
}
