// @ts-nocheck
import { useCallback } from "react";
import {
  assembleNut16FromText,
  containsNut16Frame,
} from "../../wallet/nut16";
import {
  extractPeanutToken,
} from "../../wallet/peanut";
import {
  extractCashuUriPayload,
  amountFromCashuToken,
  isValidCashuTokenString,
  sumProofAmounts,
} from "../../wallet/cashuProofHelpers";
import {
  deriveSpentHistoryTokenStateFromToken,
  type HistoryItem,
} from "../../wallet/walletHistoryTypes";
import { normalizeNostrPubkey } from "../../lib/nostr";

export type EcashInputInterpretation =
  | { kind: "empty" }
  | { kind: "amount"; value: string }
  | { kind: "token"; value: string }
  | { kind: "invalid" };

export interface UseEcashRedeemOptions {
  buildHistoryEntry: (opts: any) => any;
  closeManualSendPlan: () => void;
  closeReceiveEcashSheet: () => void;
  createPaymentRequest: (amount: string, opts?: any) => Promise<boolean>;
  finalizeManualSelection: (opts: { selection: string[]; selectedTotal: number; target: any }) => Promise<void>;
  handlePaymentRequestScan: (text: string) => Promise<boolean>;
  manualSelectedTotal: number;
  manualSendPlan: any;
  manualSendSelection: Set<string>;
  mintUrl: string | null;
  parseAmountInput: (raw: string) => { sats: number; error?: string };
  peanutSendToken: string | null;
  receiveMode: string | null;
  redeemPendingToken: (id: string) => Promise<any>;
  resetSendLockSettings: () => void;
  savePendingTokenForRedemption: (token: string) => Promise<any>;
  setHistory: React.Dispatch<React.SetStateAction<any[]>>;
  setHistoryRedeemStates: React.Dispatch<React.SetStateAction<any>>;
  setLockSendToPubkey: (lock: boolean) => void;
  setManualSendError: (error: string) => void;
  setManualSendInProgress: (inProgress: boolean) => void;
  setNutTokenCopied: (copied: boolean) => void;
  setRecvMsg: (msg: string) => void;
  setSendLockError: (error: string) => void;
  setSendLockPubkeyInput: (input: string) => void;
  showToast: (msg: string, ms?: number) => void;
}

export function useEcashRedeem({
  buildHistoryEntry,
  closeManualSendPlan,
  closeReceiveEcashSheet,
  createPaymentRequest,
  finalizeManualSelection,
  handlePaymentRequestScan,
  manualSelectedTotal,
  manualSendPlan,
  manualSendSelection,
  mintUrl,
  parseAmountInput,
  peanutSendToken,
  receiveMode,
  redeemPendingToken,
  resetSendLockSettings,
  savePendingTokenForRedemption,
  setHistory,
  setHistoryRedeemStates,
  setLockSendToPubkey,
  setManualSendError,
  setManualSendInProgress,
  setNutTokenCopied,
  setRecvMsg,
  setSendLockError,
  setSendLockPubkeyInput,
  showToast,
}: UseEcashRedeemOptions) {
  const handleCopyNutToken = useCallback(async () => {
    if (!peanutSendToken) return;
    try {
      await navigator.clipboard?.writeText(peanutSendToken);
      setNutTokenCopied(true);
    } catch (err) {
      console.warn("Copy nut token failed", err);
      setNutTokenCopied(false);
    }
  }, [peanutSendToken]);

  const handlePasteEcashRequest = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      const success = await handlePaymentRequestScan(text);
      if (!success) {
        alert("Unable to process eCash payment request. Check the value and try again.");
      }
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [handlePaymentRequestScan]);

  const handlePasteSendLock = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      setSendLockPubkeyInput(text);
      const normalized = normalizeNostrPubkey(text);
      if (!normalized) {
        setLockSendToPubkey(false);
        setSendLockError("Enter a valid npub or 64-character hex key");
        return;
      }
      setLockSendToPubkey(true);
      setSendLockError("");
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, []);

  const handlePasteEcashInput = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      const requestHandled = await handlePaymentRequestScan(text);
      if (requestHandled) {
        return;
      }
      setSendLockPubkeyInput(text);
      const normalized = normalizeNostrPubkey(text);
      if (normalized) {
        setLockSendToPubkey(true);
        setSendLockError("");
        return;
      }
      setLockSendToPubkey(false);
      setSendLockError("Clipboard does not contain a valid eCash request or locking key");
      alert("Clipboard does not contain a valid eCash request or locking key.");
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [handlePaymentRequestScan]);

  const handleClearSendLock = useCallback(() => {
    resetSendLockSettings();
  }, [resetSendLockSettings]);

  const interpretEcashInput = useCallback(
    (raw: string): EcashInputInterpretation => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return { kind: "empty" };
      }
      const parsedAmount = parseAmountInput(trimmed);
      if (!parsedAmount.error && parsedAmount.sats > 0) {
        return { kind: "amount", value: trimmed };
      }
      let normalizedToken = trimmed;
      const peanutDecoded = extractPeanutToken(normalizedToken);
      if (peanutDecoded) {
        normalizedToken = peanutDecoded;
      }
      if (/^cashu:/i.test(normalizedToken)) {
        normalizedToken = extractCashuUriPayload(normalizedToken);
      }
      if (!normalizedToken) {
        return { kind: "invalid" };
      }
      try {
        if (containsNut16Frame(normalizedToken)) {
          const assembled = assembleNut16FromText(normalizedToken);
          normalizedToken = assembled.token;
        }
      } catch {
        // fall back to attempting decode with the provided input
      }
      if (isValidCashuTokenString(normalizedToken)) {
        return { kind: "token", value: normalizedToken };
      }
      return { kind: "invalid" };
    },
    [parseAmountInput],
  );

  const redeemEcashToken = useCallback(
    async (tokenInput: string) => {
      let tokenCandidate = tokenInput.trim();
      if (!tokenCandidate) throw new Error("Paste a Cashu token");
      const peanutDecoded = extractPeanutToken(tokenCandidate);
      if (peanutDecoded) {
        tokenCandidate = peanutDecoded;
      }
      if (/^cashu:/i.test(tokenCandidate)) {
        tokenCandidate = extractCashuUriPayload(tokenCandidate);
      }
      if (!tokenCandidate) throw new Error("Paste a Cashu token");
      if (containsNut16Frame(tokenCandidate)) {
        const assembled = assembleNut16FromText(tokenCandidate);
        tokenCandidate = assembled.token;
      }
      const normalizedToken = tokenCandidate;
      const saved = await savePendingTokenForRedemption(normalizedToken);

      let savedAmount = typeof saved.amountSat === "number" ? saved.amountSat : 0;
      if (!savedAmount) {
        savedAmount = amountFromCashuToken(normalizedToken);
      }

      const amountNote = savedAmount ? `${savedAmount} sat${savedAmount === 1 ? "" : "s"}` : "Token";
      const crossMintNote = saved.crossMint && saved.mintUrl ? ` at ${saved.mintUrl}` : "";
      const historyId = `recv-${Date.now()}`;

      setHistory((h) => [
        buildHistoryEntry({
          id: historyId,
          summary: `Received ${amountNote}${crossMintNote} (redeeming…)`,
          detail: normalizedToken,
          detailKind: "token",
          type: "ecash",
          direction: "in",
          amountSat: savedAmount || undefined,
          mintUrl: saved.mintUrl ?? mintUrl ?? undefined,
          pendingTokenId: saved.id,
          pendingTokenAmount: savedAmount || undefined,
          pendingTokenMint: saved.mintUrl ?? mintUrl ?? undefined,
          pendingStatus: "pending",
        }),
        ...h,
      ]);

      const toastAmount = savedAmount
        ? `${savedAmount} sat${savedAmount === 1 ? "" : "s"}`
        : "token";
      showToast(`Received ${toastAmount}${crossMintNote}`, 3500);

      if (receiveMode === "ecash") {
        closeReceiveEcashSheet();
      }

      void (async () => {
        try {
          const res = await redeemPendingToken(saved.id);
          const redeemedAmount = sumProofAmounts(res.proofs);
          const amountValue = redeemedAmount || savedAmount;
          const redeemedNote = amountValue
            ? `${amountValue} sat${amountValue === 1 ? "" : "s"}`
            : "Token";
          const mintLabel = saved.crossMint
            ? res.mintUrl
              ? ` at ${res.mintUrl}`
              : crossMintNote
            : "";
          const tokenState = deriveSpentHistoryTokenStateFromToken(normalizedToken, Date.now());
          setHistory((prev) =>
            prev.map((entry) =>
              entry.id === historyId
                ? {
                    ...entry,
                    summary: `Received ${redeemedNote}${mintLabel}`,
                    amountSat: amountValue || undefined,
                    pendingTokenId: undefined,
                    pendingTokenAmount: undefined,
                    pendingTokenMint: undefined,
                    pendingStatus: "redeemed",
                    ...(tokenState ? { tokenState } : {}),
                  }
                : entry,
            ),
          );
        } catch (err) {
          console.warn("Cashu wallet: automatic redemption failed", err);
          setHistory((prev) =>
            prev.map((entry) =>
              entry.id === historyId
                ? {
                    ...entry,
                    summary: `${amountNote} saved for later redemption${crossMintNote}`,
                  }
                : entry,
            ),
          );
          showToast("Payment received but will be redeemed when your connection returns.", 4000);
        }
      })();
    },
    [
      buildHistoryEntry,
      closeReceiveEcashSheet,
      mintUrl,
      receiveMode,
      redeemPendingToken,
      savePendingTokenForRedemption,
      setHistory,
      showToast,
    ]
  );

  const processEcashInput = useCallback(
    async (raw: string) => {
      const promptMessage = "please enter amount for request or valid ecash token";
      setRecvMsg("");
      const interpretation = interpretEcashInput(raw);
      if (interpretation.kind === "empty") {
        setRecvMsg(promptMessage);
        return false;
      }
      if (interpretation.kind === "amount") {
        const created = await createPaymentRequest(interpretation.value);
        if (!created) {
          setRecvMsg(promptMessage);
          return false;
        }
        return true;
      }
      if (interpretation.kind === "token") {
        try {
          await redeemEcashToken(interpretation.value);
          return true;
        } catch (err: any) {
          setRecvMsg(err?.message || String(err));
          return false;
        }
      }
      setRecvMsg(promptMessage);
      return false;
    },
    [createPaymentRequest, interpretEcashInput, redeemEcashToken],
  );

  const handlePasteEcashClipboard = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      await processEcashInput(text);
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [processEcashInput]);

  const handleRedeemPendingHistoryItem = useCallback(
    async (item: HistoryItem) => {
      if (!item.pendingTokenId) return;
      setHistoryRedeemStates((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const res = await redeemPendingToken(item.pendingTokenId);
        const amount = sumProofAmounts(res.proofs);
        const amountNote = amount ? `${amount} sat${amount === 1 ? "" : "s"}` : "Token";
        showToast(`${amountNote} redeemed`, 3000);
        const tokenState =
          typeof item.detail === "string"
            ? deriveSpentHistoryTokenStateFromToken(item.detail, Date.now())
            : undefined;
        setHistory((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  summary: `${amountNote} redeemed${res.mintUrl ? ` at ${res.mintUrl}` : ""}`,
                  pendingTokenId: undefined,
                  pendingTokenAmount: undefined,
                  pendingTokenMint: undefined,
                  pendingStatus: "redeemed",
                  ...(tokenState ? { tokenState } : {}),
                }
              : entry,
          ),
        );
        setHistoryRedeemStates((prev) => ({
          ...prev,
          [item.id]: { status: "success", message: `${amountNote} redeemed` },
        }));
      } catch (err: any) {
        const message = err?.message || String(err);
        setHistoryRedeemStates((prev) => ({
          ...prev,
          [item.id]: { status: "error", message },
        }));
      }
    },
    [redeemPendingToken, setHistory, showToast],
  );

  const handleManualSendConfirm = useCallback(async () => {
    if (!manualSendPlan) return;
    const secrets = Array.from(manualSendSelection);
    if (!secrets.length) {
      setManualSendError("Select at least one note.");
      return;
    }
    setManualSendInProgress(true);
    setManualSendError("");
    try {
      const selectedTotal = manualSelectedTotal;
      await finalizeManualSelection({
        selection: secrets,
        selectedTotal,
        target: manualSendPlan.target,
      });
      closeManualSendPlan();
    } catch (err: any) {
      setManualSendError(err?.message || String(err));
    } finally {
      setManualSendInProgress(false);
    }
  }, [
    closeManualSendPlan,
    finalizeManualSelection,
    manualSelectedTotal,
    manualSendPlan,
    manualSendSelection,
  ]);

  return {
    handleCopyNutToken,
    handlePasteEcashRequest,
    handlePasteSendLock,
    handlePasteEcashInput,
    handleClearSendLock,
    interpretEcashInput,
    redeemEcashToken,
    processEcashInput,
    handlePasteEcashClipboard,
    handleRedeemPendingHistoryItem,
    handleManualSendConfirm,
  };
}
