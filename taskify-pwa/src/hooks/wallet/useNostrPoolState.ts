// @ts-nocheck
import { useCallback, useEffect, useMemo, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type PaymentRequestPayload } from "@cashu/cashu-ts";
import { encodePeanut } from "../../wallet/peanut";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import {
  LS_SPENT_NOSTR_PAYMENTS,
} from "../../localStorageKeys";
import {
  extractFirstCashuTokenFromText,
} from "../../wallet/walletModalHelpers";
import { useNostrSession } from "../../chat/hooks/useNostrSession";

export interface UseNostrPoolStateOptions {
  walletDebugEnabled: boolean;
  paymentRequestsEnabled: boolean;
  fileStorageServer: string;
  sendTokenStr: string;
  nutTokenCopied: boolean;
  setNutTokenCopied: (v: boolean) => void;
  setLockSendToPubkey: (v: boolean) => void;
  setSendLockPubkeyInput: (v: string) => void;
  setSendLockError: (v: string) => void;
  textEncoderRef: React.MutableRefObject<TextEncoder | null>;
  spentIncomingPaymentsRef: React.MutableRefObject<Map<string, string>>;
  spentIncomingTokenFingerprintsRef: React.MutableRefObject<Set<string>>;
  dmSubscriptionCloseRef: React.MutableRefObject<(() => void) | null>;
  open: boolean;
  receiveMode: string | null;
  sendMode: string | null;
}

export function useNostrPoolState({
  walletDebugEnabled,
  paymentRequestsEnabled,
  fileStorageServer,
  sendTokenStr,
  nutTokenCopied,
  setNutTokenCopied,
  setLockSendToPubkey,
  setSendLockPubkeyInput,
  setSendLockError,
  textEncoderRef,
  spentIncomingPaymentsRef,
  spentIncomingTokenFingerprintsRef,
  dmSubscriptionCloseRef,
  open,
  receiveMode,
  sendMode,
}: UseNostrPoolStateOptions) {
  const [claimingEventIds, setClaimingEventIds] = useState<string[]>([]);
  // The relay pool, identity, publishing and DM decryption are chat's (useNostrSession); the
  // wallet adds payment-request handling on top.
  const session = useNostrSession({
    debug: walletDebugEnabled,
    fileStorageServer,
    dmSubscriptionCloseRef,
    identityEnabled: paymentRequestsEnabled,
    identityRefreshKeys: [open, receiveMode, sendMode],
  });
  const {
    defaultNostrRelays,
    preferredFileServer,
    nostrPoolRef,
    nostrPoolClosingRef,
    nostrSubscriptionActiveRef,
    nostrIdentityRef,
    nostrIdentityInfo,
    setNostrIdentityInfo,
    ensureNostrPool,
    closeNostrPool,
    isReplaceableRejection,
    safePublish,
    readNostrIdentity,
    readProfileEventId,
    persistProfileEventId,
    ensureNostrIdentity,
    decryptNostrPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
    refreshNostrIdentity,
  } = session;

  const peanutSendToken = useMemo(() => {
    if (!sendTokenStr.trim()) return null;
    try {
      return encodePeanut(sendTokenStr.trim());
    } catch (error) {
      console.warn("Failed to encode nut token", error);
      return null;
    }
  }, [sendTokenStr]);

  useEffect(() => {
    setNutTokenCopied(false);
  }, [peanutSendToken]);

  useEffect(() => {
    if (!nutTokenCopied) return;
    const timer = window.setTimeout(() => setNutTokenCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [nutTokenCopied]);

  const resetSendLockSettings = useCallback(() => {
    setLockSendToPubkey(false);
    setSendLockPubkeyInput("");
    setSendLockError("");
  }, []);

  const fingerprintIncomingToken = useCallback((token: string | null | undefined) => {
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    let encoder = textEncoderRef.current;
    if (!encoder) {
      encoder = new TextEncoder();
      textEncoderRef.current = encoder;
    }
    return bytesToHex(sha256(encoder.encode(trimmed)));
  }, []);

  const rebuildSpentFingerprints = useCallback(() => {
    spentIncomingTokenFingerprintsRef.current = new Set(
      Array.from(spentIncomingPaymentsRef.current.values()).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    );
  }, []);

  const addSpentIncomingPayment = useCallback(
    (eventId: string, fingerprint: string | null) => {
      if (!eventId) return;
      const map = spentIncomingPaymentsRef.current;
      if (map.has(eventId)) {
        map.delete(eventId);
      }
      map.set(eventId, fingerprint ?? "");
      while (map.size > 400) {
        const firstKey = map.keys().next().value as string | undefined;
        if (!firstKey) break;
        map.delete(firstKey);
      }
      rebuildSpentFingerprints();
    },
    [rebuildSpentFingerprints],
  );

  const isIncomingPaymentSpent = useCallback((eventId?: string | null, fingerprint?: string | null) => {
    if (eventId) {
      if (spentIncomingPaymentsRef.current.has(eventId)) {
        const storedFingerprint = spentIncomingPaymentsRef.current.get(eventId) ?? "";
        if (!storedFingerprint) {
          return true;
        }
        if (!fingerprint) {
          return true;
        }
        return storedFingerprint === fingerprint;
      }
      if (fingerprint && spentIncomingTokenFingerprintsRef.current.has(fingerprint)) {
        return true;
      }
      return false;
    }
    if (fingerprint && spentIncomingTokenFingerprintsRef.current.has(fingerprint)) {
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_SPENT_NOSTR_PAYMENTS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const values = parsed
          .filter((value): value is string => typeof value === "string" && !!value.trim())
          .slice(-400);
        const map = new Map<string, string>();
        for (const entry of values) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const [eventIdPart, fingerprintPart] = trimmed.split("::", 2);
          const eventId = eventIdPart?.trim();
          if (!eventId) continue;
          const fingerprint = fingerprintPart?.trim() ?? "";
          map.set(eventId, fingerprint);
        }
        spentIncomingPaymentsRef.current = map;
        rebuildSpentFingerprints();
      }
    } catch (err) {
      console.warn("Failed to load spent nostr payments", err);
      spentIncomingPaymentsRef.current = new Map();
      spentIncomingTokenFingerprintsRef.current = new Set();
    }
  }, [rebuildSpentFingerprints]);

  const parseIncomingPaymentMessage = useCallback((plain: string): PaymentRequestPayload | string | null => {
    const trimmed = (plain || "").trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as PaymentRequestPayload;
      }
    } catch {
      // fall through to string heuristics
    }
    const token = extractFirstCashuTokenFromText(trimmed);
    if (token) return token;
    return null;
  }, []);

  return {
    claimingEventIds,
    setClaimingEventIds,
    defaultNostrRelays,
    preferredFileServer,
    nostrPoolRef,
    nostrPoolClosingRef,
    nostrSubscriptionActiveRef,
    nostrIdentityRef,
    nostrIdentityInfo,
    setNostrIdentityInfo,
    peanutSendToken,
    ensureNostrPool,
    closeNostrPool,
    isReplaceableRejection,
    safePublish,
    resetSendLockSettings,
    readNostrIdentity,
    readProfileEventId,
    persistProfileEventId,
    ensureNostrIdentity,
    fingerprintIncomingToken,
    rebuildSpentFingerprints,
    addSpentIncomingPayment,
    isIncomingPaymentSpent,
    decryptNostrPaymentMessage,
    parseIncomingPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
    refreshNostrIdentity,
  };
}
