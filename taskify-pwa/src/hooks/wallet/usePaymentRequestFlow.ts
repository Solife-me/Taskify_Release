// @ts-nocheck
import { useCallback } from "react";
import { finalizeEvent, nip19, type EventTemplate } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestPayload,
  type PaymentRequestTransport,
  type Proof,
} from "@cashu/cashu-ts";
import { getEncodedToken } from "@cashu/cashu-ts";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import {
  LS_ECASH_OPEN_REQUESTS,
  LS_SPENT_NOSTR_PAYMENTS,
} from "../../localStorageKeys";
import {
  normalizeMintUrl,
  extractCashuUriPayload,
  sumProofAmounts,
  decodeCashuTokenLoose,
} from "../../wallet/cashuProofHelpers";
import { deriveSpentHistoryTokenStateFromToken } from "../../wallet/walletHistoryTypes";
import {
  isSamePaymentRequest,
  type ActivePaymentRequest,
  type IncomingPaymentRequest,
} from "../../wallet/paymentRequestTypes";
import { NostrSession } from "../../nostr/NostrSession";
import {
  extractFirstCashuTokenFromText,
  isMintTokenAlreadySpentError,
  type NormalizedIncomingPayment,
  type NostrEvent,
} from "../../wallet/walletModalHelpers";
import { normalizeNostrPubkey } from "../../lib/nostr";

export interface UsePaymentRequestFlowOptions {
  // From useCashu
  info: any;
  mintUrl: string | null;
  receiveToken: (token: string) => Promise<any>;

  // From useNostrPoolState
  addSpentIncomingPayment: (eventId: string, fingerprint: string | null) => void;
  defaultNostrRelays: string[];
  ensureNostrIdentity: () => any;
  ensureNostrPool: () => any;
  fingerprintIncomingToken: (token: string) => string | null;
  isIncomingPaymentSpent: (eventId: string, fingerprint: string | null) => boolean;
  nostrSubscriptionActiveRef: React.MutableRefObject<boolean>;
  safePublish: (...args: any[]) => Promise<any>;
  setClaimingEventIds: React.Dispatch<React.SetStateAction<string[]>>;

  // From usePaymentRequestState
  currentPaymentRequest: ActivePaymentRequest | null;
  incomingPaymentRequestsRef: React.MutableRefObject<IncomingPaymentRequest[]>;
  openPaymentRequest: ActivePaymentRequest | null;
  setCurrentPaymentRequest: (req: ActivePaymentRequest | null) => void;
  setOpenPaymentRequest: (req: ActivePaymentRequest | null) => void;
  setPaymentRequestError: (err: string) => void;
  setPaymentRequestManualAmount: (amt: string) => void;
  setPaymentRequestStatusMessage: (msg: string) => void;
  spentIncomingPaymentsRef: React.MutableRefObject<Map<string, string>>;

  // From useEcashReceiveState
  ecashRequestAmt: string;
  ecashRequestMode: "multi" | "single";
  setEcashReceiveView: (view: string) => void;
  setEcashRequestAmt: (amt: string) => void;
  setLastCreatedEcashRequest: (req: ActivePaymentRequest | null) => void;

  // From useWalletHistory
  buildHistoryEntry: (opts: any) => any;
  setHistory: React.Dispatch<React.SetStateAction<any[]>>;

  // From useContactsState
  compressedToRawHex: (hex: string) => string;
  contacts: any[];

  // From useDmSubscription
  ensurePeerProfile: (pubkey: string) => void;

  // From useToast
  showToast: (msg: string, ms?: number) => void;
  formatSatAmount: (amount: number) => string;

  // From useContactLookup
  normalizeNip05: (nip05: string | null | undefined) => any;

  // Inline component values
  activeP2pkKey: any;
  amountInputUnitLabel: string;
  autoClaimQueueRef: React.MutableRefObject<IncomingPaymentRequest[]>;
  claimingEventSet: Set<string>;
  handlePaymentRequestEventRef: React.MutableRefObject<any>;
  nip05Checks: Record<string, any>;
  nostrLastCheckRef: React.MutableRefObject<number>;
  nostrMissingReason: string | null;
  nostrSubscriptionCloserRef: React.MutableRefObject<(() => void) | null>;
  open: boolean;
  parseAmountInput: (raw: string) => { sats: number; error?: string };
  parsedEcashRequestAmount: { sats: number; error?: string };
  paymentRequestLockEnabled: boolean;
  paymentRequestLockPubkey: string;
  paymentRequestsBackgroundChecksEnabled: boolean;
  paymentRequestsEnabled: boolean;
  receiveMode: string | null;
  setRecvMsg: (msg: string) => void;
  walletDebugEnabled: boolean;
  dmPeerProfilesRef: React.MutableRefObject<Map<string, any>>;
  autoClaimRunningRef: React.MutableRefObject<boolean>;

  // Constants
  PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS: number;
  PAYMENT_REQUEST_LOOKBACK_SECONDS: number;
  PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS: number;
}

export function usePaymentRequestFlow({
  info,
  mintUrl,
  receiveToken,
  addSpentIncomingPayment,
  defaultNostrRelays,
  ensureNostrIdentity,
  ensureNostrPool,
  fingerprintIncomingToken,
  isIncomingPaymentSpent,
  nostrSubscriptionActiveRef,
  safePublish,
  setClaimingEventIds,
  currentPaymentRequest,
  incomingPaymentRequestsRef,
  openPaymentRequest,
  setCurrentPaymentRequest,
  setOpenPaymentRequest,
  setPaymentRequestError,
  setPaymentRequestManualAmount,
  setPaymentRequestStatusMessage,
  spentIncomingPaymentsRef,
  ecashRequestAmt,
  ecashRequestMode,
  setEcashReceiveView,
  setEcashRequestAmt,
  setLastCreatedEcashRequest,
  buildHistoryEntry,
  setHistory,
  compressedToRawHex,
  contacts,
  ensurePeerProfile,
  showToast,
  formatSatAmount,
  normalizeNip05,
  activeP2pkKey,
  amountInputUnitLabel,
  autoClaimQueueRef,
  claimingEventSet,
  handlePaymentRequestEventRef,
  nip05Checks,
  nostrLastCheckRef,
  nostrMissingReason,
  nostrSubscriptionCloserRef,
  open,
  parseAmountInput,
  parsedEcashRequestAmount,
  paymentRequestLockEnabled,
  paymentRequestLockPubkey,
  paymentRequestsBackgroundChecksEnabled,
  paymentRequestsEnabled,
  receiveMode,
  setRecvMsg,
  walletDebugEnabled,
  dmPeerProfilesRef,
  autoClaimRunningRef,
  PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS,
  PAYMENT_REQUEST_LOOKBACK_SECONDS,
  PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS,
}: UsePaymentRequestFlowOptions) {

  const persistSpentIncomingEvents = useCallback(() => {
    try {
      const entries: string[] = [];
      for (const [eventId, fingerprint] of spentIncomingPaymentsRef.current.entries()) {
        if (!eventId) continue;
        if (fingerprint) {
          entries.push(`${eventId}::${fingerprint}`);
        } else {
          entries.push(eventId);
        }
      }
      const trimmed = entries.slice(-400);
      idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_SPENT_NOSTR_PAYMENTS, JSON.stringify(trimmed));
    } catch (err) {
      console.warn("Failed to persist spent nostr payments", err);
    }
  }, []);

  const requestNostrPaymentDeletion = useCallback(
    async (eventId: string, senderPubkey?: string | null, reason?: string) => {
      if (!paymentRequestsEnabled) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const relayList = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url): url is string => !!url);
      if (!relayList.length) return;
      if (!eventId) return;
      try {
        const tags: string[][] = [["e", eventId]];
        if (senderPubkey && typeof senderPubkey === "string" && senderPubkey.trim()) {
          tags.push(["p", senderPubkey.trim()]);
        }
        const deletionTemplate: EventTemplate = {
          kind: 5,
          content: typeof reason === "string" ? reason : "",
          tags,
          created_at: Math.floor(Date.now() / 1000),
        };
        const deletionEvent = finalizeEvent(deletionTemplate, hexToBytes(identity.secret));
        const pool = ensureNostrPool();
        await safePublish(pool, relayList, deletionEvent);
      } catch (err) {
        console.warn("Failed to publish nostr deletion", err);
      }
    },
    [defaultNostrRelays, ensureNostrIdentity, ensureNostrPool, paymentRequestsEnabled, safePublish],
  );

  const loadStoredOpenPaymentRequest = useCallback((): ActivePaymentRequest | null => {
    if (!mintUrl) return null;
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (!parsed || typeof parsed !== "object") return null;
      const normalizedMint = normalizeMintUrl(mintUrl);
      const entry = parsed[normalizedMint];
      if (!entry || typeof entry.encoded !== "string") return null;
      let request: PaymentRequest;
      try {
        request = PaymentRequest.fromEncodedRequest(entry.encoded);
      } catch (err) {
        console.warn("Stored payment request invalid", err);
        return null;
      }
      if (request.singleUse) return null;
      if (Array.isArray(request.mints) && request.mints.length) {
        // Stored multi-use requests used to be tied to a specific mint. Regenerate
        // them so new links accept payments from any mint.
        return null;
      }
      const active: ActivePaymentRequest = {
        id: typeof entry.id === "string" && entry.id ? entry.id : request.id || normalizedMint,
        encoded: entry.encoded,
        request,
        amountSat:
          typeof entry.amountSat === "number" && Number.isFinite(entry.amountSat)
            ? entry.amountSat
            : typeof request.amount === "number"
              ? request.amount
              : undefined,
        lockPubkey:
          typeof entry.lockPubkey === "string" && entry.lockPubkey
            ? entry.lockPubkey
            : (request.nut10?.d as string | undefined) || null,
      };
      return active;
    } catch (err) {
      console.warn("Failed to load stored eCash payment request", err);
      return null;
    }
  }, [mintUrl]);

  const persistOpenPaymentRequest = useCallback(
    (request: ActivePaymentRequest | null) => {
      if (!mintUrl) return;
      const normalizedMint = normalizeMintUrl(mintUrl);
      try {
        const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS);
        let parsed: Record<string, any> = {};
        if (raw) {
          try {
            parsed = JSON.parse(raw) as Record<string, any>;
            if (!parsed || typeof parsed !== "object") {
              parsed = {};
            }
          } catch {
            parsed = {};
          }
        }
        if (request && !request.request.singleUse) {
          parsed[normalizedMint] = {
            id: request.id,
            encoded: request.encoded,
            amountSat: request.amountSat ?? null,
            lockPubkey: request.lockPubkey ?? null,
            singleUse: false,
            updatedAt: Date.now(),
          };
        } else {
          delete parsed[normalizedMint];
        }
        idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS, JSON.stringify(parsed));
      } catch (err) {
        console.warn("Failed to persist eCash payment request", err);
      }
    },
    [mintUrl],
  );

  const createPaymentRequest = useCallback(
    async (
      amountInputRaw: string,
      options?: {
        forceNew?: boolean;
        lockEnabled?: boolean;
        lockPubkey?: string | null;
        mode?: "single" | "multi";
        persistOpen?: boolean;
      },
    ) => {
      if (!paymentRequestsEnabled) return null;
      setPaymentRequestError("");
      setPaymentRequestStatusMessage("");
      try {
        if (!mintUrl) {
          throw new Error("Set an active mint first");
        }
        if (!info?.unit) {
          throw new Error("Mint info unavailable. Try switching mints.");
        }
        const identity = ensureNostrIdentity();
        if (!identity) {
          throw new Error(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        }
        const amountInput = amountInputRaw.trim();
        let amountSat: number | undefined;
        if (amountInput) {
          const { sats, error } = parseAmountInput(amountInputRaw);
          if (error) throw new Error(error);
          if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
          amountSat = sats;
        }
        const lockEnabled = options?.lockEnabled ?? paymentRequestLockEnabled;
        let resolvedLockPubkey = options?.lockPubkey ?? paymentRequestLockPubkey ?? "";
        if (lockEnabled && !resolvedLockPubkey && activeP2pkKey?.publicKey) {
          resolvedLockPubkey = activeP2pkKey.publicKey;
        }
        const wantsLock = lockEnabled && !!resolvedLockPubkey;
        if (lockEnabled && !resolvedLockPubkey) {
          throw new Error("Add a P2PK locking key first.");
        }
        const requestMode = options?.mode;
        const persistOpen = options?.persistOpen ?? true;
        const wantsSingleUse =
          requestMode === "single"
            ? true
            : requestMode === "multi"
            ? wantsLock
            : !!amountSat || wantsLock;
        if (!wantsSingleUse && !options?.forceNew) {
          const existing =
            openPaymentRequest && !openPaymentRequest.request.singleUse
              ? openPaymentRequest
              : loadStoredOpenPaymentRequest();
          if (existing) {
            setOpenPaymentRequest(existing);
            setCurrentPaymentRequest(existing);
            setPaymentRequestStatusMessage("");
            return existing;
          }
        }
        const transport: PaymentRequestTransport = {
          type: PaymentRequestTransportType.NOSTR,
          target: nip19.nprofileEncode({ pubkey: identity.pubkey, relays: defaultNostrRelays }),
          tags: [["n", "17"]],
        };
        const rawId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const requestId = rawId.slice(0, 16);
        const unit = (info?.unit || "sat").toLowerCase();
        const nut10Option = wantsLock
          ? ({
              kind: "P2PK",
              data: resolvedLockPubkey,
              tags: [["sigflag", "SIG_INPUTS"]],
            } as NonNullable<PaymentRequest["nut10"]>)
          : undefined;
        const request = new PaymentRequest(
          [transport],
          requestId,
          amountSat,
          unit,
          undefined,
          undefined,
          wantsSingleUse,
          nut10Option,
        );
        const encoded = request.toEncodedRequest();
        const nextRequest: ActivePaymentRequest = {
          id: requestId,
          encoded,
          request,
          amountSat,
          lockPubkey: wantsLock ? resolvedLockPubkey : null,
        };
        if (!wantsSingleUse && persistOpen) {
          setOpenPaymentRequest(nextRequest);
          persistOpenPaymentRequest(nextRequest);
        }
        setCurrentPaymentRequest(nextRequest);
        setPaymentRequestStatusMessage("");
        return nextRequest;
      } catch (err: any) {
        setPaymentRequestError(err?.message || String(err));
        return null;
      }
    }, [
      paymentRequestsEnabled,
      mintUrl,
      info?.unit,
      ensureNostrIdentity,
      nostrMissingReason,
      parseAmountInput,
      amountInputUnitLabel,
      paymentRequestLockEnabled,
      paymentRequestLockPubkey,
      activeP2pkKey,
      defaultNostrRelays,
      openPaymentRequest,
      loadStoredOpenPaymentRequest,
      persistOpenPaymentRequest,
    ]);

  const handleCreateEcashRequest = useCallback(async () => {
    const trimmedAmount = ecashRequestAmt.trim();
    let amountInput = trimmedAmount;
    let persistOpen = ecashRequestMode === "multi";
    if (ecashRequestMode === "multi") {
      const isOpenAmount =
        !trimmedAmount || parsedEcashRequestAmount.error || parsedEcashRequestAmount.sats === 0;
      if (isOpenAmount) {
        amountInput = "";
      } else {
        persistOpen = false;
      }
    } else {
      persistOpen = false;
    }
    const created = await createPaymentRequest(amountInput, {
      forceNew: true,
      mode: ecashRequestMode,
      persistOpen,
    });
    if (created) {
      setLastCreatedEcashRequest(created);
      setEcashReceiveView("request");
      if (ecashRequestMode === "single") {
        setEcashRequestAmt("");
      }
      setRecvMsg("");
    }
  }, [
    createPaymentRequest,
    ecashRequestAmt,
    ecashRequestMode,
    parsedEcashRequestAmount,
  ]);

  const ensureOpenPaymentRequest = useCallback(async () => {
    if (!paymentRequestsEnabled || !mintUrl || nostrMissingReason) return null;
    if (openPaymentRequest && !openPaymentRequest.request.singleUse) {
      if (!currentPaymentRequest || !currentPaymentRequest.request.singleUse) {
        if (!isSamePaymentRequest(currentPaymentRequest, openPaymentRequest)) {
          setCurrentPaymentRequest(openPaymentRequest);
        }
        setPaymentRequestStatusMessage("");
      }
      return openPaymentRequest;
    }
    const stored = loadStoredOpenPaymentRequest();
    if (stored) {
      if (!isSamePaymentRequest(openPaymentRequest, stored)) {
        setOpenPaymentRequest(stored);
      }
      if (!currentPaymentRequest || !currentPaymentRequest.request.singleUse) {
        if (!isSamePaymentRequest(currentPaymentRequest, stored)) {
          setCurrentPaymentRequest(stored);
        }
        setPaymentRequestStatusMessage("");
      }
      return stored;
    }
    const created = await createPaymentRequest("", { forceNew: true });
    if (created && !created.request.singleUse) {
      return created;
    }
    return null;
  }, [
    paymentRequestsEnabled,
    mintUrl,
    nostrMissingReason,
    openPaymentRequest,
    currentPaymentRequest,
    loadStoredOpenPaymentRequest,
    createPaymentRequest,
  ]);

  const handleClaimIncomingPayment = useCallback(
    async (entry: IncomingPaymentRequest) => {
      if (claimingEventSet.has(entry.eventId)) return;
      let fingerprint = entry.fingerprint ?? fingerprintIncomingToken(entry.token);
      if (isIncomingPaymentSpent(entry.eventId, fingerprint)) {
        return;
      }
      setClaimingEventIds((prev) => [...prev, entry.eventId]);
      try {
        const res = await receiveToken(entry.token);
        if (res.savedForLater) {
          setHistory((prev) => [
            buildHistoryEntry({
              id: `payment-request-pending-${entry.eventId}`,
              summary: `Saved ${entry.amount} sat${entry.amount === 1 ? "" : "s"} payment token for later redemption`,
              detail: entry.token,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: entry.amount,
              mintUrl: res.usedMintUrl ?? entry.mint ?? undefined,
              pendingTokenId: res.pendingTokenId,
              pendingTokenAmount: entry.amount,
              pendingTokenMint: res.usedMintUrl ?? entry.mint ?? undefined,
              pendingStatus: "pending",
            }),
            ...prev,
          ]);
          if (entry.id && currentPaymentRequest?.id === entry.id) {
            setPaymentRequestStatusMessage(
              "Payment received but will be redeemed when your connection returns.",
            );
          }
          showToast(
            `Saved ${formatSatAmount(entry.amount)} token for later redemption.`,
            5000,
          );
          if (!fingerprint) {
            fingerprint = fingerprintIncomingToken(entry.token);
          }
          if (fingerprint && !entry.fingerprint) {
            entry.fingerprint = fingerprint;
          }
          addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
          persistSpentIncomingEvents();
          return;
        }
        incomingPaymentRequestsRef.current = incomingPaymentRequestsRef.current.filter(
          (item) => item.eventId !== entry.eventId,
        );
        const now = Date.now();
        const tokenState = deriveSpentHistoryTokenStateFromToken(entry.token, now);
        setHistory((prev) => [
          buildHistoryEntry({
            id: `payment-request-recv-${entry.eventId}`,
            summary: `Received ${entry.amount} sats via payment request`,
            detail: entry.token,
            detailKind: "token",
            type: "ecash",
            direction: "in",
            amountSat: entry.amount,
            mintUrl: res.usedMintUrl ?? entry.mint ?? undefined,
            ...(tokenState ? { tokenState } : {}),
          }),
          ...prev,
        ]);
        if (entry.id && currentPaymentRequest?.id === entry.id) {
          setPaymentRequestStatusMessage("Payment received and claimed automatically.");
        }
        const amountLabel = formatSatAmount(entry.amount);
        let senderNip05: string | null = null;
        const normalizedSender = normalizeNostrPubkey(entry.sender);
        const senderHex = normalizedSender ? compressedToRawHex(normalizedSender).toLowerCase() : entry.sender.toLowerCase();
        if (senderHex && /^[0-9a-f]{64}$/.test(senderHex)) {
          const contact = contacts.find((c) => {
            const npub = normalizeNostrPubkey(c.npub || "");
            return npub ? compressedToRawHex(npub).toLowerCase() === senderHex : false;
          });
          if (contact?.nip05) {
            const nip05 = contact.nip05.trim();
            const normalizedNip05 = normalizeNip05(nip05);
            const check = nip05Checks[contact.id];
            const contactPubkeyHex = contact.npub
              ? compressedToRawHex(normalizeNostrPubkey(contact.npub) ?? contact.npub).toLowerCase()
              : "";
            if (
              normalizedNip05 &&
              check &&
              check.status === "valid" &&
              check.nip05 === normalizedNip05 &&
              check.npub === contactPubkeyHex
            ) {
              senderNip05 = nip05;
            }
          }
          if (!senderNip05) {
            const profile = dmPeerProfilesRef.current.get(senderHex);
            if (profile?.nip05) {
              const nip05 = profile.nip05.trim();
              const normalizedNip05 = normalizeNip05(nip05);
              const check = nip05Checks[`dm-${senderHex}`];
              if (
                normalizedNip05 &&
                check &&
                check.status === "valid" &&
                check.nip05 === normalizedNip05 &&
                check.npub === senderHex
              ) {
                senderNip05 = nip05;
              }
            }
          }
        }
        showToast(senderNip05 ? `Received ${amountLabel} from ${senderNip05}` : `Received ${amountLabel}`, 3500);
        if (res.crossMint) {
          showToast(`Redeemed to ${res.usedMintUrl}. Switch to view the balance.`, 5000);
        }
        if (!fingerprint) {
          fingerprint = fingerprintIncomingToken(entry.token);
        }
        if (fingerprint && !entry.fingerprint) {
          entry.fingerprint = fingerprint;
        }
        addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
        persistSpentIncomingEvents();
      } catch (err: any) {
        const message = err?.message || String(err);
        console.warn("Failed to claim incoming payment", err);
        if (isMintTokenAlreadySpentError(err)) {
          if (!fingerprint) {
            fingerprint = fingerprintIncomingToken(entry.token);
          }
          if (fingerprint && !entry.fingerprint) {
            entry.fingerprint = fingerprint;
          }
          addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
          incomingPaymentRequestsRef.current = incomingPaymentRequestsRef.current.filter(
            (item) => item.eventId !== entry.eventId,
          );
          persistSpentIncomingEvents();
          await requestNostrPaymentDeletion(entry.eventId, entry.sender, message);
        }
        showToast(message, 5000);
      } finally {
        setClaimingEventIds((prev) => prev.filter((id) => id !== entry.eventId));
      }
    },
    [
      addSpentIncomingPayment,
      buildHistoryEntry,
      claimingEventSet,
      compressedToRawHex,
      contacts,
      currentPaymentRequest,
      fingerprintIncomingToken,
      formatSatAmount,
      isIncomingPaymentSpent,
      nip05Checks,
      normalizeNip05,
      requestNostrPaymentDeletion,
      persistSpentIncomingEvents,
      receiveToken,
      setHistory,
      setPaymentRequestStatusMessage,
      showToast,
    ],
  );

  const scheduleAutoClaimRun = useCallback(() => {
    if (autoClaimRunningRef.current) return;
    autoClaimRunningRef.current = true;
    const processQueue = async () => {
      while (autoClaimQueueRef.current.length) {
        const entry = autoClaimQueueRef.current.shift();
        if (!entry) continue;
        let fingerprint = entry.fingerprint;
        if (!fingerprint) {
          fingerprint = fingerprintIncomingToken(entry.token);
          if (fingerprint) {
            entry.fingerprint = fingerprint;
          }
        }
        if (isIncomingPaymentSpent(entry.eventId, fingerprint)) {
          continue;
        }
        try {
          await handleClaimIncomingPayment(entry);
        } catch (err) {
          console.warn("Auto-claim payment request failed", err);
        }
      }
      autoClaimRunningRef.current = false;
    };
    void Promise.resolve().then(processQueue);
  }, [handleClaimIncomingPayment, fingerprintIncomingToken, isIncomingPaymentSpent]);

  const selectIncomingPaymentFromPayload = useCallback(
    (
      rawPayload:
        | PaymentRequestPayload
        | Record<string, unknown>
        | string
        | null
        | undefined,
    ): NormalizedIncomingPayment | null => {
      const payload = (() => {
        if (typeof rawPayload !== "string") return rawPayload;
        const trimmed = rawPayload.trim();
        if (!trimmed) return null;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          // fall through to token extraction
        }
        const extracted = extractFirstCashuTokenFromText(trimmed);
        if (!extracted) return null;
        return { token: extracted } as Record<string, unknown>;
      })();
      if (!payload || typeof payload !== "object") return null;
      const defaultUnit = (info?.unit || "sat").toLowerCase();
      const normalizedActiveMint = mintUrl ? normalizeMintUrl(mintUrl) : null;
      const entries: NormalizedIncomingPayment[] = [];
      const seenEntries = new Set<string>();

      const normalizeProofList = (input: unknown): Proof[] => {
        if (!Array.isArray(input) || !input.length) return [];
        const normalized: Proof[] = [];
        for (const rawProof of input) {
          if (!rawProof || typeof rawProof !== "object") continue;
          const rawAmount = (rawProof as any).amount;
          const amountValue =
            typeof rawAmount === "number"
              ? rawAmount
              : typeof rawAmount === "string"
                ? Number(rawAmount.trim())
                : NaN;
          if (!Number.isFinite(amountValue) || amountValue <= 0) continue;
          const secret = typeof (rawProof as any).secret === "string" ? (rawProof as any).secret.trim() : "";
          const C = typeof (rawProof as any).C === "string" ? (rawProof as any).C.trim() : "";
          const id = typeof (rawProof as any).id === "string" ? (rawProof as any).id.trim() : "";
          if (!secret || !C || !id) continue;
          const proof: Proof = {
            amount: Math.floor(amountValue),
            secret,
            C,
            id,
          };
          if ((rawProof as any).dleq) {
            proof.dleq = (rawProof as any).dleq as Proof["dleq"];
          }
          if ((rawProof as any).witness) {
            proof.witness = (rawProof as any).witness as Proof["witness"];
          }
          normalized.push(proof);
        }
        return normalized;
      };

      const pushEntry = (mint: unknown, proofs: unknown, unitHint?: unknown, encodedCandidate?: unknown) => {
        if (typeof mint !== "string") return;
        const trimmedMint = mint.trim();
        if (!trimmedMint) return;
        const normalizedProofs = normalizeProofList(proofs);
        if (!normalizedProofs.length) return;
        const amount = sumProofAmounts(normalizedProofs);
        if (!amount) return;
        const resolvedUnit =
          typeof unitHint === "string" && unitHint.trim() ? unitHint.toLowerCase() : defaultUnit;
        let encoded = typeof encodedCandidate === "string" ? encodedCandidate.trim() : "";
        if (encoded) {
          if (/^cashu:/i.test(encoded)) {
            encoded = extractCashuUriPayload(encoded);
          }
        } else {
          try {
            encoded = getEncodedToken({ mint: trimmedMint, proofs: normalizedProofs, unit: resolvedUnit });
          } catch (err) {
            console.warn("Failed to encode incoming payment proofs", err);
            return;
          }
        }
        if (!encoded) return;
        const key = `${normalizeMintUrl(trimmedMint)}::${encoded}`;
        if (seenEntries.has(key)) return;
        seenEntries.add(key);
        entries.push({ token: encoded, amount, mint: trimmedMint, unit: resolvedUnit });
      };

      const tokenStrings: string[] = [];
      const seenTokenStrings = new Set<string>();
      const pushTokenString = (value: unknown) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        if (!/cashu/i.test(trimmed)) return;
        if (seenTokenStrings.has(trimmed)) return;
        seenTokenStrings.add(trimmed);
        tokenStrings.push(trimmed);
      };

      const considerProofLike = (value: unknown, unitHint?: unknown) => {
        if (!value || typeof value !== "object") return;
        const maybeMint = (value as any)?.mint;
        const maybeProofs = (value as any)?.proofs;
        pushEntry(maybeMint, maybeProofs, (value as any)?.unit ?? unitHint);
      };

      considerProofLike(payload, (payload as any)?.unit);

      pushTokenString((payload as any)?.token);
      pushTokenString((payload as any)?.cashu);
      pushTokenString((payload as any)?.encodedToken);
      pushTokenString((payload as any)?.encoded_token);
      pushTokenString((payload as any)?.payment_request);
      pushTokenString((payload as any)?.request);

      const tokensField = (payload as any)?.tokens;
      if (Array.isArray(tokensField)) {
        for (const entry of tokensField) {
          pushTokenString(entry);
          considerProofLike(entry, (payload as any)?.unit);
        }
      }

      const tokenField = (payload as any)?.token;
      if (tokenField && typeof tokenField === "object") {
        considerProofLike(tokenField, (tokenField as any)?.unit ?? (payload as any)?.unit);
        const nestedTokens = (tokenField as any)?.token;
        if (typeof nestedTokens === "string") {
          pushTokenString(nestedTokens);
        } else if (Array.isArray(nestedTokens)) {
          for (const nested of nestedTokens) {
            pushTokenString(nested);
            considerProofLike(nested, (tokenField as any)?.unit ?? (payload as any)?.unit);
          }
        }
      }

      for (const rawToken of tokenStrings) {
        let normalizedToken = rawToken;
        if (/^cashu:/i.test(normalizedToken)) {
          normalizedToken = extractCashuUriPayload(normalizedToken);
        }
        if (!normalizedToken) continue;
        try {
          const decoded = decodeCashuTokenLoose(normalizedToken);
          if (!decoded) continue;
          const decodedEntries = Array.isArray((decoded as any)?.token)
            ? (decoded as any).token
            : (decoded as any)?.mint && Array.isArray((decoded as any)?.proofs)
              ? [decoded]
              : [];
          const decodedUnit = (decoded as any)?.unit;
          for (const entry of decodedEntries) {
            considerProofLike(entry, decodedUnit ?? (entry as any)?.unit ?? (payload as any)?.unit);
            pushEntry(
              (entry as any)?.mint,
              (entry as any)?.proofs,
              decodedUnit ?? (entry as any)?.unit ?? (payload as any)?.unit,
              normalizedToken,
            );
          }
        } catch (err) {
          if (walletDebugEnabled) {
            console.warn("Failed to decode token from payment payload", err);
          }
        }
      }

      if (!entries.length) return null;

      entries.sort((a, b) => {
        const aMatches = normalizedActiveMint
          ? normalizeMintUrl(a.mint) === normalizedActiveMint
          : false;
        const bMatches = normalizedActiveMint
          ? normalizeMintUrl(b.mint) === normalizedActiveMint
          : false;
        if (aMatches !== bMatches) {
          return aMatches ? -1 : 1;
        }
        if (b.amount !== a.amount) {
          return b.amount - a.amount;
        }
        return a.token.localeCompare(b.token);
      });

      return entries[0] ?? null;
    },
    [info?.unit, mintUrl, walletDebugEnabled],
  );

  const processIncomingPaymentPayload = useCallback(
    (
      payload: PaymentRequestPayload | string,
      event: NostrEvent,
      normalizedOverride?: NormalizedIncomingPayment | null,
      senderOverride?: string | null,
    ) => {
      const normalized = normalizedOverride ?? selectIncomingPaymentFromPayload(payload);
      if (!normalized) return;
      const { token: encoded, amount, mint, unit } = normalized;
      const fingerprint = fingerprintIncomingToken(encoded);
      if (isIncomingPaymentSpent(event.id, fingerprint)) {
        return;
      }
      const receivedAt = (event.created_at || Math.floor(Date.now() / 1000)) * 1000;
      let createdEntry: IncomingPaymentRequest | null = null;
      const existing = incomingPaymentRequestsRef.current;
      if (existing.some((entry) => entry.eventId === event.id)) {
        return;
      }
      const payloadId =
        payload && typeof payload === "object" && "id" in payload
          ? ((payload as PaymentRequestPayload).id ?? null)
          : null;
      let sender = (event.pubkey || "").toLowerCase();
      if (senderOverride && typeof senderOverride === "string") {
        const normalizedSender = normalizeNostrPubkey(senderOverride);
        if (normalizedSender) {
          const rawSender = compressedToRawHex(normalizedSender).toLowerCase();
          if (/^[0-9a-f]{64}$/.test(rawSender)) {
            sender = rawSender;
          }
        }
      }
      if (sender) {
        void ensurePeerProfile(sender);
      }
      const nextEntry: IncomingPaymentRequest = {
        eventId: event.id,
        id: payloadId,
        token: encoded,
        amount,
        mint,
        unit,
        sender,
        receivedAt,
        fingerprint,
      };
      createdEntry = nextEntry;
      const combined = [nextEntry, ...existing].sort((a, b) => b.receivedAt - a.receivedAt);
      incomingPaymentRequestsRef.current = combined.slice(0, 100);
      if (paymentRequestsEnabled && createdEntry) {
        autoClaimQueueRef.current.push(createdEntry);
        scheduleAutoClaimRun();
      }
      if (payloadId && currentPaymentRequest?.id === payloadId) {
        setPaymentRequestStatusMessage("Payment received. Claiming automatically…");
      }
    },
    [
      compressedToRawHex,
      currentPaymentRequest,
      ensurePeerProfile,
      paymentRequestsEnabled,
      scheduleAutoClaimRun,
      selectIncomingPaymentFromPayload,
      fingerprintIncomingToken,
      isIncomingPaymentSpent,
    ],
  );

  const stopPaymentRequestSubscription = useCallback(() => {
    if (nostrSubscriptionCloserRef.current) {
      try { nostrSubscriptionCloserRef.current(); } catch {}
      nostrSubscriptionCloserRef.current = null;
    }
    nostrSubscriptionActiveRef.current = false;
  }, []);

  const startPaymentRequestSubscription = useCallback(async () => {
    if (!paymentRequestsEnabled || nostrSubscriptionActiveRef.current) return;
    if (!paymentRequestsBackgroundChecksEnabled && !open) return;
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    const now = Math.floor(Date.now() / 1000);
    const initialLastCheck = nostrLastCheckRef.current || now - PAYMENT_REQUEST_LOOKBACK_SECONDS;
    const normalizedLastCheck = Math.max(0, Math.min(initialLastCheck, now));
    const since = Math.max(0, normalizedLastCheck - PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS);
    nostrLastCheckRef.current = normalizedLastCheck;
    try {
      const session = await NostrSession.init(relays);
      if (nostrSubscriptionCloserRef.current) {
        stopPaymentRequestSubscription();
      }
      const managed = await session.subscribe(
        [{ kinds: [4, 1059], "#p": [identity.pubkey], since }],
        {
          relayUrls: relays,
          onEvent: (ev) => {
            const handler = handlePaymentRequestEventRef.current;
            if (handler) {
              void handler(ev as NostrEvent, { updateClock: true });
            }
          },
        },
      );
      nostrSubscriptionCloserRef.current = () => {
        try { managed.release(); } catch {}
        nostrSubscriptionActiveRef.current = false;
      };
      nostrSubscriptionActiveRef.current = true;
    } catch (err) {
      console.warn("Failed to start payment request subscription", err);
    }
  }, [
    PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS,
    PAYMENT_REQUEST_LOOKBACK_SECONDS,
    defaultNostrRelays,
    ensureNostrIdentity,
    open,
    paymentRequestsEnabled,
    paymentRequestsBackgroundChecksEnabled,
    stopPaymentRequestSubscription,
  ]);

  const deepSyncDMs = useCallback(async () => {
    if (!paymentRequestsEnabled) return;
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    try {
      const session = await NostrSession.init(relays);
      const since = Math.max(
        0,
        Math.floor(Date.now() / 1000) - PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS,
      );
      const events = await session.fetchEvents(
        [{ kinds: [4, 1059], "#p": [identity.pubkey], since }],
        relays,
      );
      const ordered = events
        .filter((event) => event && (event.kind === 4 || event.kind === 1059))
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      for (const event of ordered) {
        const handler = handlePaymentRequestEventRef.current;
        if (handler) {
          await handler(event, { updateClock: false });
        }
      }
    } catch (err) {
      console.warn("Deep DM sync failed", err);
    }
  }, [
    PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS,
    defaultNostrRelays,
    ensureNostrIdentity,
    paymentRequestsEnabled,
  ]);

  return {
    persistSpentIncomingEvents,
    requestNostrPaymentDeletion,
    loadStoredOpenPaymentRequest,
    persistOpenPaymentRequest,
    createPaymentRequest,
    handleCreateEcashRequest,
    ensureOpenPaymentRequest,
    handleClaimIncomingPayment,
    scheduleAutoClaimRun,
    selectIncomingPaymentFromPayload,
    processIncomingPaymentPayload,
    stopPaymentRequestSubscription,
    startPaymentRequestSubscription,
    deepSyncDMs,
  };
}
