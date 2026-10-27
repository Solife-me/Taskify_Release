// @ts-nocheck
// TODO: Continue breaking up this still-large wallet surface. Extract more custom hooks
// (wallet state, mint management, send/receive flows, payment requests, NWC,
// nostr DM redemption, lightning, swaps) into src/hooks/wallet/ and split
// sub-views into smaller components to reduce this file's size.
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PaymentRequestTransportType,
  type PaymentRequestTransport,
  type Proof,
} from "@cashu/cashu-ts";
import { nip19, nip44 } from "nostr-tools";
import { useCashu } from "../context/walletContexts";
import { useNwc } from "../context/walletContexts";
import { setWalletMode, useWalletMode } from "../wallet/walletMode";
import { useWalletEnabled } from "../wallet/walletAvailability";
import { useNwcWalletMode } from "../hooks/wallet/useNwcWalletMode";
import { useNwcSweeps } from "../hooks/wallet/useNwcSweeps";
import { NwcWalletModeSheet } from "../ui/wallet/NwcWalletModeSheet";
import { StoredTokensSheet } from "../ui/wallet/StoredTokensSheet";
import { useToast } from "../context/ToastContext";
import { useP2PK } from "../context/walletContexts";
import type { P2PKKey } from "../context/P2PKContext";
import {
  Nut16Collector,
} from "../wallet/nut16";
import { decodeBolt11Amount } from "../wallet/lightning";


import { revealLocalSecretKey } from "../identity/identity";
import { kvStorage } from "../storage/kvStorage";
import { normalizeNostrPubkey } from "../lib/nostr";




import type { CreateSendTokenOptions } from "../mint/MintSession";
import {
  deriveNpubCashIdentity,
} from "../wallet/npubCash";
import {
  SOLIFE_LIGHTNING_ADDRESS_DOMAIN,
} from "../wallet/solife";
import { ActionSheet } from "./ActionSheet";
import {
  contactHasLightning,
} from "../lib/contacts";
import {
  aggregateStoredProofStates,
  computeProofY,
  deriveTimestampFromId,
  normalizeMintUrl,
  normalizeProofAmount,
  sanitizeProofStateValue,
  sumProofAmounts,
  summarizeStoredProofStates,
} from "../wallet/cashuProofHelpers";
import {
  deriveSpentHistoryTokenStateFromToken,
  type HistoryDetailKind,
  type HistoryItem,
  type StoredProofForState,
} from "../wallet/walletHistoryTypes";
import { useWalletHistory } from "../hooks/wallet/useWalletHistory";
import { usePendingTokenHistorySync } from "../hooks/wallet/usePendingTokenHistorySync";
import { useMintBackup } from "../hooks/wallet/useMintBackup";
import { useMintSelection } from "../hooks/wallet/useMintSelection";
import { useNwcManager } from "../hooks/wallet/useNwcManager";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { SATS_PER_BTC, useWalletPrice } from "../hooks/wallet/useWalletPrice";
import { useWalletSwapFlow } from "../hooks/wallet/useWalletSwapFlow";
import { useLightningFlow, type LnurlPayData } from "../hooks/wallet/useLightningFlow";
import { useEcashReceiveState } from "../hooks/wallet/useEcashReceiveState";
import { useEcashSendState } from "../hooks/wallet/useEcashSendState";
import { usePaymentRequestState } from "../hooks/wallet/usePaymentRequestState";
import { useNostrPoolState } from "../hooks/wallet/useNostrPoolState";
import { useWalletContactsRuntime } from "../ui/wallet/useWalletContactsRuntime";
import { useManualSendPlan } from "../hooks/wallet/useManualSendPlan";
import { useScannerFlow } from "../hooks/wallet/useScannerFlow";
import { useEcashRedeem } from "../hooks/wallet/useEcashRedeem";
import { useSheetManagement } from "../hooks/wallet/useSheetManagement";
import { useNpubCashClaim } from "../hooks/wallet/useNpubCashClaim";
import { useHistoryFormatters } from "../hooks/wallet/useHistoryFormatters";
import { useWalletFormatters } from "../hooks/wallet/useWalletFormatters";
import { useAmountKeypadHandlers } from "../hooks/wallet/useAmountKeypadHandlers";
import { usePaymentRequestFlow } from "../hooks/wallet/usePaymentRequestFlow";


import { useTokenHistoryActions } from "../hooks/wallet/useTokenHistoryActions";
import { useContactPaymentActions } from "../hooks/wallet/useContactPaymentActions";
import { useWalletFlowState } from "../hooks/wallet/useWalletFlowState";
import { useAmountFormatters } from "../hooks/wallet/useAmountFormatters";
import { useLightningInputDerived } from "../hooks/wallet/useLightningInputDerived";
import { useHistoryFilter } from "../hooks/wallet/useHistoryFilter";
import { usePaymentRequestDerived } from "../hooks/wallet/usePaymentRequestDerived";
import { useEcashSendDerived } from "../hooks/wallet/useEcashSendDerived";
import {
  isSamePaymentRequest,
  type IncomingPaymentRequest,
} from "../wallet/paymentRequestTypes";
import {
  QrCodeCard,
  QrScanner,
  VerifiedBadgeIcon,
  avatarInitials,
} from "../ui/wallet/walletModalUi";
import {
  yieldToBrowser,
  extractMinibitsPaymentSender,
  computeSubsetSelectionInfo,
  totalForSelection,
  decodeLnurlString,
  decodeContactPayload,
  extractDomain,
  fetchWithTimeout,
  buildTokenSpentToastMessage,
  extractWitnesses,
  shouldSuppressProofStateChecks,
  UNPAID_MINT_QUOTE_RETENTION_MS,
  BACKGROUND_REFRESH_INTERVAL_MS,
  NPUB_CASH_REFRESH_STAGGER_MS,
  TOKEN_STATE_BACKGROUND_STAGGER_MS,
  SUBSCRIPTION_RETRY_DELAY_MS,
  type NostrEvent,
} from "../wallet/walletModalHelpers";
import type { CashuWalletModalProps } from "./cashuWalletModalTypes";
import { MoveFundsOutSheet } from "../ui/wallet/MoveFundsOutSheet";
import { WALLET_NO_INCOMING_MESSAGE, walletRemovalDateLabel } from "../wallet/walletPhaseOut";
import { amountToNumber, loadStore as loadProofStore } from "../wallet/storage";
import { getWalletSeedMnemonic } from "../wallet/seed";
import { WalletContactsPickerSheet } from "../ui/wallet/WalletContactsPickerSheet";
import {
  EcashSendSheet,
  LightningSendSheet,
  PaymentRequestFulfillSheet,
  WalletHistorySheet,
  WalletNwcManagerSheet,
  WalletSettingsSheet,
  WalletSwapSheet,
} from "../ui/wallet/walletModalSheets";

export default function CashuWalletModal({
  open,
  onClose,
  onOpenBounties,
  openMoveFundsOut = false,
  onMoveFundsOutClosed,
  showBottomNav = false,
  walletConversionEnabled,
  walletSettings,
  setWalletSettings,
  defaultRelays,
  onResetWalletTokenTracking,
  walletPrimaryCurrency,
  walletDenominationDisplay,
  setWalletPrimaryCurrency,
  lightningAddressProvider = "solife.me",
  solifeLightningAddress = "",
  npubCashAutoClaim,
  sentTokenStateChecksEnabled,
  paymentRequestsEnabled,
  paymentRequestsBackgroundChecksEnabled,
  tokenStateResetNonce,
  mintBackupEnabled: mintBackupEnabledProp,
  fileStorageServer,
}: CashuWalletModalProps) {
  const walletDebugEnabled = import.meta.env.DEV && (() => {
    try {
      return kvStorage.getItem("taskify.wallet.debug") === "1";
    } catch {
      return false;
    }
  })();
  const activeLightningAddressProvider =
    lightningAddressProvider === "npub.cash" || lightningAddressProvider === "none"
      ? lightningAddressProvider
      : "solife.me";
  const lightningAddressEnabled = activeLightningAddressProvider !== "none";
  const npubCashClaimEnabled = activeLightningAddressProvider === "npub.cash";
  const solifeLightningAddressEnabled = activeLightningAddressProvider === "solife.me";
  const selectedSolifeLightningAddress =
    typeof solifeLightningAddress === "string" ? solifeLightningAddress.trim().toLowerCase() : "";
  useEffect(() => {
    if (!open) return;
    if (!walletDebugEnabled) return;
    console.debug("[wallet] CashuWalletModal render start");
  }, [open, walletDebugEnabled]);
  const {
    ready: walletReady,
    mintUrl,
    setMintUrl,
    totalBalance,
    pendingBalance,
    info,
    proofs,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    savePendingTokenForRedemption,
    receiveToken,
    createSendToken,
    payInvoice: payMintInvoice,
    checkProofStates,
    subscribeProofStateUpdates,
    subscribeMintQuoteUpdates,
    createTokenFromProofSelection,
    redeemPendingToken,
    getMintConnection,
    refreshTotalBalance: syncCashuWallet,
  } = useCashu();
  const { status: nwcStatus, connection: nwcConnection, info: nwcInfo, lastError: nwcError, connect: connectNwc, disconnect: disconnectNwc, refreshInfo: refreshNwcInfo, getBalanceMsat: getNwcBalanceMsat, payInvoice: payWithNwc, makeInvoice: makeNwcInvoice } = useNwc();
  const { show: showToast } = useToast();
  const {
    keys: p2pkKeys,
    primaryKey: primaryP2pkKey,
    setPrimaryKey: setPrimaryP2pkKey,
    generateKeypair: generateP2pkKeypair,
  } = useP2PK();

  const sortedP2pkKeys = useMemo(() => {
    return [...p2pkKeys].sort((a, b) => {
      const labelA = (a.label || "").toLowerCase();
      const labelB = (b.label || "").toLowerCase();
      if (labelA && labelB && labelA !== labelB) return labelA.localeCompare(labelB);
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return a.publicKey.localeCompare(b.publicKey);
    });
  }, [p2pkKeys]);

  const activeP2pkKey: P2PKKey | null = useMemo(() => {
    return primaryP2pkKey ?? sortedP2pkKeys[0] ?? null;
  }, [primaryP2pkKey, sortedP2pkKeys]);

  const [showSendOptions, setShowSendOptions] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const isCompactLightningSheetLayout = useMediaQuery("(max-height: 820px)");
  const [scannerMessage, setScannerMessage] = useState("");
  type PendingScan =
    | { type: "ecash"; token: string }
    | { type: "bolt11"; invoice: string }
    | { type: "lightningAddress"; address: string }
    | { type: "lnurl"; data: string }
    | { type: "paymentRequest"; request: string };
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const walletEnabled = useWalletEnabled();
  const dmSubscriptionCloseRef = useRef<(() => void) | null>(null);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning" | "lnurlWithdraw">(null);
  const {
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
  } = useEcashReceiveState();
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "paymentRequest">(null);
  const backgroundSuspended = useMemo(() => sendMode !== null || receiveMode !== null, [sendMode, receiveMode]);
  const {
    btcUsdPrice,
    priceStatus,
    priceUpdatedAt,
    captureFiatValueUsd,
  } = useWalletPrice({
    enabled: walletConversionEnabled,
    active: open && !backgroundSuspended,
    refreshIntervalMs: BACKGROUND_REFRESH_INTERVAL_MS,
  });

  const {
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
    setLightningAddressCopied,
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
  } = useLightningFlow();

  const {
    sendAmt,
    setSendAmt,
    sendTokenStr,
    setSendTokenStr,
    nutTokenCopied,
    setNutTokenCopied,
    ecashSendView,
    setEcashSendView,
    ecashSendRecipient,
    setEcashSendRecipient,
    lastSendTokenAmount,
    setLastSendTokenAmount,
    lastSendTokenMint,
    setLastSendTokenMint,
    creatingSendToken,
    setCreatingSendToken,
    lastSendTokenFingerprint,
    setLastSendTokenFingerprint,
    lastSendTokenLockLabel,
    setLastSendTokenLockLabel,
    lockSendToPubkey,
    setLockSendToPubkey,
    sendLockPubkeyInput,
    setSendLockPubkeyInput,
    sendLockError,
    setSendLockError,
  } = useEcashSendState();
  const {
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
  } = usePaymentRequestState({
    paymentRequestsEnabled,
    activeP2pkPublicKey: activeP2pkKey?.publicKey ?? null,
  });
  const {
    claimingEventIds, setClaimingEventIds,
    defaultNostrRelays,
    nostrSubscriptionActiveRef, nostrIdentityRef,
    nostrIdentityInfo, setNostrIdentityInfo,
    peanutSendToken,
    ensureNostrPool, closeNostrPool,
    safePublish,
    resetSendLockSettings,
    readNostrIdentity,
    ensureNostrIdentity,
    fingerprintIncomingToken,
    rebuildSpentFingerprints, addSpentIncomingPayment, isIncomingPaymentSpent,
    decryptNostrPaymentMessage, parseIncomingPaymentMessage,
  } = useNostrPoolState({
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
  });
  const nostrMissingReason = paymentRequestsEnabled ? nostrIdentityInfo.reason : null;
  useEffect(() => {
    if (!paymentRequestLockEnabled) return;
    if (paymentRequestLockPubkey) return;
    if (activeP2pkKey?.publicKey) {
      setPaymentRequestLockPubkey(activeP2pkKey.publicKey);
    }
  }, [paymentRequestLockEnabled, paymentRequestLockPubkey, activeP2pkKey]);

  const PAYMENT_REQUEST_LOOKBACK_SECONDS = 3 * 24 * 60 * 60; // 72 hours
  const PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS = 45;
  const PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS = 14 * 24 * 60 * 60; // 14 days

  const [recvMsg, setRecvMsg] = useState("");

  const {
    contacts,
    contactsOpen, setContactsOpen,
    contactsContext, setContactsContext,
    contactsContextRef,
    compressedToRawHex,
    dmPeerProfilesRef,
    ensurePeerProfile,
    formatNpub,
    handleCopyContactField,
    handleScannedContactPayload,
    isNip05VerifiedFor,
    lightningContactCount,
    nip05Checks,
    normalizeNip05,
    publishNip17Giftwraps,
    resolveNip17Relays,
    scannedContact, setScannedContact,
    scannedContactCanShare,
    scannedContactFields,
    scannedContactHeader,
    scannedContactNip05Verified,
    scannedContactShareValue,
    scannedContactTitle,
    scannedContactUsername,
  } = useWalletContactsRuntime();
  const {
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
  } = useWalletFlowState();

  const {
    formatSatAmount,
    satDisplayUnitLabel,
    satFormatter,
    satInputUnitLabel,
    usdFormatterLarge,
    usdFormatterSmall,
    relativeTimeFormatter,
  } = useWalletFormatters(walletDenominationDisplay);

  const {
    showNwcManager,
    openNwcManager,
    closeNwcManager,
    nwcUrlInput,
    setNwcUrlInput,
    nwcBusy,
    nwcFeedback,
    hasNwcConnection,
    nwcAlias,
    nwcBalanceSats,
    nwcStatusLabel,
    handleNwcConnect,
    handleNwcTest,
    handleNwcDisconnect,
  } = useNwcManager({
    connectNwc,
    disconnectNwc,
    formatSatAmount,
    getNwcBalanceMsat,
    nwcConnection,
    nwcInfo,
    nwcStatus,
    open,
    refreshNwcInfo,
  });

  const {
    history,
    setHistory,
    showHistory,
    setShowHistory,
    historyFilter,
    setHistoryFilter,
    expandedHistoryId,
    setExpandedHistoryId,
    historyRevertState,
    setHistoryRevertState,
    historyCheckStates,
    setHistoryCheckStates,
    historyMintQuoteStates,
    setHistoryMintQuoteStates,
    historyRedeemStates,
    setHistoryRedeemStates,
    buildHistoryEntry,
    removeHistoryEntryStates,
    markHistoryEntryAsSpent,
    markHistoryEntriesOlderThan,
    handleMarkHistoryTokenSpent,
    handleDeleteHistoryEntry,
  } = useWalletHistory({ showToast, captureFiatValueUsd });

  // NWC wallet mode: an external lightning wallet replaces the ecash wallet.
  const walletMode = useWalletMode();
  const nwcMode = useNwcWalletMode({
    open,
    showToast,
    formatSatAmount,
    setHistory,
    buildHistoryEntry,
    payMintInvoice,
  });
  const nwcWalletActive = nwcMode.nwcWalletActive;
  const nwcSweeps = useNwcSweeps({
    getMintConnection,
    refreshTotalBalance: syncCashuWallet,
    showToast,
    formatSatAmount,
    setHistory,
    buildHistoryEntry,
    walletLabel: nwcMode.walletLabel,
    active: open && nwcWalletActive,
  });
  const [showWalletModeSheet, setShowWalletModeSheet] = useState(false);
  const [showWalletSettings, setShowWalletSettings] = useState(false);
  const [showStoredTokens, setShowStoredTokens] = useState(false);
  // An unknown NWC balance is shown blank, never as 0 (see nwcBalanceUnknown).
  const nwcBalanceUnknown = nwcWalletActive && nwcMode.balanceSat == null;
  const displayTotalBalance = nwcWalletActive ? (nwcMode.balanceSat ?? 0) : totalBalance;
  const displayPendingBalance = nwcWalletActive ? 0 : pendingBalance;
  usePendingTokenHistorySync({ open, setHistory });
  const {
    manualSendPlan,
    setManualSendPlan,
    manualSendSelection,
    setManualSendSelection,
    manualSendError,
    setManualSendError,
    manualSendInProgress,
    setManualSendInProgress,
    manualSelectedTotal,
    finalizeManualSelection,
    closeManualSendPlan,
    applyManualSendSelection,
    adjustManualSendGroupSelection,
    manualSelectionMatches,
  } = useManualSendPlan({
    createTokenFromProofSelection,
    setSendTokenStr,
    setLastSendTokenAmount,
    setLastSendTokenMint,
    setLastSendTokenFingerprint,
    setLastSendTokenLockLabel,
    setEcashSendView,
    buildHistoryEntry,
    setHistory,
    showToast,
    mintUrl,
    formatSatAmount,
  });

  const [npubCashIdentity, setNpubCashIdentity] = useState<{ npub: string; address: string } | null>(null);
  const [npubCashIdentityError, setNpubCashIdentityError] = useState<string | null>(null);
  const [npubCashClaimStatus, setNpubCashClaimStatus] = useState<"idle" | "checking" | "success" | "error">("idle");
  const [npubCashClaimMessage, setNpubCashClaimMessage] = useState("");
  const deriveDefaultLightningAddress = useCallback(() => {
    if (!lightningAddressEnabled) return "";
    if (solifeLightningAddressEnabled && selectedSolifeLightningAddress) {
      return selectedSolifeLightningAddress;
    }
    if (npubCashIdentity?.address) return npubCashIdentity.address;
    const storedSk = (revealLocalSecretKey() ?? "");
    if (!storedSk) return "";
    try {
      const domain = solifeLightningAddressEnabled ? SOLIFE_LIGHTNING_ADDRESS_DOMAIN : "npub.cash";
      const identity = deriveNpubCashIdentity(storedSk, { domain });
      return identity.address;
    } catch {
      return "";
    }
  }, [
    lightningAddressEnabled,
    npubCashIdentity?.address,
    selectedSolifeLightningAddress,
    solifeLightningAddressEnabled,
  ]);
  const lightningAddressDisplay = useMemo(() => {
    const address = npubCashIdentity?.address?.trim();
    if (!address) return "";
    const [localPart, domain] = address.split("@");
    if (!localPart || !domain) return address;
    const normalizedLocalPart = localPart.trim();
    if (normalizedLocalPart.length <= 11) {
      return `${normalizedLocalPart}@${domain}`;
    }
    const prefix = normalizedLocalPart.slice(0, 7);
    const suffix = normalizedLocalPart.slice(-4);
    return `${prefix}…${suffix}@${domain}`;
  }, [npubCashIdentity?.address]);
  const nut16CollectorRef = useRef<Nut16Collector | null>(null);
  const lnRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const input = lnRef.current;
    if (!input) return;
    if (typeof document !== "undefined" && document.activeElement === input) return;
    if (input.value !== lnInput) {
      input.value = lnInput;
    }
  }, [lnInput, lightningSendView, sendMode]);
  const npubCashClaimAbortRef = useRef<AbortController | null>(null);
  const npubCashClaimingRef = useRef(false);
  const backgroundNpubCashClaimRef = useRef(false);
  const tokenStateCheckRunningRef = useRef(false);
  const nostrProcessedEventsRef = useRef<Set<string>>(new Set());
  const nostrLastCheckRef = useRef<number>(0);
  const autoClaimQueueRef = useRef<IncomingPaymentRequest[]>([]);
  const autoClaimRunningRef = useRef(false);
  const nostrSubscriptionCloserRef = useRef<null | (() => void)>(null);
  const handlePaymentRequestEventRef = useRef<
    ((event: NostrEvent, options?: { updateClock?: boolean }) => Promise<void>) | null
  >(null);
  const deepSyncDMsRef = useRef<(() => Promise<void>) | null>(null);
  const initialTokenCheckIdsRef = useRef<Set<string>>(new Set());
  const proofStateSubscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const proofStateSubscriptionMetadataRef = useRef<
    Map<string, { secretToItem: Map<string, { itemId: string; proofIndex: number }> }>
  >(new Map());
  const unsupportedProofSubscriptionMintsRef = useRef<Set<string>>(new Set());
  const proofSubscriptionCooldownRef = useRef<Map<string, number>>(new Map());
  const mintQuoteSubscriptionCooldownRef = useRef<Map<string, number>>(new Map());
  const unsupportedMintQuoteSubscriptionMintsRef = useRef<Set<string>>(new Set());
  const previousReceiveModeRef = useRef<typeof receiveMode>(receiveMode);

  useEffect(() => {
    if (!paymentRequestsEnabled) {
      setCurrentPaymentRequest(null);
      incomingPaymentRequestsRef.current = [];
      setPaymentRequestStatusMessage("");
      setPaymentRequestError("");
      setClaimingEventIds([]);
      autoClaimQueueRef.current.length = 0;
      autoClaimRunningRef.current = false;
    }
  }, [paymentRequestsEnabled]);

  const {
    handleRevertHistoryToken,
    handleMintQuoteClaimSuccess,
    claimMintQuoteById,
    performTokenStateCheck,
    handleCheckHistoryMintQuote,
    clearProofStateSubscriptions,
    resetTokenTracking,
    isHistoryEntryPending,
    expireStaleMintQuotes,
    pruneStaleUnpaidMintQuotes,
  } = useTokenHistoryActions({
    mintUrl,
    setHistory,
    setHistoryCheckStates,
    setHistoryMintQuoteStates,
    setHistoryRevertState,
    proofStateSubscriptionsRef,
    proofStateSubscriptionMetadataRef,
    proofSubscriptionCooldownRef,
    unsupportedProofSubscriptionMintsRef,
    mintQuoteSubscriptionCooldownRef,
    unsupportedMintQuoteSubscriptionMintsRef,
    initialTokenCheckIdsRef,
    tokenStateCheckRunningRef,
    buildHistoryEntry,
    receiveToken,
    showToast,
    formatSatAmount,
    checkProofStates,
    checkMintQuote,
    claimMint,
    normalizeMintUrl,
    sumProofAmounts,
    deriveSpentHistoryTokenStateFromToken,
    sanitizeProofStateValue,
    aggregateStoredProofStates,
    summarizeStoredProofStates,
    extractWitnesses,
    computeProofY,
    buildTokenSpentToastMessage,
    shouldSuppressProofStateChecks,
    deriveTimestampFromId,
    UNPAID_MINT_QUOTE_RETENTION_MS,
  });
  const {
    normalizedLnInput,
    isLnAddress,
    isLnurlInput,
    isBolt11Input,
    lightningSendAddressDisplay,
    lightningDestinationDisplay,
    lightningInvoiceAmountSat,
    bolt11Details,
    lnurlRequiresAmount,
  } = useLightningInputDerived({ formatSatAmount, lnInput, lnurlPayData });
  const {
    tokenizedHistoryItems,
    pendingTokenStateItems,
    pendingMintQuoteHistoryItems,
    pendingHistoryItems,
    bountyHistoryItems,
    filteredHistory,
    hasExpiringMintQuotes,
    historyFilterControls,
  } = useHistoryFilter({
    history,
    mintUrl,
    isHistoryEntryPending,
    historyFilter,
    setHistoryFilter,
    setExpandedHistoryId,
  });
  useEffect(() => {
    if (!hasExpiringMintQuotes) return;
    expireStaleMintQuotes();
    const timer = window.setInterval(expireStaleMintQuotes, 30000);
    return () => window.clearInterval(timer);
  }, [expireStaleMintQuotes, hasExpiringMintQuotes]);
  useEffect(() => {
    pruneStaleUnpaidMintQuotes();
    const timer = window.setInterval(pruneStaleUnpaidMintQuotes, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [pruneStaleUnpaidMintQuotes]);
  useEffect(() => {
    if (historyFilter === "pending" && pendingHistoryItems.length === 0) {
      setHistoryFilter("all");
      return;
    }
    if (historyFilter === "bounty" && bountyHistoryItems.length === 0) {
      setHistoryFilter("all");
    }
  }, [historyFilter, pendingHistoryItems.length, bountyHistoryItems.length]);
  useEffect(() => {
    if (!expandedHistoryId) return;
    const matchesFilter = filteredHistory.some((entry) => entry.id === expandedHistoryId);
    if (!matchesFilter) {
      setExpandedHistoryId(null);
    }
  }, [expandedHistoryId, filteredHistory]);
  const {
    resetContactForm,
    handleGenerateP2pkKey,
    handleOpenReceiveLock,
    readLightningInput,
    commitLightningInputFromDom,
    handlePaymentRequestScan,
    openContactsFor,
    closeContactsSheet,
    applyLightningContact,
    applyEcashContact,
    handleSelectContact,
    handleProofStateNotification,
  } = useContactPaymentActions({
    mintUrl,
    info,
    activeP2pkKey,
    lnInput,
    walletConversionEnabled,
    walletPrimaryCurrency,
    satInputUnitLabel,
    formatSatAmount,
    sendAmt,
    btcUsdPrice,
    lockSendToPubkey,
    sendLockPubkeyInput,
    contactsContextRef,
    lnRef,
    lnInputValueRef,
    proofStateSubscriptionMetadataRef,
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
    defaultNostrRelays,
  });
  const truncateContactName = (value: string, maxLength = 32) => {
    const normalized = (value || "").trim();
    if (normalized.length <= maxLength) return normalized || "Contact";
    const ellipsis = "…";
    const lead = Math.max(6, Math.min(18, Math.floor((maxLength - 1) / 2)));
    const tail = Math.max(4, maxLength - lead - 1);
    return `${normalized.slice(0, lead)}${ellipsis}${normalized.slice(-tail)}`;
  };
  const truncateContactValue = (value: string, maxLength = 48) => {
    const normalized = (value || "").trim();
    if (normalized.length <= maxLength) return normalized;
    const ellipsis = "…";
    const lead = Math.max(8, Math.min(18, Math.floor((maxLength - 1) / 2)));
    const tail = Math.max(6, maxLength - lead - 1);
    return `${normalized.slice(0, lead)}${ellipsis}${normalized.slice(-tail)}`;
  };
  const lnurlWithdrawStatusText = useMemo(() => {
    switch (lnurlWithdrawState) {
      case "creating":
        return "Creating invoice…";
      case "waiting":
        return "Waiting for payment…";
      case "done":
        return "Completed";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [lnurlWithdrawState]);

  useEffect(() => {
    if (!contactsOpen) {
      resetContactForm();
      setContactsContext(null);
      contactsContextRef.current = null;
    }
  }, [contactsOpen, resetContactForm]);

  const {
    showMintBalances,
    setShowMintBalances,
    showNwcSheet,
    setShowNwcSheet,
    mintInputSheet,
    setMintInputSheet,
    mintEntries,
    refreshMintEntries,
  } = useMintBackup({
    defaultNostrRelays,
    enabledFromSettings: mintBackupEnabledProp,
    ensureNostrPool,
    mintUrl,
    safePublish,
  });

  const {
    resetNwcFundState,
    resetNwcWithdrawState,
    closeNwcSheets,
    resetLnurlWithdrawView,
    openReceiveEcashSheet,
    closeReceiveEcashSheet,
    openReceiveLightningSheet,
    resetLightningInvoiceState,
    closeReceiveLightningSheet,
    closeReceiveLnurlWithdrawSheet,
    resetLightningSendForm,
    handleRemoveMintEntry,
    resetEcashSendForm,
    openLightningSendSheet,
    closeLightningSendSheet,
    openEcashSendSheet,
    openEcashSendToContact,
    closeEcashSendSheet,
    closePaymentRequestSheet,
  } = useSheetManagement({
    setNwcFundState,
    setNwcFundMessage,
    setNwcFundInvoice,
    setNwcWithdrawState,
    setNwcWithdrawMessage,
    setNwcWithdrawInvoice,
    setShowNwcSheet,
    refreshMintEntries,
    closeNwcManager,
    setMintSwapState,
    setMintSwapMessage,
    setSwapAmount,
    setSwapFromValue,
    setSwapToValue,
    setLnurlWithdrawState,
    setLnurlWithdrawMessage,
    setLnurlWithdrawInvoice,
    setLnurlWithdrawAmt,
    setLnurlWithdrawInfo,
    setLnInput,
    setLnAddrAmt,
    setLnState,
    setLnError,
    setLnurlPayData,
    setLightningSendView,
    setReceiveLockVisible,
    setEcashReceiveView,
    setEcashRequestAmt,
    setEcashRequestMode,
    setLastCreatedEcashRequest,
    setSendAmt,
    setSendTokenStr,
    setEcashSendRecipient,
    setEcashSendView,
    setLastSendTokenAmount,
    setLastSendTokenMint,
    setLastSendTokenFingerprint,
    setLastSendTokenLockLabel,
    setCreatingSendToken,
    setSendLockPubkeyInput,
    setSendLockError,
    setLockSendToPubkey,
    setReceiveMode,
    setSendMode,
    setShowSendOptions,
    setRecvMsg,
    setContactsOpen,
    setMintAmt,
    setMintQuote,
    setMintStatus,
    setMintError,
    setLightningReceiveView,
    setActiveMintInvoice,
    activeMintInvoice,
    npubCashLightningAddressEnabled: lightningAddressEnabled,
    setNpubCashClaimStatus,
    setNpubCashClaimMessage,
    npubCashClaimingRef,
    setPaymentRequestState,
    setPaymentRequestStatus,
    setPaymentRequestMessage,
    setPaymentRequestManualAmount,
    resetSendLockSettings,
    resetContactForm,
  });

  useEffect(() => {
    const previous = previousReceiveModeRef.current;
    if (receiveMode === "lightning" && previous !== "lightning") {
      if (!activeMintInvoice) {
        setLightningReceiveView(lightningAddressEnabled ? "address" : "amount");
      }
      refreshMintEntries();
    }
    if (receiveMode !== "lightning" && previous === "lightning") {
      setLightningReceiveView("address");
    }
    previousReceiveModeRef.current = receiveMode;
  }, [
    receiveMode,
    lightningAddressEnabled,
    activeMintInvoice,
    refreshMintEntries,
  ]);

  useEffect(() => {
    if (!open) return;
    if (
      sendMode === "ecash" ||
      sendMode === "lightning" ||
      sendMode === "paymentRequest" ||
      receiveMode === "ecash" ||
      receiveMode === "lightning"
    ) {
      refreshMintEntries();
    }
  }, [open, receiveMode, refreshMintEntries, sendMode]);

  useEffect(() => {
    if (!open) return;
    if (sendMode === "paymentRequest") {
      refreshMintEntries();
    }
  }, [open, refreshMintEntries, sendMode]);

  useEffect(() => {
    if (receiveMode !== "lightning") return;
    if (lightningReceiveView === "invoice" && !activeMintInvoice) {
      setLightningReceiveView(lightningAddressEnabled ? "address" : "amount");
    }
  }, [
    receiveMode,
    lightningReceiveView,
    activeMintInvoice,
    lightningAddressEnabled,
  ]);

  const {
    mintInfoByUrl,
    mintEntriesByNormalized,
    mintSelectionOptions,
    swapOptionList,
    getSwapOptionMeta,
    selectedMintValue,
    selectedMintLabel,
    selectedMintBalanceLabel,
  } = useMintSelection({
    activeMintInfo: info,
    formatSatAmount,
    hasNwcConnection,
    mintEntries,
    mintUrl,
    nwcAlias,
    nwcBalanceSats,
    preloadMintInfo: lightningReceiveView === "amount",
    refreshMintEntries,
    setSwapFromValue,
    setSwapToValue,
    showNwcSheet,
    swapFromValue,
    swapToValue,
  });

  const { handleClaimNpubCash } = useNpubCashClaim({
    buildHistoryEntry,
    formatSatAmount,
    mintUrl,
    npubCashLightningAddressEnabled: npubCashClaimEnabled,
    receiveToken,
    setHistory,
    showToast,
    setNpubCashIdentity,
    setNpubCashIdentityError,
    setNpubCashClaimStatus,
    setNpubCashClaimMessage,
    npubCashClaimingRef,
    backgroundNpubCashClaimRef,
    npubCashClaimAbortRef,
  });

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled) {
      initialTokenCheckIdsRef.current.clear();
      return;
    }
    if (typeof window === "undefined") return;
    if (!pendingTokenStateItems.length) {
      initialTokenCheckIdsRef.current.clear();
      return;
    }
    const pendingIds = new Set(pendingTokenStateItems.map((item) => item.id));
    for (const checkedId of Array.from(initialTokenCheckIdsRef.current)) {
      if (!pendingIds.has(checkedId)) {
        initialTokenCheckIdsRef.current.delete(checkedId);
      }
    }
    const dueItems = pendingTokenStateItems.filter(
      (entry) => !initialTokenCheckIdsRef.current.has(entry.id),
    );
    if (!dueItems.length) return;
    let cancelled = false;
    const runChecks = async () => {
      if (cancelled || tokenStateCheckRunningRef.current) return;
      tokenStateCheckRunningRef.current = true;
      try {
        for (const entry of dueItems) {
          if (cancelled) break;
          await performTokenStateCheck(entry, { silent: true });
          initialTokenCheckIdsRef.current.add(entry.id);
        }
      } finally {
        tokenStateCheckRunningRef.current = false;
      }
    };
    void runChecks();
    return () => {
      cancelled = true;
    };
  }, [open, sentTokenStateChecksEnabled, pendingTokenStateItems, performTokenStateCheck]);

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled || backgroundSuspended) return;
    if (!pendingTokenStateItems.length) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const runChecks = async () => {
      if (cancelled) return;
      if (!pendingTokenStateItems.length) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
        return;
      }
      if (tokenStateCheckRunningRef.current) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
        return;
      }
      tokenStateCheckRunningRef.current = true;
      try {
        for (const entry of pendingTokenStateItems) {
          if (cancelled) break;
          await performTokenStateCheck(entry, { silent: true });
        }
      } finally {
        tokenStateCheckRunningRef.current = false;
      }
      if (!cancelled) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
      }
    };

    initialTimer = setTimeout(() => {
      if (!cancelled) {
        void runChecks();
      }
    }, TOKEN_STATE_BACKGROUND_STAGGER_MS);

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [
    open,
    sentTokenStateChecksEnabled,
    pendingTokenStateItems,
    backgroundSuspended,
    performTokenStateCheck,
  ]);

  useEffect(() => {
    return () => {
      clearProofStateSubscriptions();
    };
  }, [clearProofStateSubscriptions]);
  const lastTokenStateResetNonceRef = useRef<number>(0);
  useEffect(() => {
    if (!tokenStateResetNonce) return;
    if (lastTokenStateResetNonceRef.current === tokenStateResetNonce) return;
    lastTokenStateResetNonceRef.current = tokenStateResetNonce;
    resetTokenTracking();
  }, [tokenStateResetNonce, resetTokenTracking]);

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled) {
      clearProofStateSubscriptions();
      return;
    }
    if (!pendingTokenStateItems.length) {
      clearProofStateSubscriptions();
      return;
    }
    const subscriptionPlans = new Map<
      string,
      { proofs: Proof[]; secretToItem: Map<string, { itemId: string; proofIndex: number }> }
    >();
    for (const item of pendingTokenStateItems) {
      const tokenState = item.tokenState;
      if (!tokenState || !tokenState.proofs.length) continue;
      const normalizedMint = normalizeMintUrl(tokenState.mintUrl);
      if (!normalizedMint || unsupportedProofSubscriptionMintsRef.current.has(normalizedMint)) continue;
      const existing = subscriptionPlans.get(normalizedMint);
      const plan = existing ?? { proofs: [], secretToItem: new Map() };
      tokenState.proofs.forEach((proof, index) => {
        if (!proof.secret || !proof.id || !proof.C) return;
        if (!plan.secretToItem.has(proof.secret)) {
          plan.proofs.push({
            amount: proof.amount,
            secret: proof.secret,
            id: proof.id,
            C: proof.C,
            witness: proof.witness,
          });
        }
        plan.secretToItem.set(proof.secret, { itemId: item.id, proofIndex: index });
      });
      if (plan.proofs.length) {
        subscriptionPlans.set(normalizedMint, plan);
      }
    }
    if (!subscriptionPlans.size) {
      clearProofStateSubscriptions();
      return;
    }
    let cancelled = false;
    const setup = async () => {
      const now = Date.now();
      for (const [mint, plan] of subscriptionPlans.entries()) {
        const cooldownUntil = proofSubscriptionCooldownRef.current.get(mint);
        if (typeof cooldownUntil === "number" && cooldownUntil > now) {
          continue;
        }
        if (typeof cooldownUntil === "number" && cooldownUntil <= now) {
          proofSubscriptionCooldownRef.current.delete(mint);
        }
        proofStateSubscriptionMetadataRef.current.set(mint, {
          secretToItem: plan.secretToItem,
        });
        try {
          const cancel = await subscribeProofStateUpdates(
            mint,
            plan.proofs,
            (payload) => handleProofStateNotification(mint, payload),
            (error) => {
              console.warn(`Proof state subscription error for ${mint}`, error);
              proofSubscriptionCooldownRef.current.set(
                mint,
                Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
              );
            },
          );
          if (cancelled) {
            cancel();
            continue;
          }
          proofStateSubscriptionsRef.current.set(mint, cancel);
          proofSubscriptionCooldownRef.current.delete(mint);
        } catch (err: any) {
          proofStateSubscriptionMetadataRef.current.delete(mint);
          if (err?.message?.includes("does not support proof_state")) {
            unsupportedProofSubscriptionMintsRef.current.add(mint);
          } else {
            console.warn(`Failed to subscribe to proof states for ${mint}`, err);
            proofSubscriptionCooldownRef.current.set(
              mint,
              Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
            );
          }
        }
      }
    };
    void setup();
    return () => {
      cancelled = true;
      clearProofStateSubscriptions();
    };
  }, [
    open,
    sentTokenStateChecksEnabled,
    pendingTokenStateItems,
    subscribeProofStateUpdates,
    handleProofStateNotification,
    clearProofStateSubscriptions,
  ]);

  useEffect(() => {
    if (!lightningAddressEnabled) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(null);
      return;
    }
    const storedSk = (revealLocalSecretKey() ?? "");
    const providerDomain = solifeLightningAddressEnabled ? SOLIFE_LIGHTNING_ADDRESS_DOMAIN : "npub.cash";
    if (!storedSk) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(`Add your Taskify Nostr key in Settings → Nostr to use ${providerDomain}.`);
      return;
    }
    try {
      const identity = deriveNpubCashIdentity(storedSk, { domain: providerDomain });
      setNpubCashIdentity({
        npub: identity.npub,
        address: solifeLightningAddressEnabled && selectedSolifeLightningAddress
          ? selectedSolifeLightningAddress
          : identity.address,
      });
      setNpubCashIdentityError(null);
    } catch (err: any) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(err?.message || `Unable to derive ${providerDomain} address.`);
    }
  }, [
    lightningAddressEnabled,
    open,
    selectedSolifeLightningAddress,
    solifeLightningAddressEnabled,
  ]);

  useEffect(() => {
    if (
      !open ||
      !npubCashClaimEnabled ||
      !npubCashAutoClaim ||
      backgroundSuspended
    ) {
      return;
    }
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const runClaim = async () => {
      if (cancelled) return;
      await handleClaimNpubCash({ auto: true });
      if (!cancelled) {
        refreshTimer = setTimeout(runClaim, BACKGROUND_REFRESH_INTERVAL_MS);
      }
    };

    initialTimer = setTimeout(() => {
      if (!cancelled) {
        void runClaim();
      }
    }, NPUB_CASH_REFRESH_STAGGER_MS);

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (backgroundNpubCashClaimRef.current && npubCashClaimAbortRef.current) {
        try {
          npubCashClaimAbortRef.current.abort();
        } catch {}
      }
    };
  }, [
    open,
    npubCashClaimEnabled,
    npubCashAutoClaim,
    backgroundSuspended,
    handleClaimNpubCash,
  ]);

  useEffect(() => {
    return () => {
      if (npubCashClaimAbortRef.current) {
        npubCashClaimAbortRef.current.abort();
        npubCashClaimAbortRef.current = null;
      }
      npubCashClaimingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setSendTokenStr("");
      setLastSendTokenFingerprint(null);
      setLastSendTokenLockLabel(null);
      resetSendLockSettings();
      setRecvMsg("");
      setLnInput("");
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
      setShowSendOptions(false);
      setReceiveMode(null);
      setSendMode(null);

      setNwcFundState("idle");
      setNwcFundMessage("");
      setNwcFundInvoice("");
      setNwcWithdrawState("idle");
      setNwcWithdrawMessage("");
      setNwcWithdrawInvoice("");
      setLnurlPayData(null);
      setLnurlWithdrawInfo(null);
      setLnurlWithdrawAmt("");
      setLnurlWithdrawState("idle");
      setLnurlWithdrawMessage("");
      setLnurlWithdrawInvoice("");
      setPaymentRequestState(null);
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setPendingScan(null);
      setShowScanner(false);
      setScannerMessage("");
      setShowMintBalances(false);
      setShowNwcSheet(false);
      setLightningSendView("input");
    }
  }, [open, resetSendLockSettings, setLnInput]);

  useEffect(() => {
    if (!pendingPrimaryP2pkKeyId) return;
    if (!p2pkKeys.some((key) => key.id === pendingPrimaryP2pkKeyId)) return;
    setPrimaryP2pkKey(pendingPrimaryP2pkKeyId);
    setPendingPrimaryP2pkKeyId(null);
  }, [pendingPrimaryP2pkKeyId, p2pkKeys, setPrimaryP2pkKey]);

  // Removed auto clipboard detection to avoid unwanted paste popup.
  // Users can explicitly paste via dedicated buttons in each view.

  useEffect(() => {
    if (!open || sendMode !== "lightning") return;
    const timer = setTimeout(() => {
      lnRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [open, sendMode]);

  useEffect(() => {
    if (!lnurlPayData) return;
    if (normalizedLnInput.toLowerCase() !== lnurlPayData.lnurl.trim().toLowerCase()) {
      setLnurlPayData(null);
    }
  }, [lnurlPayData, normalizedLnInput]);

  useEffect(() => {
    if (!showMintBalances) return;
    setMintInputSheet(mintUrl || "");
    refreshMintEntries();
  }, [showMintBalances, mintUrl, refreshMintEntries]);

  const { formatRelativeTime, formatHistoryAmount, resolveMintDisplay, deriveHistoryStatus } = useHistoryFormatters({
    formatSatAmount,
    mintInfoByUrl,
    relativeTimeFormatter,
    satFormatter,
  });

  const {
    paymentRequestUnitLabel,
    paymentRequestFixedAmount,
    paymentRequestHasFixedAmount,
    canToggleCurrency,
    paymentRequestInputCurrency,
    paymentRequestInputUnitLabel,
    canTogglePaymentRequestCurrency,
    paymentRequestAmountTextValue,
    paymentRequestPrimaryAmountText,
    paymentRequestSecondaryAmountText,
    paymentRequestPrimaryTransportType,
    paymentRequestActionLabel,
    canEditPaymentRequestAmount,
    paymentRequestAmountButtonEnabled,
  } = usePaymentRequestDerived({
    paymentRequestState,
    info,
    paymentRequestManualAmount,
    walletConversionEnabled,
    walletPrimaryCurrency,
    btcUsdPrice,
    formatSatAmount,
    satFormatter,
    satInputUnitLabel,
  });

  const overviewPaymentRequest = useMemo(() => {
    if (openPaymentRequest && !openPaymentRequest.request.singleUse) {
      return openPaymentRequest;
    }
    if (currentPaymentRequest && !currentPaymentRequest.request.singleUse) {
      return currentPaymentRequest;
    }
    return null;
  }, [openPaymentRequest, currentPaymentRequest]);

  const {
    primaryCurrency,
    unitLabel,
    amountInputUnitLabel,
    amountInputPlaceholder,
    usdBalance,
    formatUsdAmount,
    handleTogglePrimary,
    parseAmountInput,
    parsedMintAmount,
    mintAmountSecondaryDisplay,
    canCreateMintInvoice,
    parsedLightningSendAmount,
    lightningSendAmountSecondaryDisplay,
    lightningSendPrimaryAmountText,
    lightningSendSecondaryAmountText,
    lightningInvoiceAmountSecondaryDisplay,
    lightningPrimaryAmountText,
    lightningSecondaryAmountText,
    invoiceAmountSecondary,
    lightningInvoiceStatusLabel,
  } = useAmountFormatters({
    walletConversionEnabled,
    walletPrimaryCurrency,
    setWalletPrimaryCurrency,
    btcUsdPrice,
    totalBalance: displayTotalBalance,
    usdFormatterLarge,
    usdFormatterSmall,
    formatSatAmount,
    satDisplayUnitLabel,
    satInputUnitLabel,
    mintAmt,
    lnAddrAmt,
    mintUrl,
    activeMintInvoice,
    lightningInvoiceAmountSat,
    mintStatus,
    canToggleCurrency,
  });


  const unitButtonClass = useMemo(
    () => `wallet-modal__unit chip chip-accent${canToggleCurrency ? " pressable" : ""}`,
    [canToggleCurrency]
  );

  const balanceCardClass = useMemo(
    () =>
      `wallet-balance-card${canToggleCurrency ? " wallet-balance-card--toggleable pressable" : ""}`,
    [canToggleCurrency],
  );

  const contentClass = "wallet-modal__content wallet-modal__content--home";




  const {
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
  } = useAmountKeypadHandlers({
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
  });

  const {
    canSubmitSwap,
    handleSwapAmountKeypadInput,
    handleSwapSubmit,
    mintSwapStatusText,
    nwcFundInProgress,
    nwcFundStatusText,
    nwcWithdrawInProgress,
    nwcWithdrawStatusText,
    swapInProgress,
    swapPrimaryAmountText,
    swapScenario,
    swapSecondaryAmountText,
  } = useWalletSwapFlow({
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
  });

  const claimingEventSet = useMemo(() => new Set(claimingEventIds), [claimingEventIds]);

  const parsedEcashRequestAmount = useMemo(
    () => parseAmountInput(ecashRequestAmt),
    [parseAmountInput, ecashRequestAmt],
  );

  const ecashRequestAmountSecondaryDisplay = useMemo(() => {
    if (parsedEcashRequestAmount.error || parsedEcashRequestAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${formatSatAmount(parsedEcashRequestAmount.sats)}`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedEcashRequestAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [parsedEcashRequestAmount, primaryCurrency, walletConversionEnabled, btcUsdPrice, formatSatAmount, formatUsdAmount]);

  const ecashRequestPrimaryAmountText = useMemo(() => {
    const trimmedAmount = ecashRequestAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return formatSatAmount(Number(trimmedAmount || "0"));
  }, [ecashRequestAmt, formatSatAmount, primaryCurrency]);

  const ecashRequestSecondaryAmountText = useMemo(() => {
    if (ecashRequestMode === "multi") {
      return "Reusable request";
    }
    if (ecashRequestAmountSecondaryDisplay) return ecashRequestAmountSecondaryDisplay;
    const trimmedAmount = ecashRequestAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? satDisplayUnitLabel : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [ecashRequestMode, ecashRequestAmountSecondaryDisplay, ecashRequestAmt, amountInputUnitLabel, canToggleCurrency, primaryCurrency, satDisplayUnitLabel]);

  const canCreateEcashRequest = useMemo(() => {
    if (!paymentRequestsEnabled) return false;
    if (!mintUrl) return false;
    if (!info?.unit) return false;
    if (nostrMissingReason) return false;
    if (ecashRequestMode === "single") {
      return parsedEcashRequestAmount.sats > 0 && !parsedEcashRequestAmount.error;
    }
    return true;
  }, [paymentRequestsEnabled, mintUrl, info?.unit, nostrMissingReason, ecashRequestMode, parsedEcashRequestAmount]);

  const {
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
  } = usePaymentRequestFlow({
    info,
    mintUrl,
    receiveToken,
    savePendingTokenForRedemption,
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
  });

  useEffect(() => {
    if (!mintUrl) {
      setOpenPaymentRequest(null);
      if (currentPaymentRequest && !currentPaymentRequest.request.singleUse) {
        setCurrentPaymentRequest(null);
        setPaymentRequestStatusMessage("");
      }
      return;
    }
    const normalizedMint = normalizeMintUrl(mintUrl);
    const restrictsMint =
      !!openPaymentRequest?.request?.mints && openPaymentRequest.request.mints.length > 0;
    const openMatches =
      !!openPaymentRequest &&
      (!restrictsMint ||
        openPaymentRequest.request.mints?.some((m) => normalizeMintUrl(String(m)) === normalizedMint) === true);
    if (!openMatches || restrictsMint) {
      setOpenPaymentRequest(null);
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
    } else if (!openMatches && (!currentPaymentRequest || !currentPaymentRequest.request.singleUse)) {
      if (currentPaymentRequest) {
        setCurrentPaymentRequest(null);
      }
      setPaymentRequestStatusMessage("");
    }
  }, [mintUrl, loadStoredOpenPaymentRequest, currentPaymentRequest, openPaymentRequest]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (receiveMode !== "ecash") return;
    if (nostrMissingReason) return;
    void ensureOpenPaymentRequest();
  }, [paymentRequestsEnabled, receiveMode, nostrMissingReason, ensureOpenPaymentRequest]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (sendMode !== "ecash") return;
    if (nostrMissingReason) return;
    void ensureOpenPaymentRequest();
  }, [paymentRequestsEnabled, sendMode, nostrMissingReason, ensureOpenPaymentRequest]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (!mintUrl) return;
    setPaymentRequestStatusMessage((prev) => {
      if (!info?.unit) {
        return prev || "Loading mint info…";
      }
      return prev === "Loading mint info…" ? "" : prev;
    });
  }, [paymentRequestsEnabled, mintUrl, info?.unit]);

  const PAYMENT_REQUEST_SEND_TIMEOUT_MS = 8000;

  const decryptNostrPaymentMessageRef = useRef(decryptNostrPaymentMessage);
  const parseIncomingPaymentMessageRef = useRef(parseIncomingPaymentMessage);
  const selectIncomingPaymentFromPayloadRef = useRef(selectIncomingPaymentFromPayload);
  const processIncomingPaymentPayloadRef = useRef(processIncomingPaymentPayload);
  useEffect(() => {
    decryptNostrPaymentMessageRef.current = decryptNostrPaymentMessage;
  }, [decryptNostrPaymentMessage]);
  useEffect(() => {
    parseIncomingPaymentMessageRef.current = parseIncomingPaymentMessage;
  }, [parseIncomingPaymentMessage]);
  useEffect(() => {
    selectIncomingPaymentFromPayloadRef.current = selectIncomingPaymentFromPayload;
  }, [selectIncomingPaymentFromPayload]);
  useEffect(() => {
    processIncomingPaymentPayloadRef.current = processIncomingPaymentPayload;
  }, [processIncomingPaymentPayload]);
  const handlePaymentRequestEvent = useCallback(
    async (event: NostrEvent, options?: { updateClock?: boolean }) => {
      if (!event || typeof event.id !== "string") return;
      if (event.kind !== 4 && event.kind !== 1059) return;
      if (nostrProcessedEventsRef.current.has(event.id)) return;
      const decrypt = decryptNostrPaymentMessageRef.current;
      const parseMessage = parseIncomingPaymentMessageRef.current;
      const selectPayload = selectIncomingPaymentFromPayloadRef.current;
      const processPayload = processIncomingPaymentPayloadRef.current;
      if (!decrypt || !parseMessage || !selectPayload || !processPayload) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const decrypted = await decrypt(event, identity.pubkey, identity.secret);
      const plain = decrypted?.content;
      if (!plain) return;
      const identityRaw = compressedToRawHex(identity.pubkey).toLowerCase();
      const normalizeToRawHex = (value: string | null | undefined): string | null => {
        if (!value || typeof value !== "string") return null;
        const normalized = normalizeNostrPubkey(value);
        if (!normalized) {
          const trimmed = value.trim().toLowerCase();
          return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
        }
        const raw = compressedToRawHex(normalized).toLowerCase();
        return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
      };
      const hintedSender = normalizeToRawHex(extractMinibitsPaymentSender(plain));
      const decryptedSender = normalizeToRawHex(decrypted?.senderPubkey);
      const decryptedRecipient = normalizeToRawHex(decrypted?.recipientPubkey);
      const decryptedRecipients = Array.isArray(decrypted?.recipientPubkeys)
        ? decrypted.recipientPubkeys
            .map((value) => normalizeToRawHex(value))
            .filter((value): value is string => !!value)
        : [];
      const recipientCandidates = Array.from(
        new Set<string>([
          ...decryptedRecipients,
          ...(decryptedRecipient ? [decryptedRecipient] : []),
        ]),
      );
      const recipientMatchesIdentity = recipientCandidates.includes(identityRaw);
      if (recipientCandidates.length > 0 && !recipientMatchesIdentity) {
        return;
      }
      if (recipientCandidates.length === 0 && decryptedSender === identityRaw) {
        // If we cannot determine a recipient, ignore self-authored messages
        // to avoid claiming sender mirror wraps unintentionally.
        return;
      }
      const senderOverride =
        hintedSender && hintedSender !== identityRaw
          ? hintedSender
          : decryptedSender && decryptedSender !== identityRaw
            ? decryptedSender
            : null;
      try {
        const message = parseMessage(plain);
        if (!message) return;
        const normalizedPayload = selectPayload(message);
        if (!normalizedPayload) return;
        nostrProcessedEventsRef.current.add(event.id);
        if (nostrProcessedEventsRef.current.size > 512) {
          const iter = nostrProcessedEventsRef.current.values();
          const first = iter.next().value;
          if (first) nostrProcessedEventsRef.current.delete(first);
        }
        if (options?.updateClock !== false) {
          const createdAt = event.created_at || Math.floor(Date.now() / 1000);
          if (createdAt > nostrLastCheckRef.current) {
            nostrLastCheckRef.current = createdAt;
          }
        }
        processPayload(message, event, normalizedPayload, senderOverride);
      } catch (err) {
        console.warn("Failed to parse Nostr payment request message", err);
      }
    },
    [compressedToRawHex, ensureNostrIdentity],
  );

  useEffect(() => {
    handlePaymentRequestEventRef.current = handlePaymentRequestEvent;
  }, [handlePaymentRequestEvent]);


  useEffect(() => {
    deepSyncDMsRef.current = deepSyncDMs;
  }, [deepSyncDMs]);

  useEffect(() => {
    if (!paymentRequestsEnabled) {
      autoClaimQueueRef.current.length = 0;
      return;
    }
    // Sweep any incoming payments that the queue may have already drained
    // without success — most commonly, DMs that arrived during a brief
    // window before `walletReady` flipped true and `receiveToken` threw
    // "Wallet not ready". Re-enqueue every entry that hasn't been marked
    // spent so the manager-now-ready receiveToken can pick them up. This
    // also self-heals after a one-off transient failure on the receive
    // path (e.g. a relay hiccup mid-swap) once any auto-claim dependency
    // changes — `claimingEventSet` plus `isIncomingPaymentSpent` prevent
    // double-claiming, so the worst case is a single redundant attempt.
    const queued = new Set<string>(autoClaimQueueRef.current.map((entry) => entry.eventId));
    for (const entry of incomingPaymentRequestsRef.current) {
      if (queued.has(entry.eventId)) continue;
      if (isIncomingPaymentSpent(entry.eventId, entry.fingerprint ?? null)) continue;
      autoClaimQueueRef.current.push(entry);
      queued.add(entry.eventId);
    }
    if (autoClaimQueueRef.current.length) {
      scheduleAutoClaimRun();
    }
  }, [paymentRequestsEnabled, scheduleAutoClaimRun, isIncomingPaymentSpent, walletReady]);

  useEffect(() => {
    if (!paymentRequestsEnabled || (!open && !paymentRequestsBackgroundChecksEnabled)) {
      stopPaymentRequestSubscription();
      return;
    }
    void startPaymentRequestSubscription();
    return () => {
      stopPaymentRequestSubscription();
    };
  }, [
    defaultNostrRelays,
    open,
    paymentRequestsEnabled,
    paymentRequestsBackgroundChecksEnabled,
    receiveMode,
    sendMode,
    startPaymentRequestSubscription,
    stopPaymentRequestSubscription,
  ]);

  useEffect(() => {
    return () => {
      stopPaymentRequestSubscription();
      void closeNostrPool(true);
    };
  }, [closeNostrPool, stopPaymentRequestSubscription]);

  const {
    normalizedSendLockPubkey,
    parsedSendAmount,
    currentSendTokenFingerprint,
    tokenAlreadyCreatedForAmount,
    ecashPrimaryAmountText,
    ecashSecondaryAmountText,
    canCreateSendTokenAmount,
    primaryAmountDisplay,
    secondaryAmountDisplay,
    priceMeta,
    pendingBalanceDisplay,
    scannerMessageTone,
  } = useEcashSendDerived({
    parseAmountInput,
    formatUsdAmount,
    primaryCurrency,
    amountInputUnitLabel,
    usdBalance,
    sendAmt,
    sendTokenStr,
    lastSendTokenFingerprint,
    lockSendToPubkey,
    sendLockPubkeyInput,
    satFormatter,
    formatSatAmount,
    usdFormatterLarge,
    btcUsdPrice,
    walletConversionEnabled,
    mintUrl,
    priceStatus,
    priceUpdatedAt,
    totalBalance: displayTotalBalance,
    pendingBalance: displayPendingBalance,
    scannerMessage,
    normalizeNostrPubkey,
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const {
    handleScannerError,
    handleScannerDetected,
    handlePasteFromClipboard,
    handleLnurlScan,
    openScanner,
    closeScanner,
  } = useScannerFlow({
    decodeContactPayload,
    formatNpub,
    handleScannedContactPayload,
    nut16CollectorRef,
    resetSendLockSettings,
    setLnAddrAmt,
    setLnError,
    setLnInput,
    setLnState,
    setLightningSendView,
    setLnurlPayData,
    setLnurlWithdrawAmt,
    setLnurlWithdrawInfo,
    setLnurlWithdrawInvoice,
    setLnurlWithdrawMessage,
    setLnurlWithdrawState,
    setLockSendToPubkey,
    setPendingScan,
    setReceiveMode,
    setScannerMessage,
    setSendLockError,
    setSendLockPubkeyInput,
    setSendMode,
    setShowScanner,
    setShowSendOptions,
  });


  async function handleCreateInvoice() {
    if (nwcWalletActive) {
      const { sats, error } = parseAmountInput(mintAmt);
      if (error || !sats) {
        setMintError(error || `Enter amount in ${amountInputUnitLabel}`);
        return;
      }
      setMintError("");
      const created = await nwcMode.createReceiveInvoice(sats);
      if (created) setLightningReceiveView("invoice");
      return;
    }
    if (creatingMintInvoice) return;
    setMintError("");
    setCreatingMintInvoice(true);
    try {
      const { sats, error } = parseAmountInput(mintAmt);
      if (error) throw new Error(error);
      if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const q = await createMintInvoice(sats);
      const expiresAt = q.expiry > 1_000_000_000_000 ? q.expiry : q.expiry * 1000;
      setMintQuote(q);
      setActiveMintInvoice({ ...q, amountSat: sats });
      setMintStatus("waiting");
      setLightningReceiveView("invoice");
      setHistory((h) => [
        buildHistoryEntry({
          id: q.quote,
          summary: `Invoice for ${sats} sats`,
          detail: q.request,
           detailKind: "invoice",
           type: "lightning",
           direction: "in",
           amountSat: sats,
           mintUrl: q.mintUrl,
           stateLabel: "Pending",
          mintQuote: {
            quote: q.quote,
            amount: sats,
            request: q.request,
            mintUrl: q.mintUrl,
            createdAt: Date.now(),
            expiresAt,
            state: "UNPAID",
          },
        }),
        ...h,
      ]);
    } catch (e: any) {
      setMintError(e?.message || String(e));
    } finally {
      setCreatingMintInvoice(false);
    }
  }
  useEffect(() => {
    if (!activeMintInvoice) return;

    const { quote, amountSat, expiry, mintUrl: invoiceMintUrl } = activeMintInvoice;
    const expiryMs = expiry > 1_000_000_000_000 ? expiry : expiry * 1000;
    const targetMintUrl = invoiceMintUrl || mintUrl || "";
    const normalizedMint = targetMintUrl ? normalizeMintUrl(targetMintUrl) : "";

    let cancelled = false;
    let claimed = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let subscriptionCancel: (() => void) | null = null;

    const finalizeClaim = async () => {
      if (claimed) return;
      claimed = true;
      try {
        await claimMintQuoteById(quote, amountSat, { historyItemId: quote, mintUrl: targetMintUrl });
        setMintStatus("minted");
        setMintQuote(null);
        setMintAmt("");
        setMintError("");
        setActiveMintInvoice(null);
        if (receiveMode === "lightning") {
          closeReceiveLightningSheet();
        }
      } catch (err: any) {
        const message = err?.message || String(err ?? "");
        setMintStatus("error");
        setMintError(message);
      }
    };

    const handleState = async (state: string) => {
      if (cancelled || claimed) return;
      const normalized = typeof state === "string" ? state.toUpperCase() : "";
      if (normalized === "PAID") {
        await finalizeClaim();
        return;
      }
      if (normalized === "ISSUED") {
        setMintStatus("error");
        setMintError("Quote already issued. Restore from wallet seed if balance is missing.");
        return;
      }
      if (expiryMs <= Date.now()) {
        setMintStatus("error");
        setMintError("Invoice expired. Create a new one.");
        setActiveMintInvoice(null);
        setMintQuote(null);
        setMintAmt("");
        setHistory((h) => h.filter((i) => i.id !== quote));
        setHistoryMintQuoteStates((prev) => {
          if (!(quote in prev)) return prev;
          const next = { ...prev };
          delete next[quote];
          return next;
        });
      }
    };

    const poll = async () => {
      if (cancelled || claimed || pollInFlight) return;
      pollInFlight = true;
      try {
        const state = await checkMintQuote(quote, { mintUrl: targetMintUrl });
        await handleState(state);
      } catch (err: any) {
        setMintError(err?.message || String(err ?? ""));
        setMintStatus("error");
      } finally {
        pollInFlight = false;
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = window.setInterval(() => {
        void poll();
      }, 4000);
      void poll();
    };

    const setupSubscription = async () => {
      if (!normalizedMint) {
        startPolling();
        return;
      }
      try {
        subscriptionCancel = await subscribeMintQuoteUpdates(
          normalizedMint,
          [quote],
          (payload) => {
            void handleState((payload?.state as string) ?? "");
          },
          (error) => {
            console.warn(`Mint quote subscription error`, error);
            startPolling();
          },
        );
      } catch (error) {
        console.warn(`Mint quote subscription unavailable`, error);
        startPolling();
      }
    };

    void poll();
    void setupSubscription();

    return () => {
      cancelled = true;
      if (subscriptionCancel) {
        try {
          subscriptionCancel();
        } catch {
          // ignore
        }
      }
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
    };
  }, [
    activeMintInvoice,
    mintUrl,
    subscribeMintQuoteUpdates,
    claimMintQuoteById,
    checkMintQuote,
    closeReceiveLightningSheet,
    receiveMode,
    setHistory,
    setHistoryMintQuoteStates,
    setMintQuote,
    setMintStatus,
    setMintAmt,
    setActiveMintInvoice,
  ]);

  useEffect(() => {
    if (sendMode !== "ecash") {
      setSendAmt("");
      setCreatingSendToken(false);
      setLastSendTokenFingerprint(null);
      setLastSendTokenLockLabel(null);
      setSendTokenStr("");
      resetSendLockSettings();
    }
  }, [sendMode, resetSendLockSettings]);

  useEffect(() => {
    if (!open) return;
    if (!pendingMintQuoteHistoryItems.length) return;

    const fallbackMintRaw = mintUrl || "";
    const groups = new Map<
      string,
      Array<{ item: HistoryItem; quoteId: string; amount: number; mintUrlRaw: string }>
    >();

    for (const entry of pendingMintQuoteHistoryItems) {
      const quoteId = entry.mintQuote?.quote?.trim() ?? "";
      if (!quoteId) continue;
      const rawMint = entry.mintQuote?.mintUrl || fallbackMintRaw;
      const normalizedMint = rawMint ? normalizeMintUrl(rawMint) : "";
      if (!normalizedMint) continue;
      const amount = entry.mintQuote?.amount ?? 0;
      const plan = { item: entry, quoteId, amount, mintUrlRaw: rawMint };
      const list = groups.get(normalizedMint);
      if (list) {
        list.push(plan);
      } else {
        groups.set(normalizedMint, [plan]);
      }
    }

    if (!groups.size) return;

    let cancelled = false;
    const cleanupFns: Array<() => void> = [];

    groups.forEach((plans, normalizedMint) => {
      const planMap = new Map(plans.map((plan) => [plan.quoteId, plan]));
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let pollInFlight = false;
      let subscriptionCancel: (() => void) | null = null;

      const handleState = (quoteId: string, state: string, amountFromEvent?: number) => {
        if (cancelled) return;
        const normalizedState = state?.toUpperCase?.() ?? "";
        const plan = planMap.get(quoteId);
        if (!plan) return;
        if (normalizedState === "ISSUED") {
          setHistoryMintQuoteStates((prev) => ({
            ...prev,
            [plan.item.id]: {
              status: "error",
              message: "Quote already issued. Restore from wallet seed if balance is missing.",
            },
          }));
          return;
        }
        if (normalizedState !== "PAID") return;
        const amount = amountFromEvent && amountFromEvent > 0 ? amountFromEvent : plan.amount;
        void claimMintQuoteById(quoteId, amount, {
          historyItemId: plan.item.id,
          mintUrl: plan.mintUrlRaw,
        });
      };

      const poll = async () => {
        if (cancelled || pollInFlight) return;
        pollInFlight = true;
        try {
          for (const plan of plans) {
            if (cancelled) break;
            const state = await checkMintQuote(plan.quoteId, { mintUrl: plan.mintUrlRaw });
            handleState(plan.quoteId, state);
          }
        } catch (error) {
          console.warn("Mint quote polling failed", error);
        } finally {
          pollInFlight = false;
        }
      };

      const startPolling = () => {
        if (pollTimer) return;
        pollTimer = window.setInterval(() => {
          void poll();
        }, 6000);
        void poll();
      };

      const setupSubscription = async () => {
        if (unsupportedMintQuoteSubscriptionMintsRef.current.has(normalizedMint)) {
          startPolling();
          return;
        }
        const cooldownUntil = mintQuoteSubscriptionCooldownRef.current.get(normalizedMint);
        const now = Date.now();
        if (typeof cooldownUntil === "number" && cooldownUntil > now) {
          startPolling();
          return;
        }
        if (typeof cooldownUntil === "number" && cooldownUntil <= now) {
          mintQuoteSubscriptionCooldownRef.current.delete(normalizedMint);
        }
        try {
          subscriptionCancel = await subscribeMintQuoteUpdates(
            normalizedMint,
            plans.map((plan) => plan.quoteId),
            (payload) => {
              if (!payload?.quote) return;
              handleState(
                payload.quote,
                (payload.state as string) ?? "",
                payload.amount ?? undefined,
              );
            },
            (error) => {
              console.warn("Mint quote history subscription error", error);
              mintQuoteSubscriptionCooldownRef.current.set(
                normalizedMint,
                Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
              );
              startPolling();
            },
          );
          mintQuoteSubscriptionCooldownRef.current.delete(normalizedMint);
        } catch (error: any) {
          const message = error?.message ? String(error.message) : "";
          if (message.toLowerCase().includes("does not support")) {
            unsupportedMintQuoteSubscriptionMintsRef.current.add(normalizedMint);
          } else {
            mintQuoteSubscriptionCooldownRef.current.set(
              normalizedMint,
              Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
            );
          }
          console.warn("Mint quote history subscription unavailable", error);
          startPolling();
        }
      };

      void poll();
      void setupSubscription();

      cleanupFns.push(() => {
        if (subscriptionCancel) {
          try {
            subscriptionCancel();
          } catch {}
        }
        if (pollTimer) {
          window.clearInterval(pollTimer);
        }
      });
    });

    return () => {
      cancelled = true;
      cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  }, [
    open,
    pendingMintQuoteHistoryItems,
    mintUrl,
    subscribeMintQuoteUpdates,
    claimMintQuoteById,
    checkMintQuote,
  ]);

  useEffect(() => {
    if (sendMode !== "ecash" || !sendTokenStr) return;
    const spentEntry = history.find(
      (entry) => entry.revertToken === sendTokenStr && entry.tokenState?.lastState === "SPENT",
    );
    if (spentEntry) {
      setSendMode(null);
      setShowSendOptions(false);
      showToast("Token spent by recipient", 3000);
    }
  }, [history, sendMode, sendTokenStr, setSendMode, setShowSendOptions, showToast]);

  async function handleCreateSendToken() {
    const { sats, error } = parseAmountInput(sendAmt);
    if (error) {
      alert(error);
      return;
    }
    if (!sats) {
      alert(`Enter amount in ${amountInputUnitLabel}`);
      return;
    }

    let lockOptions: CreateSendTokenOptions | undefined;
    let fingerprintSuffix = "standard";
    if (lockSendToPubkey) {
      if (!normalizedSendLockPubkey) {
        setSendLockError("Enter a valid npub or 64-character hex key");
        return;
      }
      lockOptions = { p2pk: { pubkey: normalizedSendLockPubkey } };
      fingerprintSuffix = `p2pk:${normalizedSendLockPubkey}`;
      setSendLockError("");
    } else {
      setSendLockError("");
    }

    if (tokenAlreadyCreatedForAmount) {
      alert("Token already created for this amount. Close this sheet or change the amount to create another token.");
      return;
    }

    setCreatingSendToken(true);
    try {
      await yieldToBrowser();
      const {
        token,
        proofs: sentProofs,
        mintUrl: sentMintUrl,
        lockInfo,
      } = await createSendToken(sats, lockOptions);
      setSendTokenStr(token);
      setLastSendTokenAmount(sats);
      setLastSendTokenMint(sentMintUrl);
      setLastSendTokenFingerprint(`${sats}|${fingerprintSuffix}`);
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
          id: `token-${Date.now()}`,
          summary: `${lockInfo?.type === "p2pk" ? "Locked token" : "Token"} for ${sats} sats`,
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
    } catch (e: any) {
      const message = e?.message || String(e);
      const totalProofValue = sumProofAmounts(proofs);
      if (totalProofValue >= sats) {
        const availableNotes = proofs
          .filter((proof) => normalizeProofAmount(proof?.amount) > 0 && typeof proof?.secret === "string" && proof.secret)
          .map((proof) => ({ secret: proof.secret!, amount: normalizeProofAmount(proof.amount) }));
        if (availableNotes.length) {
          const sortedNotes = [...availableNotes].sort((a, b) => b.amount - a.amount);
          const subsetInfo = computeSubsetSelectionInfo(sortedNotes, sats);
          let autoExactError: string | null = null;
          if (subsetInfo.exactMatch?.length) {
            const autoSelectedTotal = totalForSelection(sortedNotes, subsetInfo.exactMatch);
            if (autoSelectedTotal > 0) {
              try {
                await finalizeManualSelection({
                  selection: subsetInfo.exactMatch,
                  selectedTotal: autoSelectedTotal,
                  target: sats,
                });
                return;
              } catch (autoErr: any) {
                autoExactError = autoErr?.message || String(autoErr);
              }
            }
          }
          const groupedNotes = (() => {
            const map = new Map<number, string[]>();
            sortedNotes.forEach((note) => {
              const list = map.get(note.amount);
              if (list) {
                list.push(note.secret);
              } else {
                map.set(note.amount, [note.secret]);
              }
            });
            return Array.from(map.entries())
              .map(([amount, secrets]) => ({ amount, secrets }))
              .sort((a, b) => b.amount - a.amount);
          })();
          setManualSendPlan({
            target: sats,
            notes: sortedNotes,
            groups: groupedNotes,
            closestBelow: subsetInfo.closestBelow,
            closestBelowSelection: subsetInfo.closestBelowSelection,
            closestAbove: subsetInfo.closestAbove,
            closestAboveSelection: subsetInfo.closestAboveSelection,
            exactMatchSelection: subsetInfo.exactMatch,
            lockActive: !!lockOptions,
          });
          setManualSendSelection(() => new Set(subsetInfo.exactMatch ?? []));
          setManualSendError(autoExactError ?? "");
          return;
        }
      }
      alert(message);
    } finally {
      setCreatingSendToken(false);
    }
  }

  const {
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
  } = useEcashRedeem({
    buildHistoryEntry,
    closeManualSendPlan,
    closeReceiveEcashSheet,
    createPaymentRequest,
    formatSatAmount,
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
  });

  useEffect(() => {
    if (!pendingScan) return;
    let cancelled = false;

    async function process() {
      switch (pendingScan.type) {
        case "ecash": {
          setRecvMsg("");
          setReceiveMode(null);
          setSendMode(null);
          setShowSendOptions(false);
          setScannerMessage("");
          // Withdraw-only: a scanned token is not redeemed here; it is copied for another wallet.
          try {
            await navigator.clipboard.writeText(pendingScan.token);
            showToast(`${WALLET_NO_INCOMING_MESSAGE} The token was copied.`, 5000);
          } catch {
            showToast(WALLET_NO_INCOMING_MESSAGE, 5000);
          }
          break;
        }
        case "bolt11": {
          setReceiveMode(null);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.invoice);
          setLightningSendView("invoice");
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          setScannerMessage("");
          break;
        }
        case "lightningAddress": {
          setReceiveMode(null);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.address);
          setLightningSendView("address");
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          setScannerMessage("");
          break;
        }
        case "lnurl": {
          setScannerMessage("Processing LNURL…");
          await handleLnurlScan(pendingScan.data);
          break;
        }
        case "paymentRequest": {
          setScannerMessage("Processing payment request…");
          await handlePaymentRequestScan(pendingScan.request);
          break;
        }
      }
    }

    process().finally(() => {
      if (!cancelled) setPendingScan(null);
    });

    return () => {
      cancelled = true;
    };
  }, [
    pendingScan,
    handleLnurlScan,
    handlePaymentRequestScan,
    interpretEcashInput,
    redeemEcashToken,
    showToast,
    setLnInput,
  ]);


  async function handlePayInvoice() {
    setLnState("sending");
    setLnError("");
    try {
      await yieldToBrowser();
      const raw = commitLightningInputFromDom().trim();
      if (!raw) throw new Error("Paste an invoice or enter lightning address");
      const normalized = raw.replace(/^lightning:/i, "").trim();
      let toastLabel: string | null = null;

      if (isLnAddress) {
        const trimmedAddress = normalized.trim();
        const [rawName, ...domainParts] = trimmedAddress.split("@");
        const domainPart = domainParts.join("@").trim();
        if (!rawName || !domainPart) {
          throw new Error("Invalid lightning address");
        }
        const namePart = rawName.trim();
        const namePartLower = namePart.toLowerCase();
        const domainLower = domainPart.toLowerCase();
        const protocol = domainLower.endsWith(".onion") ? "http" : "https";
        const lnurlInfoUrl = `${protocol}://${domainLower}/.well-known/lnurlp/${encodeURIComponent(namePartLower)}`;
        let infoRes: Response;
        try {
          infoRes = await fetchWithTimeout(
            lnurlInfoUrl,
            { headers: { Accept: "application/json" }, mode: "cors", cache: "no-store" },
            15000,
          );
        } catch (error: any) {
          if (error?.name === "AbortError") {
            throw new Error("Lightning address request timed out");
          }
          throw error;
        }
        if (!infoRes.ok) {
          throw new Error(`Failed to fetch LNURL pay info (${infoRes.status})`);
        }
        let info: any;
        try {
          info = await infoRes.json();
        } catch {
          throw new Error("Invalid LNURL pay response");
        }
        const minSendable = Number(info?.minSendable ?? 0);
        const maxSendable = Number(info?.maxSendable ?? 0);
        const callbackRaw = typeof info?.callback === "string" ? info.callback : "";
        if (!callbackRaw || !minSendable || !maxSendable) {
          throw new Error("LNURL pay metadata incomplete");
        }
        const parsed = parseAmountInput(lnAddrAmt);
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        const requestedMsat = parsed.sats * 1000;
        const amountMsat = minSendable === maxSendable ? minSendable : requestedMsat;
        if (amountMsat < minSendable || amountMsat > maxSendable) {
          const minSat = Math.ceil(minSendable / 1000);
          const maxSat = Math.floor(maxSendable / 1000);
          throw new Error(`Amount must be between ${formatSatAmount(minSat)} and ${formatSatAmount(maxSat)}`);
        }
        const amountParam = String(amountMsat);
        const callbackUrl = (() => {
          try {
            const base = /^https?:/i.test(callbackRaw)
              ? new URL(callbackRaw)
              : new URL(callbackRaw, `${protocol}://${domainLower}`);
            base.searchParams.set("amount", amountParam);
            return base.toString();
          } catch {
            const separator = callbackRaw.includes("?") ? "&" : "?";
            return `${callbackRaw}${separator}amount=${encodeURIComponent(amountParam)}`;
          }
        })();
        let invRes: Response;
        try {
          invRes = await fetchWithTimeout(
            callbackUrl,
            { headers: { Accept: "application/json" }, mode: "cors", cache: "no-store" },
            15000,
          );
        } catch (error: any) {
          if (error?.name === "AbortError") {
            throw new Error("Lightning address invoice request timed out");
          }
          throw error;
        }
        if (!invRes.ok) {
          throw new Error(`Failed to fetch invoice (${invRes.status})`);
        }
        let inv: any;
        try {
          inv = await invRes.json();
        } catch {
          throw new Error("Invoice request returned invalid JSON");
        }
        if (inv?.status === "ERROR") {
          throw new Error(inv?.reason || "Invoice request failed");
        }
        const paymentRequest = typeof inv?.pr === "string" ? inv.pr : inv?.payRequest;
        if (typeof paymentRequest !== "string" || !paymentRequest) {
          throw new Error("LNURL callback did not return an invoice");
        }
        const paymentResult = await nwcMode.payLightningInvoice(paymentRequest);
        const amountSat = Math.floor(amountMsat / 1000);
        toastLabel = formatSatAmount(amountSat);
        const historyAddress = `${namePartLower}@${domainLower}`;
        setHistory((h) => [
          buildHistoryEntry({
            id: `sent-${Date.now()}`,
            summary: `Sent ${amountSat} sats to ${historyAddress}`,
            detail: paymentRequest,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? (nwcWalletActive ? undefined : mintUrl) ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
      } else if (isLnurlInput) {
        const payData = await (async () => {
          if (lnurlPayData && lnurlPayData.lnurl.trim().toLowerCase() === normalized.toLowerCase()) return lnurlPayData;
          const url = decodeLnurlString(normalized);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
          const data = await res.json();
          if (String(data?.tag || "").toLowerCase() !== "payrequest") {
            throw new Error("LNURL is not a pay request");
          }
          const minSendable = Number(data?.minSendable ?? 0);
          const maxSendable = Number(data?.maxSendable ?? 0);
          if (!data?.callback || !minSendable || !maxSendable) {
            throw new Error("LNURL pay metadata incomplete");
          }
          const payload: LnurlPayData = {
            lnurl: normalized,
            callback: data.callback,
            domain: extractDomain(url),
            minSendable,
            maxSendable,
            commentAllowed: Number(data?.commentAllowed ?? 0),
            metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
          };
          setLnurlPayData(payload);
          return payload;
        })();

        const minSat = Math.ceil(payData.minSendable / 1000);
        const maxSat = Math.floor(payData.maxSendable / 1000);
        const amountSat = payData.minSendable === payData.maxSendable
          ? Math.floor(payData.minSendable / 1000)
          : (() => {
              const parsed = parseAmountInput(lnAddrAmt);
              if (parsed.error) throw new Error(parsed.error);
              return parsed.sats;
            })();
        if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        if (amountSat < minSat || amountSat > maxSat) {
          throw new Error(`Amount must be between ${formatSatAmount(minSat)} and ${formatSatAmount(maxSat)}`);
        }
        const params = new URLSearchParams({ amount: String(amountSat * 1000) });
        const invoiceRes = await fetch(`${payData.callback}?${params.toString()}`);
        if (!invoiceRes.ok) throw new Error("Failed to fetch LNURL invoice");
        const invoice = await invoiceRes.json();
        if (invoice?.status === "ERROR") throw new Error(invoice?.reason || "LNURL pay error");
        const paymentResult = await nwcMode.payLightningInvoice(invoice.pr);
        toastLabel = formatSatAmount(amountSat);
        setHistory((h) => [
          buildHistoryEntry({
            id: `paid-lnurl-${Date.now()}`,
            summary: `Paid ${amountSat} sats via LNURL (${payData.domain})`,
            detail: invoice.pr,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? (nwcWalletActive ? undefined : mintUrl) ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
        setLnurlPayData(null);
      } else if (isBolt11Input) {
        const paymentResult = await nwcMode.payLightningInvoice(normalized);
        let boltAmountSat: number | null = null;
        try {
          const { amountMsat } = decodeBolt11Amount(normalized);
          if (amountMsat !== null) {
            boltAmountSat = Number(amountMsat / 1000n);
            toastLabel = formatSatAmount(boltAmountSat);
          }
        } catch {
          // ignore amount parse errors
        }
        setHistory((h) => [
          buildHistoryEntry({
            id: `paid-${Date.now()}`,
            summary: `Paid lightning invoice`,
            detail: normalized,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat: boltAmountSat ?? undefined,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? (nwcWalletActive ? undefined : mintUrl) ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
      } else {
        throw new Error("Unsupported lightning input");
      }
      setLnState("done");
      setLnInput("");
      setLnAddrAmt("");
      if (toastLabel) {
        showToast(`sent ${toastLabel}`, 3500);
      } else {
        showToast("sent payment", 3500);
      }
      if (sendMode === "lightning") {
        closeLightningSendSheet();
      }
    } catch (e: any) {
      setLnState("error");
      setLnError(e?.message || String(e));
    }
  }

  async function handleLnurlWithdrawConfirm() {
    if (!lnurlWithdrawInfo) {
      setLnurlWithdrawMessage("Scan an LNURL withdraw code first");
      return;
    }
    setLnurlWithdrawMessage("");
    try {
      const { sats: amountSat, error } = parseAmountInput(lnurlWithdrawAmt);
      if (error) throw new Error(error);
      if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const minSat = Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000);
      const maxSat = Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000);
      if (amountSat < minSat || amountSat > maxSat) {
        throw new Error(`Amount must be between ${formatSatAmount(minSat)} and ${formatSatAmount(maxSat)}`);
      }
      if (!mintUrl) throw new Error("Set an active mint first");

      setLnurlWithdrawState("creating");
      const description = lnurlWithdrawInfo.defaultDescription || `LNURL withdraw (${lnurlWithdrawInfo.domain})`;
      const quote = await createMintInvoice(amountSat, description);
      setLnurlWithdrawInvoice(quote.request);
      setLnurlWithdrawState("waiting");

      const params = new URLSearchParams({ k1: lnurlWithdrawInfo.k1, pr: quote.request });
      const callbackUrl = lnurlWithdrawInfo.callback.includes("?")
        ? `${lnurlWithdrawInfo.callback}&${params.toString()}`
        : `${lnurlWithdrawInfo.callback}?${params.toString()}`;

      const resp = await fetch(callbackUrl);
      let body: any = null;
      try {
        body = await resp.clone().json();
      } catch {
        // ignore parse issues for non-json responses
      }
      if (!resp.ok || body?.status === "ERROR") {
        throw new Error(body?.reason || "LNURL withdraw callback failed");
      }

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
        if (state === "ISSUED") {
          throw new Error("Mint quote is already issued. Restore from wallet seed if balance is missing.");
        }
        if (state === "PAID") {
          await claimMint(quote.quote, amountSat, { mintUrl: quote.mintUrl });
          setLnurlWithdrawState("done");
          setLnurlWithdrawMessage("");
          setLnurlWithdrawAmt("");
          setHistory((h) => [
            buildHistoryEntry({
              id: `lnurl-withdraw-${Date.now()}`,
              summary: `Received ${amountSat} sats via LNURLw (${lnurlWithdrawInfo.domain})`,
              detail: quote.request,
              detailKind: "invoice",
              type: "lightning",
              direction: "in",
              amountSat,
              mintUrl: quote.mintUrl ?? mintUrl ?? undefined,
              stateLabel: "Paid",
            }),
            ...h,
          ]);
          showToast(`received ${formatSatAmount(amountSat)}`, 3500);
          if (receiveMode === "lnurlWithdraw") {
            closeReceiveLnurlWithdrawSheet();
          }
          return;
        }
        await sleep(2500);
      }

      throw new Error("Withdraw still pending. Try again shortly.");
    } catch (err: any) {
      setLnurlWithdrawState("error");
      setLnurlWithdrawMessage(err?.message || String(err));
    }
  }

  async function handleFulfillPaymentRequest() {
    if (!paymentRequestState) {
      setPaymentRequestMessage("Scan a payment request first");
      return;
    }
    const identityInfo = readNostrIdentity();
    const identity = identityInfo.identity ?? ensureNostrIdentity();
    if (!identity) {
      setPaymentRequestStatus("error");
      setPaymentRequestMessage(identityInfo.reason || "Add your Taskify Nostr key in Settings → Nostr.");
      return;
    }
    setPaymentRequestMessage("");
    setPaymentRequestStatus("sending");
    let paymentRequestToken: string | null = null;
    let createdMintUrl: string | null = null;
    let createdAmount: number | null = null;
    try {
      const request = paymentRequestState.request;
      let amount = Math.max(0, Math.floor(Number(request.amount) || 0));
      if (!amount) {
        const { sats, error } = parseAmountInput(paymentRequestManualAmount);
        if (error) throw new Error(error);
        if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        amount = sats;
      }
      if (!mintUrl) throw new Error("Set an active mint first");

      if (request.mints && request.mints.length) {
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }

      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      let transports = Array.isArray((request as any)?.transport)
        ? ((request as any).transport as PaymentRequestTransport[])
        : [];
      transports = transports.filter(
        (entry): entry is PaymentRequestTransport =>
          !!entry && typeof entry.type === "string" && typeof entry.target === "string",
      );
      if (!transports.length) {
        const fallback = new Map<PaymentRequestTransportType, PaymentRequestTransport>();
        const nostr = request.getTransport(PaymentRequestTransportType.NOSTR) as PaymentRequestTransport | undefined;
        if (nostr) fallback.set(PaymentRequestTransportType.NOSTR, nostr);
        const post = request.getTransport(PaymentRequestTransportType.POST) as PaymentRequestTransport | undefined;
        if (post) fallback.set(PaymentRequestTransportType.POST, post);
        transports = [...fallback.values()];
      }
      if (!transports.length) {
        throw new Error("Unsupported payment request transport");
      }

      let delivered = false;
      let deliveredDetail = "";
      createdAmount = amount;

      const {
        proofs,
        mintUrl: proofMintUrl,
        token: createdToken,
      } = await createSendToken(amount);
      paymentRequestToken = createdToken;
      createdMintUrl = proofMintUrl;
      const payload = {
        id: request.id,
        memo: request.description,
        unit: (request.unit || info?.unit || "sat").toLowerCase(),
        mint: proofMintUrl,
        proofs,
        sender: identity.pubkey,
      };

      for (const transport of transports) {
        try {
          if (transport.type === PaymentRequestTransportType.POST) {
            const resp = await fetch(transport.target, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            let body: any = null;
            try {
              body = await resp.clone().json();
            } catch {
              // ignore non-json responses
            }
            if (!resp.ok || body?.status === "ERROR") {
              throw new Error(body?.reason || "Payment request endpoint failed");
            }
            delivered = true;
            deliveredDetail = transport.target;
            break;
          }

          if (transport.type === PaymentRequestTransportType.NOSTR) {
            const { identity, reason } = readNostrIdentity();
            if (!identity) {
              throw new Error(reason || "Add your Taskify Nostr key in Settings → Nostr.");
            }
            let recipientPubkey: string | null = null;
            let relayHints: string[] | undefined;
            try {
              const decoded = nip19.decode(transport.target);
              if (decoded.type === "nprofile") {
                const data = decoded.data as { pubkey?: string; relays?: string[] };
                if (typeof data.pubkey === "string") recipientPubkey = data.pubkey;
                if (Array.isArray(data.relays)) relayHints = data.relays;
              } else if (decoded.type === "npub") {
                recipientPubkey = typeof decoded.data === "string" ? decoded.data : null;
              }
            } catch {
              recipientPubkey = null;
            }
            if (!recipientPubkey) {
              throw new Error("Invalid Nostr target in payment request");
            }
            const relayList = [
              ...(relayHints || []),
              ...defaultNostrRelays,
            ]
              .filter((url): url is string => typeof url === "string" && !!url.trim())
              .map((url) => url.trim());
            const uniqueRelays = Array.from(new Set(relayList));
            if (!uniqueRelays.length) {
              throw new Error("Payment request transport missing relays");
            }
            const publishWithTimeout = async (
              signedEvent: Record<string, unknown>,
              relayTargets: string[] = uniqueRelays,
            ) => {
              const pool = ensureNostrPool();
              let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
              try {
                const publishPromise = safePublish(pool, relayTargets, signedEvent);
                const timeoutPromise = new Promise<never>((_, reject) => {
                  timeoutHandle = setTimeout(
                    () => reject(new Error("Timed out sending payment via nostr")),
                    PAYMENT_REQUEST_SEND_TIMEOUT_MS,
                  );
                });
                await Promise.race([publishPromise, timeoutPromise]);
              } finally {
                if (timeoutHandle != null) {
                  clearTimeout(timeoutHandle);
                }
              }
            };
            const supportedNips = new Set<string>();
            if (Array.isArray(transport.tags)) {
              for (const tag of transport.tags) {
                if (!Array.isArray(tag) || tag[0] !== "n") continue;
                for (let idx = 1; idx < tag.length; idx++) {
                  const value = tag[idx];
                  if (typeof value === "string" && value.trim()) {
                    supportedNips.add(value.trim());
                  }
                }
              }
            }
            const allowNip17 = supportedNips.size === 0 || supportedNips.has("17");
            if (!allowNip17) {
              throw new Error("Payment request transport does not support NIP-17 giftwrap");
            }
            if (!nip44?.v2) {
              throw new Error("NIP-44 support is required to send this payment");
            }
            const recipientHex = recipientPubkey.toLowerCase();
            const senderHex = identity.pubkey.toLowerCase();
            const publishRelays = await resolveNip17Relays(recipientHex, uniqueRelays);
            if (!publishRelays.length) {
              throw new Error("No relays available for NIP-17 inbox");
            }
            const publish = (event: NostrEvent) => publishWithTimeout(event, publishRelays);
            await publishNip17Giftwraps({
              relays: publishRelays,
              content: JSON.stringify(payload),
              senderHex,
              recipientHex,
              senderSecret: identity.secret,
              publish,
            });
            delivered = true;
            deliveredDetail = paymentRequestToken || transport.target;
            break;
          }
        } catch (err) {
          console.warn("Payment request transport failed", err);
          continue;
        }
      }

      if (!delivered) {
        throw new Error("Unable to send payment via provided transports");
      }

      const deliveredSummary = deliveredDetail && deliveredDetail !== paymentRequestToken
        ? `Sent ${amount} sats via payment request (${deliveredDetail})`
        : `Sent ${amount} sats via payment request`;
      const historyDetail = paymentRequestToken || deliveredDetail || undefined;
      const historyDetailKind: HistoryDetailKind | undefined = paymentRequestToken
        ? "token"
        : deliveredDetail
          ? "note"
          : undefined;

      setPaymentRequestStatus("done");
      setPaymentRequestMessage("");
      setHistory((h) => [
        buildHistoryEntry({
          id: `payment-request-${Date.now()}`,
          summary: deliveredSummary,
          detail: historyDetail,
          detailKind: historyDetailKind,
          type: "ecash",
          direction: "out",
          amountSat: amount,
          mintUrl,
        }),
        ...h,
      ]);
      showToast(`sent ${formatSatAmount(amount)}`, 3500);
      if (sendMode === "paymentRequest") {
        closePaymentRequestSheet();
      }
    } catch (err: any) {
      if (paymentRequestToken && createdMintUrl && createdAmount != null) {
        setHistory((h) => [
          buildHistoryEntry({
            id: `payment-request-failed-${Date.now()}`,
            summary: `Payment request token for ${createdAmount} sats (not sent)`,
            detail: paymentRequestToken,
            detailKind: "token",
            revertToken: paymentRequestToken,
            type: "ecash",
            direction: "out",
            amountSat: createdAmount,
            mintUrl: createdMintUrl,
          }),
          ...h,
        ]);
      }
      setPaymentRequestStatus("error");
      setPaymentRequestMessage(err?.message || String(err));
    }
  }

  const contactInitials = (value: string) => {
    return avatarInitials(value);
  };
  const { setOnReceived: setNwcOnReceived, clearReceiveInvoice: clearNwcReceiveInvoice } = nwcMode;
  useEffect(() => {
    setNwcOnReceived(() => {
      setMintAmt("");
      closeReceiveLightningSheet();
    });
    return () => setNwcOnReceived(null);
  }, [closeReceiveLightningSheet, setMintAmt, setNwcOnReceived]);

  useEffect(() => {
    if (receiveMode !== "lightning") clearNwcReceiveInvoice();
  }, [clearNwcReceiveInvoice, receiveMode]);

  // NWC wallet mode has no ecash to spend: ecash sends become lightning payments to the
  // recipient's lightning address, and ecash payment requests can't be paid.
  useEffect(() => {
    if (!nwcWalletActive) return;
    if (sendMode === "ecash") {
      const address = typeof ecashSendRecipient?.address === "string" ? ecashSendRecipient.address.trim() : "";
      openLightningSendSheet();
      if (address) setLnInput(address);
      else if (ecashSendRecipient) {
        showToast(`${ecashSendRecipient.name || "This contact"} has no lightning address to pay with ${nwcMode.walletLabel}.`, 4000);
      }
    } else if (sendMode === "paymentRequest") {
      setSendMode(null);
      showToast(`Ecash payment requests can't be paid with ${nwcMode.walletLabel}.`, 4000);
    }
  }, [ecashSendRecipient, nwcMode.walletLabel, nwcWalletActive, openLightningSendSheet, sendMode, setLnInput, showToast]);

  const handleCopyNwcReceiveAddress = async () => {
    const address = nwcMode.receiveAddress;
    if (!address) return;
    try {
      await navigator.clipboard?.writeText(address);
      showToast("Lightning address copied", 2000);
    } catch (error) {
      console.warn("Failed to copy lightning address", error);
    }
  };

  const handleNwcInvoiceBack = () => {
    nwcMode.clearReceiveInvoice();
    setMintError("");
    setLightningReceiveView("amount");
  };

  const handleCopyStoredToken = async (token: string) => {
    try {
      await navigator.clipboard?.writeText(token);
      showToast("Token copied", 2000);
    } catch (error) {
      console.warn("Failed to copy token", error);
    }
  };

  const openWalletModeSheet = () => {
    nwcSweeps.refreshMintBalances();
    if (hasNwcConnection) refreshNwcInfo().catch(() => null);
    setShowWalletModeSheet(true);
  };

  const handleSwitchWalletMode = (next: "ecash" | "nwc") => {
    setWalletMode(next);
    setShowWalletModeSheet(false);
    syncCashuWallet();
    if (next === "nwc") {
      nwcMode.refreshBalance();
      showToast(`Using ${nwcMode.walletLabel}`, 2500);
    } else {
      showToast("Using ecash wallet", 2500);
    }
  };

  const walletRootClass = `wallet-modal${showBottomNav ? " wallet-modal--with-nav" : ""}`;

  // Move funds out (the wallet is withdraw-only, C6-1). A mint's funds become one token in two
  // steps: switch to that mint, then, once the wallet has switched, export every note.
  const [showMoveFundsOut, setShowMoveFundsOut] = useState(false);
  const [moveOutExportMint, setMoveOutExportMint] = useState<string | null>(null);
  const [moveOutError, setMoveOutError] = useState("");
  useEffect(() => {
    if (open && openMoveFundsOut) setShowMoveFundsOut(true);
  }, [open, openMoveFundsOut]);
  const closeMoveFundsOut = useCallback(() => {
    setShowMoveFundsOut(false);
    setMoveOutError("");
    onMoveFundsOutClosed?.();
  }, [onMoveFundsOutClosed]);
  const moveOutMints = useMemo(() => {
    if (!showMoveFundsOut) return [];
    return Object.entries(loadProofStore())
      .map(([mint, list]) => ({
        mintUrl: mint,
        sat: Array.isArray(list) ? list.reduce((sum, proof) => sum + amountToNumber(proof?.amount), 0) : 0,
      }))
      .sort((a, b) => b.sat - a.sat);
  }, [showMoveFundsOut, proofs, totalBalance]);
  const requestMoveOutExport = useCallback((targetMint: string) => {
    setMoveOutError("");
    setMoveOutExportMint(targetMint);
    if (targetMint !== mintUrl) {
      setMintUrl(targetMint).catch((err: any) => {
        setMoveOutError(err?.message || "Unable to switch to that mint.");
        setMoveOutExportMint(null);
      });
    }
  }, [mintUrl, setMintUrl]);
  useEffect(() => {
    if (!moveOutExportMint || moveOutExportMint !== mintUrl || !walletReady) return;
    const notes = (proofs || []).filter((proof) => typeof proof?.secret === "string" && proof.secret && amountToNumber(proof.amount) > 0);
    const total = notes.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
    let cancelled = false;
    (async () => {
      try {
        if (!total) throw new Error("This mint has nothing left to move.");
        resetEcashSendForm();
        await finalizeManualSelection({ selection: notes.map((proof) => proof.secret), selectedTotal: total, target: total });
        if (cancelled) return;
        setShowMoveFundsOut(false);
        setSendMode("ecash");
        setShowSendOptions(false);
      } catch (err: any) {
        if (!cancelled) setMoveOutError(err?.message || "Unable to make a token.");
      } finally {
        if (!cancelled) setMoveOutExportMint(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [moveOutExportMint, mintUrl, walletReady, proofs, finalizeManualSelection, resetEcashSendForm]);

  if (!open) return null;

  return (
    <div className={walletRootClass}>
          <div className="wallet-modal__header">
            <div className="wallet-modal__title-group">
              <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
              <span className="wallet-modal__title">Wallet</span>
                <button
                  type="button"
                  className={unitButtonClass}
                  onClick={handleTogglePrimary}
                  aria-disabled={!canToggleCurrency}
                  title={canToggleCurrency ? "Toggle primary currency" : "Currency toggle available when conversion is enabled"}
                >
                  {unitLabel}
                </button>
            </div>
              <div className="wallet-modal__utilities">
                <button className="ghost-button button-sm pressable" onClick={()=>setShowHistory(true)}>History</button>
                <button className="ghost-button button-sm pressable" onClick={openNwcManager}>Wallets</button>
                <button className="ghost-button button-sm pressable" onClick={()=>setShowWalletSettings(true)}>Settings</button>
              </div>
          </div>
          <div className={contentClass}>
            <button
              type="button"
              className={balanceCardClass}
              onClick={handleTogglePrimary}
              disabled={!canToggleCurrency}
              title={
                canToggleCurrency
                  ? "Toggle primary currency"
                  : "Currency toggle available when conversion is enabled"
              }
              aria-label={
                canToggleCurrency
                  ? "Toggle wallet primary currency"
                  : "Wallet currency toggle disabled"
              }
            >
              {nwcBalanceUnknown ? (
                <>
                  <div className="wallet-balance-card__amount" aria-label={`${nwcMode.walletLabel} balance unknown`}>—</div>
                  {nwcMode.balanceUnavailableReason && (
                    <div className="wallet-balance-card__secondary">{nwcMode.balanceUnavailableReason}</div>
                  )}
                </>
              ) : (
                <>
                  <div className="wallet-balance-card__amount">{primaryAmountDisplay}</div>
                  {secondaryAmountDisplay && (
                    <div className="wallet-balance-card__secondary">{secondaryAmountDisplay}</div>
                  )}
                </>
              )}
              {(pendingBalanceDisplay || priceMeta) && (
                <div className="wallet-balance-card__meta space-y-1">
                  {pendingBalanceDisplay && <div>{pendingBalanceDisplay}</div>}
                  {priceMeta && <div>{priceMeta}</div>}
                </div>
              )}
            </button>
            {nwcWalletActive && nwcSweeps.tokens.length > 0 && (
              <button
                type="button"
                className="ghost-button button-sm pressable w-full"
                onClick={() => setShowStoredTokens(true)}
              >
                {nwcSweeps.tokens.length} ecash token{nwcSweeps.tokens.length === 1 ? "" : "s"}
                {nwcSweeps.storedTokenSat > 0 ? ` · ${formatSatAmount(nwcSweeps.storedTokenSat)}` : ""}
              </button>
            )}
            <div className="wallet-modal__cta">
              <button className="accent-button pressable" onClick={() => setShowMoveFundsOut(true)}>Move funds out</button>
              <button
                type="button"
                className="wallet-modal__scan-button pressable"
                onClick={()=>{ void openScanner(); }}
                aria-label="Scan code"
                title="Scan code"
              >
                <svg className="wallet-modal__scan-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 6h2.4l1.1-2h3l1.1 2H17a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
                  <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
                  <circle cx="18.25" cy="9.25" r="0.75" fill="currentColor" />
                </svg>
              </button>
              <button className="ghost-button pressable" onClick={openLightningSendSheet}>Send</button>
            </div>
          </div>

      <ActionSheet
        open={receiveLockVisible}
        onClose={() => {
          setReceiveLockVisible(false);
        }}
        title="Lock eCash"
      >
        <div className="wallet-section space-y-4">
          {activeP2pkKey ? (
            <>
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={activeP2pkKey.publicKey}
                label="P2PK key"
                copyLabel="Copy key"
                size={240}
                extraActions={
                  <button className="accent-button button-sm pressable" onClick={() => { handleGenerateP2pkKey(); }}>
                    Generate new key
                  </button>
                }
              />
              <div className="space-y-1 text-xs text-secondary">
                {activeP2pkKey.label?.trim() && (
                  <div className="font-medium text-primary">{activeP2pkKey.label.trim()}</div>
                )}
                <div className="break-all text-[11px] text-tertiary">{activeP2pkKey.publicKey}</div>
                <div className="text-[11px]">
                  Used {activeP2pkKey.usedCount}×
                  {activeP2pkKey.lastUsedAt ? ` • Last ${new Date(activeP2pkKey.lastUsedAt).toLocaleDateString()}` : ""}
                </div>
                {activeP2pkKey.usedCount > 0 && (
                  <div className="text-[11px] text-amber-400 font-medium">
                    Warning: This key was used before. Use a new key for better privacy.
                  </div>
                )}
                {primaryP2pkKey?.id === activeP2pkKey.id && (
                  <div className="text-[11px] text-accent">Default lock for new tokens</div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3 text-sm text-secondary">
              <div>Generate a P2PK key to lock incoming tokens. Only share this key with trusted senders.</div>
              <div className="flex flex-wrap gap-2 text-xs">
                <button className="accent-button button-sm pressable" onClick={() => { handleGenerateP2pkKey(); }}>
                  Generate key
                </button>
                <button className="ghost-button button-sm pressable" onClick={() => setReceiveLockVisible(false)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <NwcWalletModeSheet
        open={showWalletModeSheet}
        onClose={() => setShowWalletModeSheet(false)}
        mode={walletMode}
        hasConnection={hasNwcConnection}
        walletLabel={nwcMode.walletLabel}
        walletMethods={nwcInfo?.methods}
        mintBalances={nwcSweeps.mintBalances}
        journal={nwcSweeps.migrationJournal}
        migrationError={nwcSweeps.migrationError}
        busy={nwcSweeps.busy}
        formatSatAmount={formatSatAmount}
        onOpenNwcManager={() => {
          setShowWalletModeSheet(false);
          openNwcManager();
        }}
        onMigrate={nwcSweeps.runMigration}
        onSwitch={handleSwitchWalletMode}
      />
      <StoredTokensSheet
        open={showStoredTokens}
        onClose={() => setShowStoredTokens(false)}
        walletLabel={nwcMode.walletLabel}
        tokens={nwcSweeps.tokens}
        tokenStates={nwcSweeps.tokenStates}
        tokenError={nwcSweeps.tokenError}
        busy={nwcSweeps.busy}
        formatSatAmount={formatSatAmount}
        onCheck={() => void nwcSweeps.checkTokenStates()}
        onSweep={(ids) => void nwcSweeps.sweepTokens(ids)}
        onCopy={(token) => void handleCopyStoredToken(token)}
        onDelete={(id) => void nwcSweeps.deleteToken(id)}
      />


      <ActionSheet open={receiveMode === "lnurlWithdraw"} onClose={closeReceiveLnurlWithdrawSheet} title="LNURL Withdraw">
        {lnurlWithdrawInfo ? (
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary">Source: {lnurlWithdrawInfo.domain}</div>
            <div className="text-xs text-secondary">
              Limits: {formatSatAmount(Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000))} – {formatSatAmount(Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000))}
            </div>
            {lnurlWithdrawInvoice && (
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={lnurlWithdrawInvoice}
                label="Mint invoice"
                copyLabel="Copy invoice"
                size={220}
              />
            )}
            <input
              className="pill-input"
              placeholder={amountInputPlaceholder}
              value={lnurlWithdrawAmt}
              onChange={(e)=>setLnurlWithdrawAmt(e.target.value)}
              inputMode="decimal"
            />
            <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
              <button
                className="accent-button button-sm pressable"
                onClick={handleLnurlWithdrawConfirm}
                disabled={!mintUrl || lnurlWithdrawState === "creating" || lnurlWithdrawState === "waiting"}
              >Withdraw</button>
              {lnurlWithdrawStatusText && <span>{lnurlWithdrawStatusText}</span>}
              {lnurlWithdrawMessage && (
                <span className={lnurlWithdrawState === "error" ? "text-rose-400" : "text-accent"}>{lnurlWithdrawMessage}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Scan an LNURL withdraw QR code to pull funds into your wallet.</div>
        )}
      </ActionSheet>

      <MoveFundsOutSheet
        open={showMoveFundsOut}
        onClose={closeMoveFundsOut}
        removalDateLabel={walletRemovalDateLabel()}
        mints={moveOutMints}
        formatSatAmount={formatSatAmount}
        busyMint={moveOutExportMint}
        error={moveOutError}
        onSendLightning={() => { closeMoveFundsOut(); openLightningSendSheet(); }}
        onExportMint={requestMoveOutExport}
        nwcAvailable={hasNwcConnection}
        onSendNwc={() => { closeMoveFundsOut(); openNwcManager(); }}
        npubCashAvailable={activeLightningAddressProvider === "npub.cash"}
        onClaimNpubCash={() => { void handleClaimNpubCash({ auto: false }); }}
        revealSeed={() => { try { return getWalletSeedMnemonic(); } catch { return null; } }}
      />

      {/* Send options */}
      <ActionSheet open={showSendOptions && sendMode === null} onClose={()=>setShowSendOptions(false)} title="Send">
        <div className="wallet-section space-y-2 text-sm">
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("ecash")}>
            <span>ecash</span>
            <span className="text-tertiary">→</span>
          </button>
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("lightning")}>
            <span>Lightning</span>
            <span className="text-tertiary">→</span>
          </button>
        </div>
      </ActionSheet>

      {sendMode === "ecash" && (
        <Suspense fallback={null}>
          <EcashSendSheet
        sendMode={sendMode}
        closeEcashSendSheet={closeEcashSendSheet}
        openLightningSendSheet={openLightningSendSheet}
        ecashSendView={ecashSendView}
        ecashSendRecipient={ecashSendRecipient}
        isNip05VerifiedFor={isNip05VerifiedFor}
        truncateContactName={truncateContactName}
        openContactsFor={openContactsFor}
        lockSendToPubkey={lockSendToPubkey}
        handleClearSendLock={handleClearSendLock}
        handlePasteSendLock={handlePasteSendLock}
        mintSelectionOptions={mintSelectionOptions}
        selectedMintValue={selectedMintValue}
        setMintUrl={setMintUrl}
        mintInfoByUrl={mintInfoByUrl}
        selectedMintLabel={selectedMintLabel}
        selectedMintBalanceLabel={selectedMintBalanceLabel}
        canToggleCurrency={canToggleCurrency}
        handleTogglePrimary={handleTogglePrimary}
        ecashPrimaryAmountText={ecashPrimaryAmountText}
        ecashSecondaryAmountText={ecashSecondaryAmountText}
        sendLockError={sendLockError}
        primaryCurrency={primaryCurrency}
        handleEcashAmountKeypadInput={handleEcashAmountKeypadInput}
        sendTokenStr={sendTokenStr}
        setEcashSendView={setEcashSendView}
        handleCreateSendToken={handleCreateSendToken}
        creatingSendToken={creatingSendToken}
        tokenAlreadyCreatedForAmount={tokenAlreadyCreatedForAmount}
        canCreateSendTokenAmount={canCreateSendTokenAmount}
        applyEcashContact={applyEcashContact}
        handleOpenEcashAmountView={handleOpenEcashAmountView}
        lastSendTokenLockLabel={lastSendTokenLockLabel}
        peanutSendToken={peanutSendToken}
        handleCopyNutToken={handleCopyNutToken}
        nutTokenCopied={nutTokenCopied}
        lastSendTokenAmount={lastSendTokenAmount}
        satFormatter={satFormatter}
        formatSatAmount={formatSatAmount}
        walletConversionEnabled={walletConversionEnabled}
        btcUsdPrice={btcUsdPrice}
        formatUsdAmount={formatUsdAmount}
        lastSendTokenMint={lastSendTokenMint}
        handlePasteEcashInput={handlePasteEcashInput}
        mintUrl={mintUrl}
          />
        </Suspense>
      )}

      <WalletContactsPickerSheet
        onClose={closeContactsSheet}
        onSelectContact={handleSelectContact}
      />

      <ActionSheet open={manualSendPlan !== null} onClose={closeManualSendPlan} title="Select notes">
        {manualSendPlan && (
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary">
              {manualSendPlan.exactMatchSelection
                ? "Exact offline match selected automatically. Adjust the notes if you'd like a different amount."
                : "Exact offline match unavailable. Select notes to build your token."}
            </div>
            <div className="text-xs text-secondary">Target: {formatSatAmount(manualSendPlan.target)}</div>
            {(manualSendPlan.closestBelow !== null || manualSendPlan.closestAbove !== null) && (
              <div className="space-y-2">
                <div className="space-y-1 text-[11px] text-secondary">
                  {manualSendPlan.closestBelow !== null && (
                    <div>Closest below: {formatSatAmount(manualSendPlan.closestBelow)}</div>
                  )}
                  {manualSendPlan.closestAbove !== null && (
                    <div>Closest above: {formatSatAmount(manualSendPlan.closestAbove)}</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {manualSendPlan.exactMatchSelection && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.exactMatchSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() => applyManualSendSelection(manualSendPlan.exactMatchSelection)}
                    >
                      Exact match ({formatSatAmount(manualSendPlan.target)})
                    </button>
                  )}
                  {manualSendPlan.closestBelowSelection && manualSendPlan.closestBelow !== null && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.closestBelowSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() =>
                        applyManualSendSelection(manualSendPlan.closestBelowSelection, { autoCreate: true })
                      }
                    >
                      Closest below ({formatSatAmount(manualSendPlan.closestBelow)})
                    </button>
                  )}
                  {manualSendPlan.closestAboveSelection && manualSendPlan.closestAbove !== null && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.closestAboveSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() =>
                        applyManualSendSelection(manualSendPlan.closestAboveSelection, { autoCreate: true })
                      }
                    >
                      Closest above ({formatSatAmount(manualSendPlan.closestAbove)})
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="text-[11px] text-secondary">Use the controls below to adjust the amount.</div>
            <div className="space-y-2">
              {manualSendPlan.groups.map((group) => {
                const totalCount = group.secrets.length;
                const selectedCount = group.secrets.reduce(
                  (count, secret) => (manualSendSelection.has(secret) ? count + 1 : count),
                  0,
                );
                return (
                  <div
                    key={`manual-group-${group.amount}`}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-surface bg-surface-muted px-3 py-2"
                  >
                    <div className="text-xs">
                      <div className="font-semibold text-primary">{formatSatAmount(group.amount)} ×{totalCount}</div>
                      <div className="text-[11px] text-secondary">Selected: {selectedCount}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => adjustManualSendGroupSelection(group.amount, -1)}
                        disabled={selectedCount === 0}
                        aria-label={`Remove a ${formatSatAmount(group.amount)} note`}
                      >
                        −
                      </button>
                      <span className="min-w-[2rem] text-center text-sm font-semibold text-primary">
                        {selectedCount}
                      </span>
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => adjustManualSendGroupSelection(group.amount, 1)}
                        disabled={selectedCount === totalCount}
                        aria-label={`Add a ${formatSatAmount(group.amount)} note`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-sm font-semibold text-primary">Selected: {formatSatAmount(manualSelectedTotal)}</div>
            {manualSendPlan.lockActive && (
              <div className="text-[11px] text-secondary">
                Receiver locking isn't applied when manually selecting notes.
              </div>
            )}
            {manualSendError && <div className="text-[11px] text-rose-500">{manualSendError}</div>}
            <div className="flex gap-2 text-xs">
              <button
                className="accent-button button-sm pressable"
                onClick={handleManualSendConfirm}
                disabled={manualSendInProgress || manualSendSelection.size === 0}
              >
                {manualSendInProgress ? "Creating…" : "Create token"}
              </button>
              <button
                className="ghost-button button-sm pressable"
                onClick={closeManualSendPlan}
                disabled={manualSendInProgress}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </ActionSheet>

      {sendMode === "lightning" && (
        <Suspense fallback={null}>
          <LightningSendSheet
        nwcMode={nwcWalletActive}
        nwcWalletLabel={nwcMode.walletLabel}
        nwcBalanceLabel={nwcMode.balanceSat != null ? `${formatSatAmount(nwcMode.balanceSat)} available` : ""}
        sendMode={sendMode}
        closeLightningSendSheet={closeLightningSendSheet}
        openEcashSendSheet={openEcashSendSheet}
        isCompactLightningSheetLayout={isCompactLightningSheetLayout}
        lightningSendView={lightningSendView}
        openContactsFor={openContactsFor}
        lightningContactCount={lightningContactCount}
        lnRef={lnRef}
        lnInput={lnInput}
        setLnInput={setLnInput}
        lnError={lnError}
        bolt11Details={bolt11Details}
        commitLightningInputFromDom={commitLightningInputFromDom}
        handleLightningInputReview={handleLightningInputReview}
        handlePasteLightningInput={handlePasteLightningInput}
        mintSelectionOptions={mintSelectionOptions}
        selectedMintValue={selectedMintValue}
        setMintUrl={setMintUrl}
        mintInfoByUrl={mintInfoByUrl}
        selectedMintLabel={selectedMintLabel}
        selectedMintBalanceLabel={selectedMintBalanceLabel}
        satFormatter={satFormatter}
        formatSatAmount={formatSatAmount}
        lightningInvoiceAmountSat={lightningInvoiceAmountSat}
        lightningInvoiceAmountSecondaryDisplay={lightningInvoiceAmountSecondaryDisplay}
        normalizedLnInput={normalizedLnInput}
        handlePayInvoice={handlePayInvoice}
        mintUrl={mintUrl}
        lnState={lnState}
        canToggleCurrency={canToggleCurrency}
        handleTogglePrimary={handleTogglePrimary}
        lightningSendPrimaryAmountText={lightningSendPrimaryAmountText}
        lightningSendSecondaryAmountText={lightningSendSecondaryAmountText}
        primaryCurrency={primaryCurrency}
        handleLightningSendAmountKeypadInput={handleLightningSendAmountKeypadInput}
        lightningDestinationDisplay={lightningDestinationDisplay}
        isLnurlInput={isLnurlInput}
        lnurlPayData={lnurlPayData}
        isLnAddress={isLnAddress}
        lnurlRequiresAmount={lnurlRequiresAmount}
        lnAddrAmt={lnAddrAmt}
          />
        </Suspense>
      )}

      {sendMode === "paymentRequest" && (
        <Suspense fallback={null}>
          <PaymentRequestFulfillSheet
        sendMode={sendMode}
        closePaymentRequestSheet={closePaymentRequestSheet}
        handlePasteEcashRequest={handlePasteEcashRequest}
        paymentRequestState={paymentRequestState}
        mintSelectionOptions={mintSelectionOptions}
        selectedMintValue={selectedMintValue}
        setMintUrl={setMintUrl}
        mintInfoByUrl={mintInfoByUrl}
        selectedMintLabel={selectedMintLabel}
        selectedMintBalanceLabel={selectedMintBalanceLabel}
        paymentRequestAmountButtonEnabled={paymentRequestAmountButtonEnabled}
        canTogglePaymentRequestCurrency={canTogglePaymentRequestCurrency}
        handlePaymentRequestAmountUnitToggle={handlePaymentRequestAmountUnitToggle}
        paymentRequestPrimaryAmountText={paymentRequestPrimaryAmountText}
        paymentRequestSecondaryAmountText={paymentRequestSecondaryAmountText}
        paymentRequestHasFixedAmount={paymentRequestHasFixedAmount}
        primaryCurrency={primaryCurrency}
        handlePaymentRequestKeypadInput={handlePaymentRequestKeypadInput}
        handleFulfillPaymentRequest={handleFulfillPaymentRequest}
        paymentRequestStatus={paymentRequestStatus}
        paymentRequestManualAmount={paymentRequestManualAmount}
        paymentRequestActionLabel={paymentRequestActionLabel}
        paymentRequestMessage={paymentRequestMessage}
        paymentRequestError={paymentRequestError}
          />
        </Suspense>
      )}

      <ActionSheet
        open={showScanner}
        onClose={closeScanner}
        title="Scan Code"
        stackLevel={95}
        actions={(
          <button
            className="ghost-button button-sm pressable"
            onClick={() => {
              void handlePasteFromClipboard();
            }}
          >Paste</button>
        )}
      >
        <div className="wallet-section space-y-3">
          <QrScanner active={showScanner} onDetected={handleScannerDetected} onError={handleScannerError} />
          {scannerMessage && (
            <div className={`text-xs text-center ${scannerMessageTone === "error" ? "text-rose-400" : "text-secondary"}`}>
              {scannerMessage}
            </div>
          )}
        </div>
      </ActionSheet>

        <ActionSheet
          open={!!scannedContact}
          onClose={() => setScannedContact(null)}
          header={scannedContactHeader}
          stackLevel={75}
        >
          {scannedContact && (
            <div className="contact-detail-view">
              <div className="contact-hero">
                <div className="contact-hero__center">
                  <div className="contact-qr-wrapper">
                    {scannedContactShareValue ? (
                      <QrCodeCard
                        className="contact-qr-card"
                        value={scannedContactShareValue}
                        label={scannedContactTitle}
                        size={200}
                        flat
                        hideLabel
                        hideCopyButton
                      />
                    ) : (
                      <div className="contact-qr-placeholder text-secondary">No QR to share yet.</div>
                    )}
                  </div>
                  <div
                    className={`contact-heading${scannedContact.picture ? "" : " contact-heading--text-only"}`}
                  >
                    {scannedContact.picture && (
                      <img src={scannedContact.picture} alt={scannedContactTitle} className="contact-portrait" />
                    )}
                    <div className="contact-heading__text">
                      <div className="contact-name-lg" title={scannedContactTitle}>
                        {truncateContactName(scannedContactTitle, 34)}
                      </div>
                      {scannedContactUsername && (
                        <div className="contact-username" title={scannedContactUsername}>
                          {truncateContactValue(scannedContactUsername, 33)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {scannedContact &&
                (contactHasLightning(scannedContact) ||
                  scannedContactCanShare) && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {walletEnabled && contactHasLightning(scannedContact) && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        applyLightningContact(scannedContact);
                        setScannedContact(null);
                      }}
                    >
                      Pay lightning
                    </button>
                  )}
                  {walletEnabled && scannedContactCanShare && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        openEcashSendToContact(scannedContact);
                        setScannedContact(null);
                      }}
                    >
                      Pay eCash
                    </button>
                  )}
                </div>
              )}

              <div className="contact-fields">
                {scannedContactFields.length ? (
                  scannedContactFields.map((field) => {
                    const isNip05Field = field.key === "nip05";
                    return (
                      <div key={field.key} className="contact-field">
                        <div className="contact-field__label">{field.label}</div>
                        <button
                          type="button"
                          className={`contact-field__value${field.multiline ? " contact-field__value--multiline" : ""}${
                            isNip05Field ? " contact-field__value--nip05" : ""
                          }`}
                          onClick={() => handleCopyContactField(field.value, field.label)}
                          title={field.value}
                        >
                          <span
                            className={`contact-field__text${field.multiline ? " contact-field__text--multiline" : ""}`}
                          >
                            {field.multiline ? field.value : truncateContactValue(field.value, 36)}
                          </span>
                          {isNip05Field && scannedContactNip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="contact-empty text-secondary">No details saved for this contact yet.</div>
                )}
              </div>
            </div>
          )}
        </ActionSheet>

      {showHistory && (
        <Suspense fallback={null}>
          <WalletHistorySheet
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        setExpandedHistoryId={setExpandedHistoryId}
        historyFilterControls={historyFilterControls}
        history={history}
        filteredHistory={filteredHistory}
        expandedHistoryId={expandedHistoryId}
        walletConversionEnabled={walletConversionEnabled}
        formatRelativeTime={formatRelativeTime}
        formatHistoryAmount={formatHistoryAmount}
        formatUsdAmount={formatUsdAmount}
        resolveMintDisplay={resolveMintDisplay}
        deriveHistoryStatus={deriveHistoryStatus}
        historyRedeemStates={historyRedeemStates}
        historyCheckStates={historyCheckStates}
        historyMintQuoteStates={historyMintQuoteStates}
        historyRevertState={historyRevertState}
        handleRedeemPendingHistoryItem={handleRedeemPendingHistoryItem}
        handleCheckHistoryMintQuote={handleCheckHistoryMintQuote}
        performTokenStateCheck={performTokenStateCheck}
        handleRevertHistoryToken={handleRevertHistoryToken}
        handleMarkHistoryTokenSpent={handleMarkHistoryTokenSpent}
        handleDeleteHistoryEntry={handleDeleteHistoryEntry}
        satFormatter={satFormatter}
        formatSatAmount={formatSatAmount}
        historyFilter={historyFilter}
          />
        </Suspense>
      )}

      {/* Mint balances */}
      <ActionSheet open={showMintBalances} onClose={()=>setShowMintBalances(false)} title="Mint balances">
        <div className="space-y-4 text-sm">
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">Active mint</div>
            <div className="flex gap-2 items-center">
              <input
                className="pill-input flex-1"
                value={mintInputSheet}
                onChange={(e)=>setMintInputSheet(e.target.value)}
                placeholder="https://mint.minibits.cash/Bitcoin"
              />
              <button
                className="accent-button button-sm pressable"
                onClick={async ()=>{ try { await setMintUrl(mintInputSheet.trim()); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}
              >Save</button>
            </div>
            <div className="text-xs text-secondary">Current: {mintUrl}</div>
          </div>

          <div className="wallet-section space-y-3">
            <div className="space-y-1">
              <div className="text-xs text-secondary uppercase tracking-wide">Saved mints</div>
              <div className="text-xs text-secondary">
                Keep the mints you use handy. We'll add new ones automatically when you receive eCash and keep them here until you remove them.
              </div>
            </div>
            {mintEntries.length === 0 ? (
              <div className="text-secondary">No saved mints yet. Add one above or receive eCash to get started.</div>
            ) : (
              <div className="space-y-2">
                {mintEntries.map((m) => (
                  <div key={m.url} className="bg-surface-muted border border-surface rounded-2xl p-3 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="text-xs text-secondary">{m.url === mintUrl ? "Active" : "Mint"}</div>
                      <button
                        className="text-left text-primary underline decoration-dotted decoration-surface-border break-all"
                        title={m.url}
                        onClick={async ()=>{ try { await navigator.clipboard?.writeText(m.url); } catch {} }}
                      >{m.url}</button>
                    </div>
                    <div className="text-right space-y-1">
                      <div className="text-xs text-secondary">Balance</div>
                      <div className="font-semibold">{formatSatAmount(m.balance)}</div>
                    </div>
                    <div className="flex flex-col gap-2 w-full sm:w-auto">
                      {m.url !== mintUrl && (
                        <button
                          className="accent-button button-sm pressable w-full"
                          onClick={async ()=>{ try { await setMintUrl(m.url); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}
                        >
                          Set active
                        </button>
                      )}
                      <button
                        className="ghost-button button-sm pressable w-full text-rose-400"
                        onClick={()=>handleRemoveMintEntry(m.url)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </ActionSheet>

      {showNwcSheet && (
        <Suspense fallback={null}>
          <WalletSwapSheet
        showNwcSheet={showNwcSheet}
        closeNwcSheets={closeNwcSheets}
        openNwcManager={openNwcManager}
        hasNwcConnection={hasNwcConnection}
        swapOptionList={swapOptionList}
        swapFromValue={swapFromValue}
        setSwapFromValue={setSwapFromValue}
        swapToValue={swapToValue}
        setSwapToValue={setSwapToValue}
        getSwapOptionMeta={getSwapOptionMeta}
        canToggleCurrency={canToggleCurrency}
        handleTogglePrimary={handleTogglePrimary}
        swapPrimaryAmountText={swapPrimaryAmountText}
        swapSecondaryAmountText={swapSecondaryAmountText}
        primaryCurrency={primaryCurrency}
        handleSwapAmountKeypadInput={handleSwapAmountKeypadInput}
        handleSwapSubmit={handleSwapSubmit}
        canSubmitSwap={canSubmitSwap}
        swapInProgress={swapInProgress}
        swapScenario={swapScenario}
        mintSwapState={mintSwapState}
        mintSwapStatusText={mintSwapStatusText}
        mintSwapMessage={mintSwapMessage}
        nwcFundInProgress={nwcFundInProgress}
        nwcFundStatusText={nwcFundStatusText}
        nwcFundState={nwcFundState}
        nwcFundMessage={nwcFundMessage}
        nwcFundInvoice={nwcFundInvoice}
        nwcWithdrawInProgress={nwcWithdrawInProgress}
        nwcWithdrawStatusText={nwcWithdrawStatusText}
        nwcWithdrawState={nwcWithdrawState}
        nwcWithdrawMessage={nwcWithdrawMessage}
        nwcWithdrawInvoice={nwcWithdrawInvoice}
          />
        </Suspense>
      )}

      {showNwcManager && (
        <Suspense fallback={null}>
          <WalletNwcManagerSheet
            walletMode={walletMode}
        showNwcManager={showNwcManager}
        closeNwcManager={closeNwcManager}
        formatSatAmount={formatSatAmount}
          />
        </Suspense>
      )}

      {showWalletSettings && (
        <Suspense fallback={null}>
          <WalletSettingsSheet
            open={showWalletSettings}
            onClose={() => setShowWalletSettings(false)}
            settings={walletSettings}
            setSettings={setWalletSettings}
            defaultRelays={defaultRelays}
            onResetWalletTokenTracking={onResetWalletTokenTracking}
            onOpenWallets={() => { setShowWalletSettings(false); openNwcManager(); }}
            onOpenSwap={() => { setShowWalletSettings(false); setShowNwcSheet(true); }}
            onOpenMints={() => { setShowWalletSettings(false); setShowMintBalances(true); }}
          />
        </Suspense>
      )}

    </div>
  );

}
