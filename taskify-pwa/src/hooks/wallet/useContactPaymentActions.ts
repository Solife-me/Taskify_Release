// @ts-nocheck
import { useCallback } from "react";
import { nip19, nip44 } from "nostr-tools";
import {
  decodePaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestTransport,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import { type P2PKKey } from "../../context/P2PKContext";
import { contactDisplayLabel, contactPrimaryName, type Contact } from "../../lib/contacts";
import { SATS_PER_BTC } from "../wallet/useWalletPrice";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { normalizeMintUrl } from "../../wallet/cashuProofHelpers";
import type { CreateSendTokenOptions } from "../../mint/MintSession";
import type { HistoryTokenState, StoredProofForState } from "../../wallet/walletHistoryTypes";
import type { GroupChat } from "../../lib/groupChatState";
import type { WalletDmThread } from "../wallet/useDmState";

export function useContactPaymentActions({
  // Reactive state
  mintUrl,
  info,
  activeThread,
  activeGroupChat,
  renameGroupDraft,
  activeP2pkKey,
  lnInput,
  walletConversionEnabled,
  walletPrimaryCurrency,
  sendAmt,
  btcUsdPrice,
  lockSendToPubkey,
  sendLockPubkeyInput,
  // Stable refs
  contactsContextRef,
  lnRef,
  lnInputValueRef,
  proofStateSubscriptionMetadataRef,
  // Stable setters
  setPaymentRequestState,
  setPaymentRequestManualAmount,
  setPaymentRequestStatus,
  setPaymentRequestMessage,
  setReceiveMode,
  setSendMode,
  setShowSendOptions,
  setScannerMessage,
  setContactsContext,
  setContactsOpen,
  setLnInput,
  setLightningSendView,
  setLnAddrAmt,
  setLnState,
  setLnError,
  setRenameGroupDraft,
  setChatView,
  setRenameGroupBusy,
  setShareContactStatus,
  setShareContactBusy,
  setShareContactPickerOpen,
  setShareContactPickerMode,
  setShareContactSource,
  setCreatingSendToken,
  setSendTokenStr,
  setLastSendTokenAmount,
  setLastSendTokenMint,
  setLastSendTokenFingerprint,
  setLastSendTokenLockLabel,
  setEcashSendView,
  setEcashSendRecipient,
  setReceiveLockVisible,
  setPrimaryP2pkKey,
  setPendingPrimaryP2pkKeyId,
  setHistory,
  // Stable functions
  showToast,
  generateP2pkKeypair,
  buildHistoryEntry,
  formatNpub,
  compressedToRawHex,
  createSendToken,
  computeProofY,
  buildTokenSpentToastMessage,
  sanitizeProofStateValue,
  aggregateStoredProofStates,
  summarizeStoredProofStates,
  readNostrIdentity,
  resolveNip17Relays,
  ensureNostrPool,
  safePublish,
  publishNip17Giftwraps,
  publishGroupSubjectUpdate,
  upsertGroupChat,
  sendContactShareToPubkeys,
  defaultNostrRelays,
}: {
  mintUrl: string;
  info: { unit?: string } | null;
  activeThread: WalletDmThread | null;
  activeGroupChat: GroupChat | null;
  renameGroupDraft: string;
  activeP2pkKey: P2PKKey | null;
  lnInput: string;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: string;
  sendAmt: string;
  btcUsdPrice: number | null;
  lockSendToPubkey: boolean;
  sendLockPubkeyInput: string;
  contactsContextRef: React.MutableRefObject<string | null>;
  lnRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  lnInputValueRef: React.MutableRefObject<string>;
  proofStateSubscriptionMetadataRef: React.MutableRefObject<
    Map<string, { secretToItem: Map<string, { itemId: string; proofIndex: number }> }>
  >;
  setPaymentRequestState: (state: { encoded: string; request: any } | null) => void;
  setPaymentRequestManualAmount: (amt: string) => void;
  setPaymentRequestStatus: (status: "idle" | "sending" | "done" | "error") => void;
  setPaymentRequestMessage: (msg: string) => void;
  setReceiveMode: (mode: null | "ecash" | "lightning" | "lnurlWithdraw") => void;
  setSendMode: (mode: null | "ecash" | "lightning" | "paymentRequest") => void;
  setShowSendOptions: (show: boolean) => void;
  setScannerMessage: (msg: string) => void;
  setContactsContext: (ctx: "lightning" | "ecash" | null) => void;
  setContactsOpen: (open: boolean) => void;
  setLnInput: (val: string) => void;
  setLightningSendView: (view: string) => void;
  setLnAddrAmt: (amt: string) => void;
  setLnState: (state: string) => void;
  setLnError: (err: string) => void;
  setRenameGroupDraft: (name: string) => void;
  setChatView: (view: string) => void;
  setRenameGroupBusy: (busy: boolean) => void;
  setShareContactStatus: (status: string | null) => void;
  setShareContactBusy: (busy: boolean) => void;
  setShareContactPickerOpen: (open: boolean) => void;
  setShareContactPickerMode: (mode: string) => void;
  setShareContactSource: (source: Contact | null) => void;
  setCreatingSendToken: (creating: boolean) => void;
  setSendTokenStr: (token: string) => void;
  setLastSendTokenAmount: (amt: number) => void;
  setLastSendTokenMint: (mint: string) => void;
  setLastSendTokenFingerprint: (fp: string) => void;
  setLastSendTokenLockLabel: (label: string | null) => void;
  setEcashSendView: (view: string) => void;
  setEcashSendRecipient: (contact: Contact | null) => void;
  setReceiveLockVisible: (visible: boolean) => void;
  setPrimaryP2pkKey: (id: string) => void;
  setPendingPrimaryP2pkKeyId: (id: string) => void;
  setHistory: (updater: any) => void;
  showToast: (msg: string, duration?: number) => void;
  generateP2pkKeypair: () => P2PKKey;
  buildHistoryEntry: (input: any) => any;
  formatNpub: (pubkey: string) => string;
  compressedToRawHex: (compressed: string) => string;
  createSendToken: (amt: number, options?: CreateSendTokenOptions) => Promise<any>;
  computeProofY: (secret: string) => string | null;
  buildTokenSpentToastMessage: (proofs: StoredProofForState[]) => string;
  sanitizeProofStateValue: (state: string) => string | null;
  aggregateStoredProofStates: (proofs: StoredProofForState[]) => string | null;
  summarizeStoredProofStates: (proofs: StoredProofForState[]) => string | null;
  readNostrIdentity: () => { identity: any; reason?: string };
  resolveNip17Relays: (recipientHex: string, relays: string[]) => Promise<string[]>;
  ensureNostrPool: () => any;
  safePublish: (pool: any, relays: string[], event: any) => Promise<void>;
  publishNip17Giftwraps: (opts: any) => Promise<void>;
  publishGroupSubjectUpdate: (group: GroupChat, name: string) => Promise<boolean>;
  upsertGroupChat: (group: GroupChat) => void;
  sendContactShareToPubkeys: (contact: Contact, pubkeys: string[]) => Promise<{ ok: boolean; error?: string }>;
  defaultNostrRelays: string[];
}) {
  const resetContactForm = useCallback(() => {}, []);

  const handleGenerateP2pkKey = useCallback((): P2PKKey | null => {
    try {
      const key = generateP2pkKeypair();
      setPrimaryP2pkKey(key.id);
      showToast("Generated new P2PK key", 2500);
      setPendingPrimaryP2pkKeyId(key.id);
      return key;
    } catch (err: any) {
      showToast(err?.message || "Unable to generate key");
      return null;
    }
  }, [generateP2pkKeypair, setPrimaryP2pkKey, showToast]);

  const handleOpenReceiveLock = useCallback(() => {
    if (!activeP2pkKey) {
      const generated = handleGenerateP2pkKey();
      if (!generated) {
        return;
      }
    }
    setReceiveLockVisible(true);
  }, [activeP2pkKey, handleGenerateP2pkKey]);

  const readLightningInput = useCallback(() => {
    const current = lnRef.current?.value ?? lnInputValueRef.current ?? lnInput;
    return typeof current === "string" ? current : "";
  }, [lnInput]);

  const commitLightningInputFromDom = useCallback(
    (value?: string) => {
      const next = typeof value === "string" ? value : readLightningInput();
      setLnInput(next);
      return next;
    },
    [readLightningInput, setLnInput],
  );

  const handleSendChatContactAttachment = useCallback(
    async (contact: Contact) => {
      if (!activeThread) {
        setShareContactStatus("Open a conversation first.");
        return;
      }
      const ownIdentity = readNostrIdentity().identity;
      const recipients = activeThread.groupId && activeGroupChat
        ? activeGroupChat.members
            .map((member) => member.toLowerCase())
            .filter((member) => member && member !== ownIdentity?.pubkey.toLowerCase())
        : [activeThread.peerPubkey.toLowerCase()].filter(Boolean);
      if (!recipients.length) {
        setShareContactStatus("No recipients available for this conversation.");
        return;
      }
      setShareContactBusy(true);
      setShareContactStatus(null);
      try {
        const result = await sendContactShareToPubkeys(contact, recipients);
        if (!result.ok) {
          setShareContactStatus(result.error || "Unable to send contact.");
          return;
        }
        setShareContactPickerOpen(false);
        setShareContactPickerMode("recipient");
        setShareContactSource(null);
        showToast(
          activeThread.groupId
            ? `Shared ${contactPrimaryName(contact)} with ${activeGroupChat?.name || "the group"}`
            : `Sent ${contactPrimaryName(contact)}`,
          3000,
        );
      } catch (err: any) {
        setShareContactStatus(err?.message || "Unable to send contact.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      activeGroupChat,
      activeThread,
      readNostrIdentity,
      sendContactShareToPubkeys,
      showToast,
    ],
  );

  const handlePaymentRequestScan = useCallback(async (encodedRequest: string): Promise<boolean> => {
    const trimmed = encodedRequest?.trim() || "";
    if (!trimmed) return false;
    if (!/^creq/i.test(trimmed)) {
      return false;
    }
    try {
      const request = decodePaymentRequest(trimmed);
      if (request.mints && request.mints.length) {
        if (!mintUrl) {
          throw new Error("Set an active mint before fulfilling payment requests");
        }
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }
      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      setPaymentRequestState({ encoded: trimmed, request });
      const numericAmount = Number(request.amount);
      setPaymentRequestManualAmount(
        Number.isFinite(numericAmount) && numericAmount > 0 ? String(Math.floor(numericAmount)) : "",
      );
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setReceiveMode(null);
      setSendMode("paymentRequest");
      setShowSendOptions(true);
      setScannerMessage("");
      return true;
    } catch (err: any) {
      console.warn("Payment request scan failed", err);
      setPaymentRequestState(null);
      setPaymentRequestStatus("error");
      setPaymentRequestMessage("");
      setPaymentRequestManualAmount("");
      setScannerMessage(err?.message || "Invalid payment request");
      return false;
    }
  }, [info?.unit, mintUrl]);

  const openContactsFor = useCallback(
    (context: "lightning" | "ecash") => {
      contactsContextRef.current = context;
      setContactsContext(context);
      setContactsOpen(true);
    },
    [setContactsContext, setContactsOpen],
  );

  const closeContactsSheet = useCallback(() => {
    setContactsOpen(false);
  }, []);

  const applyLightningContact = useCallback(
    (contact: Contact) => {
      if (!contact.address.trim()) {
        alert("This contact does not have a lightning address stored.");
        return false;
      }
      setSendMode("lightning");
      setShowSendOptions(true);
      setLnInput(contact.address);
      setLightningSendView("address");
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
      setTimeout(() => {
        lnRef.current?.focus();
      }, 0);
      return true;
    },
    [
      lnRef,
      setLnAddrAmt,
      setLnError,
      setLnInput,
      setLnState,
      setLightningSendView,
      setSendMode,
      setShowSendOptions,
    ],
  );

  const openGroupNameEditor = useCallback(() => {
    if (!activeGroupChat) return;
    setRenameGroupDraft(activeGroupChat.name || "");
    setChatView("group-name-edit");
  }, [activeGroupChat]);

  const handleRenameGroupSubmit = useCallback(() => {
    if (!activeGroupChat) return;
    const nextName = renameGroupDraft.trim();
    if (!nextName) {
      showToast("Enter a group name", 2500);
      return;
    }
    const currentName = (activeGroupChat.name || "").trim();
    if (nextName === currentName) {
      setChatView("group-info");
      return;
    }

    const renameTimestamp = Math.floor(Date.now() / 1000);
    const updatedGroup = { ...activeGroupChat, name: nextName, nameUpdatedAt: renameTimestamp };
    upsertGroupChat(updatedGroup);
    setRenameGroupBusy(true);
    setChatView("group-info");

    void (async () => {
      let synced = false;
      try {
        synced = await publishGroupSubjectUpdate(updatedGroup, nextName);
      } catch (err) {
        console.warn("[chat] group rename publish failed", err);
      } finally {
        setRenameGroupBusy(false);
      }

      showToast(
        synced ? "Group name updated" : "Group name updated locally. It will sync on your next message.",
        synced ? 2200 : 4200,
      );
    })();
  }, [activeGroupChat, publishGroupSubjectUpdate, renameGroupDraft, setChatView, showToast, upsertGroupChat]);

  const applyEcashContact = useCallback(
    async (contact: Contact) => {
      const { identity, reason } = readNostrIdentity();
      if (!identity) {
        showToast(reason || "Add your Taskify Nostr key in Settings → Nostr.", 4000);
        return false;
      }
      const primaryCurrencyForAmount = walletConversionEnabled ? walletPrimaryCurrency : "sat";
      const unitLabelLocal = primaryCurrencyForAmount === "usd" ? "USD" : "sats";
      const trimmedSendAmt = sendAmt.trim();
      let sats = 0;
      if (trimmedSendAmt) {
        const numeric = Number(trimmedSendAmt);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          showToast(`Enter amount in ${unitLabelLocal}`, 4500);
          return false;
        }
        if (primaryCurrencyForAmount === "usd") {
          if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
            showToast("USD price unavailable. Try again in a moment.", 4500);
            return false;
          }
          sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
          if (sats <= 0) {
            showToast("Amount too small. Increase the USD value.", 4500);
            return false;
          }
        } else {
          sats = Math.floor(numeric);
        }
      }
      if (!sats) {
        showToast(`Enter amount in ${unitLabelLocal}`, 3500);
        return false;
      }

      let recipientPubkey: string | null = null;
      let relayHints: string[] | undefined;

      const contactNpub = normalizeNostrPubkey(contact.npub);
      if (contactNpub) {
        recipientPubkey = compressedToRawHex(contactNpub).toLowerCase();
        relayHints = contact.relays;
      } else {
        const storedRequest = contact.paymentRequest?.trim?.() ?? "";
        if (storedRequest) {
          try {
            const request = decodePaymentRequest(storedRequest);
            const transport = request.getTransport(PaymentRequestTransportType.NOSTR) as PaymentRequestTransport | undefined;
            if (transport?.target) {
              const decoded = nip19.decode(transport.target);
              if (decoded.type === "nprofile") {
                const data = decoded.data as { pubkey?: string; relays?: string[] };
                if (typeof data.pubkey === "string") {
                  recipientPubkey = data.pubkey;
                }
                if (Array.isArray(data.relays)) {
                  relayHints = data.relays.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
                }
              } else if (decoded.type === "npub") {
                recipientPubkey = typeof decoded.data === "string" ? decoded.data : null;
              }
            }
          } catch (err) {
            console.warn("Failed to decode contact payment request for recipient", err);
          }
        }
      }

      if (!recipientPubkey) {
        showToast("Contact is missing a valid npub.", 3500);
        return false;
      }

      const relays = Array.from(
        new Set(
          [
            ...(relayHints || []),
            ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
          ].filter(Boolean),
        ),
      );
      if (!relays.length) {
        showToast("Add at least one relay to send.", 3500);
        return false;
      }

      if (!nip44?.v2) {
        showToast("NIP-44 support is required to send eCash via NIP-17.", 4500);
        return false;
      }

      setCreatingSendToken(true);
      try {
        let lockOptions: CreateSendTokenOptions | undefined;
        if (lockSendToPubkey) {
          const lockPubkey = normalizeNostrPubkey(sendLockPubkeyInput) || normalizeNostrPubkey(recipientPubkey);
          if (!lockPubkey) {
            showToast("Enter a valid npub or 64-character hex key to lock the token.", 4000);
            return false;
          }
          lockOptions = { p2pk: { pubkey: lockPubkey } };
        }

        const { token, proofs: sentProofs, mintUrl: sentMintUrl, lockInfo } = await createSendToken(sats, lockOptions);
        setSendTokenStr(token);
        setLastSendTokenAmount(sats);
        setLastSendTokenMint(sentMintUrl);
        setLastSendTokenFingerprint(`${sats}|contact:${recipientPubkey}:${Date.now()}`);
        if (lockInfo?.type === "p2pk") {
          const labelSource = Array.isArray(lockInfo.options.pubkey)
            ? lockInfo.options.pubkey.join(", ")
            : lockInfo.options.pubkey;
          setLastSendTokenLockLabel(`Locked to ${labelSource}`);
        } else {
          setLastSendTokenLockLabel(null);
        }
        setEcashSendView("token");
        setHistory((h) => [
          buildHistoryEntry({
            id: `token-dm-${Date.now()}`,
            summary: `Sent ${sats} sats to ${contactDisplayLabel(contact)}`,
            detail: token,
            detailKind: "token",
            revertToken: token,
            type: "ecash",
            direction: "out",
            amountSat: sats,
            mintUrl: sentMintUrl,
            tokenState:
              sentProofs?.length
                ? {
                    mintUrl: sentMintUrl,
                    proofs: sentProofs.map((proof) => {
                      const stored: StoredProofForState = {
                        secret: proof.secret,
                        amount: proof.amount,
                        id: proof.id,
                        C: proof.C,
                      };
                      if (proof.witness) stored.witness = proof.witness;
                      const y = computeProofY(proof.secret);
                      if (y) stored.Y = y;
                      return stored;
                    }),
                    lastState: "UNSPENT",
                  }
                : undefined,
          }),
          ...h,
        ]);

        const senderNpub = formatNpub(identity.pubkey);
        const dmPlain = `nostr:${senderNpub} sent you ${sats} SAT from Taskify wallet!\n${token}`;
        const recipientHex = recipientPubkey.toLowerCase();
        const senderHex = identity.pubkey.toLowerCase();
        const publishRelays = await resolveNip17Relays(recipientHex, relays);
        if (!publishRelays.length) {
          throw new Error("No relays available for NIP-17 inbox");
        }
        const pool = ensureNostrPool();
        const publish = (event: any) => safePublish(pool, publishRelays, event);
        await publishNip17Giftwraps({
          content: dmPlain,
          senderHex,
          recipientHex,
          senderSecret: identity.secret,
          publish,
        });
        showToast(`Sent ${sats} sat${sats === 1 ? "" : "s"} to ${contactDisplayLabel(contact)}`, 3500);
        return true;
      } catch (err: any) {
        const message = err?.message || String(err);
        console.warn("Failed to send eCash DM", err);
        showToast(message, 5000);
        return false;
      } finally {
        setCreatingSendToken(false);
      }
    },
    [
      btcUsdPrice,
      buildHistoryEntry,
      compressedToRawHex,
      contactDisplayLabel,
      createSendToken,
      defaultNostrRelays,
      ensureNostrPool,
      formatNpub,
      lockSendToPubkey,
      normalizeNostrPubkey,
      readNostrIdentity,
      publishNip17Giftwraps,
      resolveNip17Relays,
      safePublish,
      sendAmt,
      sendLockPubkeyInput,
      setHistory,
      showToast,
      walletConversionEnabled,
      walletPrimaryCurrency,
    ],
  );

  const handleSelectContact = useCallback(
    (contact: Contact) => {
      const context = contactsContextRef.current;
      if (context === "lightning") {
        applyLightningContact(contact);
      } else if (context === "ecash") {
        setEcashSendRecipient(contact);
        setEcashSendView("contact");
      }
      setContactsOpen(false);
      resetContactForm();
    },
    [applyLightningContact, resetContactForm],
  );

  const handleProofStateNotification = useCallback(
    (mintKey: string, payload: ProofState & { proof: Proof }) => {
      const meta = proofStateSubscriptionMetadataRef.current.get(mintKey);
      if (!meta) return;
      const secret = payload.proof?.secret;
      if (!secret) return;
      const target = meta.secretToItem.get(secret);
      if (!target) return;
      let toastMessageLocal: string | null = null;
      setHistory((prev) =>
        prev.map((entry) => {
          if (entry.id !== target.itemId || !entry.tokenState) return entry;
          const proofs = entry.tokenState.proofs;
          if (!proofs[target.proofIndex]) return entry;
          const nextProofs = proofs.map((stored, idx) => {
            if (idx !== target.proofIndex) return stored;
            let updated = stored;
            if (payload.Y && stored.Y !== payload.Y) {
              updated = { ...updated, Y: payload.Y };
            } else if (!stored.Y) {
              const computed = computeProofY(stored.secret);
              if (computed) {
                updated = { ...updated, Y: computed };
              }
            }
            if (payload.witness && payload.witness !== stored.witness) {
              updated = { ...updated, witness: payload.witness };
            }
            const normalizedState = sanitizeProofStateValue(payload.state);
            if (normalizedState && normalizedState !== stored.lastState) {
              updated = { ...updated, lastState: normalizedState };
            }
            return updated;
          });
          const aggregated =
            aggregateStoredProofStates(nextProofs) ?? entry.tokenState.lastState;
          const summaryValue = summarizeStoredProofStates(nextProofs);
          const mergedWitnesses = { ...(entry.tokenState.lastWitnesses ?? {}) };
          const yKey = payload.Y ?? nextProofs[target.proofIndex]?.Y;
          if (payload.witness && yKey) {
            mergedWitnesses[yKey] = payload.witness;
          }
          const mergedWitnessesValue = Object.keys(mergedWitnesses).length
            ? mergedWitnesses
            : entry.tokenState.lastWitnesses;
          const shouldNotify = aggregated === "SPENT" && entry.tokenState.notifiedSpent !== true;
          if (shouldNotify) {
            toastMessageLocal = buildTokenSpentToastMessage(nextProofs);
          }
          const nextTokenState: HistoryTokenState = {
            ...entry.tokenState,
            proofs: nextProofs,
            lastState: aggregated ?? entry.tokenState.lastState,
            lastSummary: summaryValue || entry.tokenState.lastSummary,
            lastCheckedAt: Date.now(),
            lastWitnesses: mergedWitnessesValue,
            notifiedSpent: aggregated === "SPENT" ? true : entry.tokenState.notifiedSpent,
          };
          return {
            ...entry,
            summary:
              aggregated === "SPENT" && !entry.summary.includes("(spent)")
                ? `${entry.summary} (spent)`
                : entry.summary,
            tokenState: nextTokenState,
          };
        }),
      );
      if (toastMessageLocal) {
        showToast(toastMessageLocal, 3500);
      }
    },
    [setHistory, showToast],
  );

  return {
    resetContactForm,
    handleGenerateP2pkKey,
    handleOpenReceiveLock,
    readLightningInput,
    commitLightningInputFromDom,
    handleSendChatContactAttachment,
    handlePaymentRequestScan,
    openContactsFor,
    closeContactsSheet,
    applyLightningContact,
    openGroupNameEditor,
    handleRenameGroupSubmit,
    applyEcashContact,
    handleSelectContact,
    handleProofStateNotification,
  };
}
