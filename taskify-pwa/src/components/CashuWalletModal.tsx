// @ts-nocheck
// TODO: Continue breaking up this still-large wallet surface. Extract more custom hooks
// (wallet state, mint management, send/receive flows, payment requests, NWC,
// nostr DM redemption, lightning, swaps) into src/hooks/wallet/ and split
// sub-views into smaller components to reduce this file's size.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PaymentRequestTransportType,
  type PaymentRequestPayload,
  type PaymentRequestTransport,
  type Proof,
} from "@cashu/cashu-ts";
import { nip19, nip44 } from "nostr-tools";
import { useCashu } from "../context/CashuContext";
import { useNwc } from "../context/NwcContext";
import { useToast } from "../context/ToastContext";
import { useP2PK, type P2PKKey } from "../context/P2PKContext";
import { EcashGlyph } from "./EcashGlyph";
import {
  Nut16Collector,
} from "../wallet/nut16";
import { decodeBolt11Amount } from "../wallet/lightning";


import { getSkSync as nostrSkSync } from "../lib/nostrSkStore";
import { LS_NOSTR_RELAYS } from "../nostrKeys";
import { kvStorage } from "../storage/kvStorage";
import { type GroupChat } from "../lib/groupChatState";
import { buildContactShareEnvelope, sendShareMessage } from "../lib/shareInbox";
import { normalizeNostrPubkey } from "../lib/nostr";


import {
  isImageMime,
  isVideoMime,
  isAudioMime,
} from "../lib/messengerAttachmentCrypto";
import type { CreateSendTokenOptions } from "../mint/MintSession";
import {
  deriveNpubCashIdentity,
} from "../wallet/npubCash";
import {
  SOLIFE_LIGHTNING_ADDRESS_DOMAIN,
  claimSolifeCustomAddress,
  fetchSolifeAccount,
  fetchSolifeConfig,
  updateSolifeLightningAddressMint,
} from "../wallet/solife";
import { ActionSheet } from "./ActionSheet";
import type { Contact } from "../lib/contacts";
import {
  contactDisplayLabel,
  contactHasNpub,
  contactHasLightning,
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
  makeContactId,
  normalizeContact,
  sanitizeUsername,
  saveContactsToStorage,
} from "../lib/contacts";
import type { WalletMessageItem } from "../types/walletMessages";
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
  isCashuTokenDetail,
  type HistoryDetailKind,
  type HistoryItem,
  type StoredProofForState,
} from "../wallet/walletHistoryTypes";
import { useWalletHistory } from "../hooks/wallet/useWalletHistory";
import { usePendingTokenHistorySync } from "../hooks/wallet/usePendingTokenHistorySync";
import { useMintBackup } from "../hooks/wallet/useMintBackup";
import { useMintSelection } from "../hooks/wallet/useMintSelection";
import { useNwcManager } from "../hooks/wallet/useNwcManager";
import { useWalletMediaQuery } from "../hooks/wallet/useWalletMediaQuery";
import { SATS_PER_BTC, useWalletPrice } from "../hooks/wallet/useWalletPrice";
import { useWalletSwapFlow } from "../hooks/wallet/useWalletSwapFlow";
import { useLightningFlow, type LnurlPayData } from "../hooks/wallet/useLightningFlow";
import { useEcashReceiveState } from "../hooks/wallet/useEcashReceiveState";
import { useEcashSendState } from "../hooks/wallet/useEcashSendState";
import { usePaymentRequestState } from "../hooks/wallet/usePaymentRequestState";
import { useNostrPoolState } from "../hooks/wallet/useNostrPoolState";
import { useDmState, type WalletDmAttachment, type DmReaction, type WalletDmMessage, MAX_GROUP_MEMBERS, generateGroupId, normalizeDmPeerHex } from "../hooks/wallet/useDmState";
import { useContactsState } from "../hooks/wallet/useContactsState";
import { useManualSendPlan } from "../hooks/wallet/useManualSendPlan";
import { useDmSubscription } from "../hooks/wallet/useDmSubscription";
import { useDmSend } from "../hooks/wallet/useDmSend";
import { useContactsSync } from "../hooks/wallet/useContactsSync";
import { useDmThreadActions } from "../hooks/wallet/useDmThreadActions";
import { useContactLookup } from "../hooks/wallet/useContactLookup";
import { useScannerFlow } from "../hooks/wallet/useScannerFlow";
import { useEcashRedeem } from "../hooks/wallet/useEcashRedeem";
import { useSheetManagement } from "../hooks/wallet/useSheetManagement";
import { useNpubCashClaim } from "../hooks/wallet/useNpubCashClaim";
import { useHistoryFormatters } from "../hooks/wallet/useHistoryFormatters";
import { useWalletFormatters } from "../hooks/wallet/useWalletFormatters";
import { useAmountKeypadHandlers } from "../hooks/wallet/useAmountKeypadHandlers";
import { usePaymentRequestFlow } from "../hooks/wallet/usePaymentRequestFlow";
import { useContactDetail } from "../hooks/wallet/useContactDetail";
import { useTokenHistoryActions } from "../hooks/wallet/useTokenHistoryActions";
import { useDmThreadUtils } from "../hooks/wallet/useDmThreadUtils";
import { useContactPaymentActions } from "../hooks/wallet/useContactPaymentActions";
import { useWalletFlowState } from "../hooks/wallet/useWalletFlowState";
import { useAmountFormatters } from "../hooks/wallet/useAmountFormatters";
import { useLightningInputDerived } from "../hooks/wallet/useLightningInputDerived";
import { useHistoryFilter } from "../hooks/wallet/useHistoryFilter";
import { usePaymentRequestDerived } from "../hooks/wallet/usePaymentRequestDerived";
import { useDmMessageDerived } from "../hooks/wallet/useDmMessageDerived";
import { useDmThreadDerived } from "../hooks/wallet/useDmThreadDerived";
import { useThreadUnreadCounts } from "../hooks/wallet/useThreadUnreadCounts";
import { useContactsDerived } from "../hooks/wallet/useContactsDerived";
import { useEcashSendDerived } from "../hooks/wallet/useEcashSendDerived";
import { useChatGroupDerived } from "../hooks/wallet/useChatGroupDerived";
import {
  isSamePaymentRequest,
  type IncomingPaymentRequest,
} from "../wallet/paymentRequestTypes";
import {
  BackIcon,
  CHAT_FILE_PICKER_ACCEPT,
  ChatBubbleIcon,
  CheckIcon,
  CloseIcon,
  GroupAvatar,
  LightningGlyph,
  MessengerFileBubble,
  PencilIcon,
  PersonIcon,
  QrCodeCard,
  QrScanner,
  ShareArrowIcon,
  SwipeableDmThreadRow,
  VerifiedBadgeIcon,
  WalletGlyphIcon,
  avatarInitials,
  formatDmDateSeparator,
  formatDmDay,
  formatDmTime,
  formatShortDate,
  parseDateLikeToUnixSeconds,
  shortenNpubDisplay,
  tryParseJson,
} from "../ui/wallet/walletModalUi";
import {
  yieldToBrowser,
  extractMinibitsPaymentSender,
  getWalletMessageStatusLabel,
  getCalendarInviteStatusLabel,
  computeSubsetSelectionInfo,
  totalForSelection,
  decodeLnurlString,
  decodeContactPayload,
  estimateDataUrlSize,
  isDataUrl,
  pickPreferredProfilePhoto,
  extractDomain,
  extractUrlsFromText,
  renderFormattedText,
  fetchWithTimeout,
  dmThreadKeyForThread,
  buildTokenSpentToastMessage,
  extractWitnesses,
  shouldSuppressProofStateChecks,
  buildWalletMessageSyntheticEventId,
  buildCalendarInviteSyntheticEventId,
  CONTACT_PANEL_HEIGHT,
  UNPAID_MINT_QUOTE_RETENTION_MS,
  CHAT_TIMESTAMP_REVEAL_WIDTH,
  BACKGROUND_REFRESH_INTERVAL_MS,
  NPUB_CASH_REFRESH_STAGGER_MS,
  TOKEN_STATE_BACKGROUND_STAGGER_MS,
  SUBSCRIPTION_RETRY_DELAY_MS,
  type PendingCalendarInvite,
  type SharedContactPreview,
  type NostrEvent,
} from "../wallet/walletModalHelpers";

const EcashReceiveSheet = lazy(() =>
  import("../ui/wallet/EcashReceiveSheet").then((module) => ({ default: module.EcashReceiveSheet })),
);
const LightningReceiveSheet = lazy(() =>
  import("../ui/wallet/LightningReceiveSheet").then((module) => ({ default: module.LightningReceiveSheet })),
);
const EcashSendSheet = lazy(() =>
  import("../ui/wallet/EcashSendSheet").then((module) => ({ default: module.EcashSendSheet })),
);
const WalletContactsSheet = lazy(() =>
  import("../ui/wallet/WalletContactsSheet").then((module) => ({ default: module.WalletContactsSheet })),
);
const LightningSendSheet = lazy(() =>
  import("../ui/wallet/LightningSendSheet").then((module) => ({ default: module.LightningSendSheet })),
);
const WalletHistorySheet = lazy(() =>
  import("../ui/wallet/WalletHistorySheet").then((module) => ({ default: module.WalletHistorySheet })),
);
const WalletSwapSheet = lazy(() =>
  import("../ui/wallet/WalletSwapSheet").then((module) => ({ default: module.WalletSwapSheet })),
);
const WalletNwcManagerSheet = lazy(() =>
  import("../ui/wallet/WalletNwcManagerSheet").then((module) => ({ default: module.WalletNwcManagerSheet })),
);
const PaymentRequestFulfillSheet = lazy(() =>
  import("../ui/wallet/PaymentRequestFulfillSheet").then((module) => ({ default: module.PaymentRequestFulfillSheet })),
);

export default function CashuWalletModal({
  open,
  onClose,
  onOpenBounties,
  page = "wallet",
  showTabSwitcher = true,
  showBottomNav = false,
  walletConversionEnabled,
  walletPrimaryCurrency,
  walletDenominationDisplay,
  setWalletPrimaryCurrency,
  lightningAddressProvider = "solife.me",
  npubCashAutoClaim,
  sentTokenStateChecksEnabled,
  paymentRequestsEnabled,
  paymentRequestsBackgroundChecksEnabled,
  tokenStateResetNonce,
  mintBackupEnabled: mintBackupEnabledProp,
  contactsSyncEnabled,
  fileStorageServer,
  fileServers,
  encryptedFileStorageServer,
  encryptedFileServers,
  messageItems,
  onAcceptMessage,
  onMaybeMessage,
  onDeclineMessage,
  onDismissMessage,
  onMarkMessagesRead,
  inboxPendingItems,
  pendingCalendarInvites,
  onCalendarInviteRsvp,
  onDismissCalendarInvite,
  formatCalendarInviteWhen,
  onDmUnreadCountChange,
  chatMessageRetention = "forever",
}: {
  open: boolean;
  onClose: () => void;
  onOpenBounties?: () => void;
  page?: "wallet" | "contacts" | "chat";
  showTabSwitcher?: boolean;
  showBottomNav?: boolean;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  walletDenominationDisplay: "bitcoin-symbol" | "sat";
  setWalletPrimaryCurrency: (currency: "sat" | "usd") => void;
  lightningAddressProvider?: "solife.me" | "npub.cash" | "none";
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  sentTokenStateChecksEnabled: boolean;
  paymentRequestsEnabled: boolean;
  paymentRequestsBackgroundChecksEnabled: boolean;
  tokenStateResetNonce: number;
  mintBackupEnabled: boolean;
  contactsSyncEnabled: boolean;
  fileStorageServer: string;
  fileServers?: string;
  encryptedFileStorageServer?: string;
  encryptedFileServers?: string;
  messageItems: WalletMessageItem[];
  messagesUnreadCount: number;
  onAcceptMessage: (id: string) => void;
  onMaybeMessage: (id: string) => void;
  onDeclineMessage: (id: string) => void;
  onDismissMessage: (id: string) => void;
  onMarkMessagesRead: (dmEventIds: string[]) => void;
  inboxPendingItems?: WalletMessageItem[];
  pendingCalendarInvites?: PendingCalendarInvite[];
  onCalendarInviteRsvp?: (invite: any, status: string) => void;
  onDismissCalendarInvite?: (invite: any) => void;
  formatCalendarInviteWhen?: (invite: any) => string;
  onDmUnreadCountChange?: (count: number) => void;
  chatMessageRetention?: string;
}) {
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
  const nip17TimestampMode: "random" | "now" = (() => {
    try {
      const value = (kvStorage.getItem("taskify.nip17.timestamp") || "").trim().toLowerCase();
      return value === "now" ? "now" : "random";
    } catch {
      return "random";
    }
  })();

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
  const isCompactLightningSheetLayout = useWalletMediaQuery("(max-height: 820px)");
  const [scannerMessage, setScannerMessage] = useState("");
  type PendingScan =
    | { type: "ecash"; token: string }
    | { type: "bolt11"; invoice: string }
    | { type: "lightningAddress"; address: string }
    | { type: "lnurl"; data: string }
    | { type: "paymentRequest"; request: string };
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [scannedContact, setScannedContact] = useState<Contact | null>(null);
  const [sharedContactPreview, setSharedContactPreview] = useState<SharedContactPreview | null>(null);
  const [walletTab, setWalletTab] = useState<"wallet" | "messages" | "contacts">("wallet");
  const isContactsPage = page === "contacts";
  const isChatPage = page === "chat";
  const {
    chatView, setChatView,
    chatCompose, setChatCompose,
    pendingMessages, setPendingMessages,
    groupChats, setGroupChats,
    groupSelectMembers, setGroupSelectMembers,
    groupNameDraft, setGroupNameDraft,
    renameGroupDraft, setRenameGroupDraft,
    renameGroupBusy, setRenameGroupBusy,
    activeGroupId, setActiveGroupId,
    groupMembersSearch, setGroupMembersSearch,
    groupInfoTab, setGroupInfoTab,
    groupChatsRef,
    dmMutedGroupsRef, dmMutedGroupsVersion, setDmMutedGroupsVersion,
    dmLeftGroupsRef, dmLeftGroupsVersion, setDmLeftGroupsVersion,
    dmThreadReadAtRef, dmThreadReadAtVersion, setDmThreadReadAtVersion,
    attachTrayOpen, setAttachTrayOpen,
    chatKeyboardHeight, setChatKeyboardHeight,
    chatKeyboardHeightCache, setChatKeyboardHeightCache,
    chatComposeInputRef, chatPhotoInputRef, chatFileInputRef,
    messagesScrollRef, messagesInnerRef,
    dragTouchStartX, dragTouchStartY, dragDirectionLocked,
    dmListViewRef, scrollToMessageIdRef, dmAutoScrollStateRef,
    chatModeUsesContacts,
    dmMessages, setDmMessages,
    dmExpandedMessages, setDmExpandedMessages,
    dmMessageActions, setDmMessageActions,
    replyToMessage, setReplyToMessage,
    dmReactions, setDmReactions,
    dmInfoMessage, setDmInfoMessage,
    dmForwardMessage, setDmForwardMessage,
    dmReactionDetail, setDmReactionDetail,
    dmLongPressTimerRef,
    dmDeletedEventsRef, dmDeletedEventsVersion, setDmDeletedEventsVersion,
    dmTempDeletedEventsRef, dmTempDeletedEventsVersion, setDmTempDeletedEventsVersion,
    dmArchivedThreadsRef, dmArchivedThreadsVersion, setDmArchivedThreadsVersion,
    dmBlockedPeersRef, setDmBlockedPeersVersion,
    dmPeerProfilesRef, dmPeerProfileLoadingRef, setDmPeerProfilesVersion,
    dmProcessedEventsRef, dmSubscriptionCloseRef, dmLastSyncRef,
    messageItemsRef,
    dmView, setDmView,
    activeThreadPeer, setActiveThreadPeer,
    dmSearch, setDmSearch,
    scrollToMessageId, setScrollToMessageId,
    visiblePendingMessages,
    toggleDmMessageExpanded, isDmMessageExpanded,
    copyMessageValue,
    persistDeletedDmEvents, persistTempDeletedDmEvents, persistArchivedDmThreads,
    pruneTempDeletedDmEvents, persistBlockedPeers, persistDmMessages,
    persistDmThreadReadState, persistGroupChats, persistGroupStateSet,
    upsertGroupChat, persistDmSyncMeta, persistDmPeerProfileCache,
    buildDmCopyValue, handleDeleteDmMessage, cancelDmLongPress,
  } = useDmState({
    open,
    isChatPage,
    chatMessageRetention,
    showToast,
    messageItems,
  });
  useEffect(() => {
    if (showTabSwitcher || isContactsPage || isChatPage) return;
    if (walletTab !== "wallet") {
      setWalletTab("wallet");
    }
  }, [isChatPage, isContactsPage, showTabSwitcher, walletTab]);
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
    preferredFileServer,
    nostrPoolRef, nostrPoolClosingRef, nostrSubscriptionActiveRef, nostrIdentityRef,
    nostrIdentityInfo, setNostrIdentityInfo,
    peanutSendToken,
    ensureNostrPool, closeNostrPool,
    isReplaceableRejection, safePublish,
    resetSendLockSettings,
    readNostrIdentity, readProfileEventId, persistProfileEventId,
    ensureNostrIdentity,
    fingerprintIncomingToken,
    rebuildSpentFingerprints, addSpentIncomingPayment, isIncomingPaymentSpent,
    decryptNostrPaymentMessage, parseIncomingPaymentMessage,
    resolvePeerPubkey, stopDmSubscription, refreshNostrIdentity,
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
  const DM_SYNC_LOOKBACK_SECONDS = 30 * 24 * 60 * 60; // 30 days of NIP-17/DM history

  const [recvMsg, setRecvMsg] = useState("");

  const {
    contacts, setContacts,
    contactsOpen, setContactsOpen,
    nip05Checks, setNip05Checks,
    ensureNip05VerificationRef, isNip05VerifiedForRef,
    contactsRef, skipContactsEventRef, skipContactsTimerRef,
    contactsTabOpen, setContactsTabOpen,
    contactsPanelRef,
    contactSyncState, setContactSyncState,
    contactsPublishState, setContactsPublishState,
    setContactsPublishMessage,
    contactSyncMetaRef, contactSyncMeta, setContactSyncMeta,
    persistContactSyncMeta,
    profileForm, setProfileForm,
    profileSharePayload, setProfileSharePayload,
    profileEventIdRef, profileFormRef,
    profileStatus, setProfileStatus,
    profileMessage, setProfileMessage,
    profileUpdatedAt, setProfileUpdatedAt,
    profileEditorOpen, setProfileEditorOpen,
    contactLookupInput, setContactLookupInput,
    contactLookupBusy, setContactLookupBusy,
    contactLookupError, setContactLookupError,
    showCustomContactFields, setShowCustomContactFields,
    contactView, setContactView,
    activeContactId, setActiveContactId,
    contactReturnView, setContactReturnView,
    contactDetailOverride, setContactDetailOverride,
    shareContactPickerOpen, setShareContactPickerOpen,
    shareContactPickerMode, setShareContactPickerMode,
    shareContactSource, setShareContactSource,
    shareContactStatus, setShareContactStatus,
    shareContactBusy, setShareContactBusy,
    shareContactOpenedAtPeerRef,
    contactEditDraft, setContactEditDraft,
    contactEditError, setContactEditError,
    profilePhotoError, setProfilePhotoError,
    profilePhotoBusy, setProfilePhotoBusy,
    profilePhotoInputRef, profilePhotoUploadRef,
    publicFollowPickerOpen, setPublicFollowPickerOpen,
    resetContactEditDraft, closeContactsTab,
    handleStartAddContact, handleBackToContactsList, handleReturnToProfileCard,
    contactsPublishQueuedRef, contactsContext, setContactsContext,
    contactsContextRef, contactsFingerprintRef,
    nip51MigrationInFlightRef, contactProfilesRefreshedRef,
    computeContactsFingerprint,
    upsertContact, compressedToRawHex, formatNpub, formatNpubDisplay,
  } = useContactsState({
    isChatPage,
    showTabSwitcher,
    isContactsPage,
    chatView,
    setChatView,
    setWalletTab,
    activeThreadPeer,
    persistProfileEventId,
  });
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
  const [solifeConfig, setSolifeConfig] = useState<any>(null);
  const [solifeCustomHandle, setSolifeCustomHandle] = useState("");
  const [solifeCustomStatus, setSolifeCustomStatus] = useState<"idle" | "loading" | "purchasing" | "success" | "error">("idle");
  const [solifeCustomMessage, setSolifeCustomMessage] = useState("");
  const [solifeCustomAddress, setSolifeCustomAddress] = useState("");
  const [solifeMintDraft, setSolifeMintDraft] = useState("");
  const [solifeMintUrl, setSolifeMintUrl] = useState("");
  const [solifeMintOverride, setSolifeMintOverride] = useState(false);
  const [solifeMintStatus, setSolifeMintStatus] = useState<"idle" | "loading" | "saving" | "success" | "error">("idle");
  const [solifeMintMessage, setSolifeMintMessage] = useState("");
  const deriveDefaultLightningAddress = useCallback(() => {
    if (!lightningAddressEnabled) return "";
    if (npubCashIdentity?.address) return npubCashIdentity.address;
    const storedSk = nostrSkSync();
    if (!storedSk) return "";
    try {
      const domain = solifeLightningAddressEnabled ? SOLIFE_LIGHTNING_ADDRESS_DOMAIN : "npub.cash";
      const identity = deriveNpubCashIdentity(storedSk, { domain });
      return identity.address;
    } catch {
      return "";
    }
  }, [lightningAddressEnabled, npubCashIdentity?.address, solifeLightningAddressEnabled]);
  const {
    readNip51ContactsMigrated,
    persistNip51ContactsMigrated,
    contactPubkeyKey,
    mergeContactsByPubkey,
    buildContactSyncEnvelopeFromNip51,
    loadLegacyContacts,
    migrateNip51ContactsIfNeeded,
    syncContactsFromNostr,
    publishContactsToNostr,
    applyContactProfileUpdates,
    refreshContactProfiles,
    publishProfileMetadata,
    loadProfileMetadata,
  } = useContactsSync({
    contactsSyncEnabled,
    walletDebugEnabled,
    nostrMissingReason,
    setContacts,
    contactsRef,
    contactSyncMetaRef,
    contactSyncMeta,
    setContactSyncState,
    contactsPublishQueuedRef,
    setContactsPublishState,
    setContactsPublishMessage,
    contactsFingerprintRef,
    nip51MigrationInFlightRef,
    computeContactsFingerprint,
    persistContactSyncMeta,
    compressedToRawHex,
    setProfileStatus,
    setProfileMessage,
    setProfileForm,
    setProfileSharePayload,
    setProfileUpdatedAt,
    profileEventIdRef,
    profileFormRef,
    formatNpub,
    setProfilePhotoError,
    ensureNostrIdentity,
    defaultNostrRelays,
    ensureNostrPool,
    safePublish,
    persistProfileEventId,
    readProfileEventId,
    deriveDefaultLightningAddress,
  });
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
    messageItemsByEventId,
    pendingMessageItemsByEventId,
    pendingCalendarInvitesByEventId,
    syntheticDmMessages,
    displayDmMessages,
    paymentHistoryByEventId,
  } = useDmMessageDerived({
    messageItems,
    inboxPendingItems,
    pendingCalendarInvites,
    dmDeletedEventsVersion,
    dmMessages,
    dmTempDeletedEventsVersion,
    formatCalendarInviteWhen,
    history,
    dmDeletedEventsRef,
    dmTempDeletedEventsRef,
  });
  const messageItemStatusRef = useRef<Map<string, WalletMessageItem["status"]>>(new Map());
  useEffect(() => {
    const seenIds = new Set<string>();
    messageItems.forEach((item) => {
      seenIds.add(item.id);
      const prevStatus = messageItemStatusRef.current.get(item.id);
      if (prevStatus === undefined) {
        messageItemStatusRef.current.set(item.id, item.status);
        return;
      }
      if (prevStatus !== item.status) {
        messageItemStatusRef.current.set(item.id, item.status);
        if (item.status === "accepted") {
          const label = getWalletMessageStatusLabel(item.type, item.status);
          if (label) {
            showToast(label);
          }
        }
      }
    });
    messageItemStatusRef.current.forEach((_, key) => {
      if (!seenIds.has(key)) {
        messageItemStatusRef.current.delete(key);
      }
    });
  }, [messageItems, showToast]);
  const { ensurePeerProfile, getPeerProfile, handleDmEvent, startDmSubscription } = useDmSubscription({
    compressedToRawHex,
    contactsRef,
    ensureNip05VerificationRef,
    dmPeerProfilesRef,
    dmPeerProfileLoadingRef,
    setDmPeerProfilesVersion,
    dmDeletedEventsRef,
    dmTempDeletedEventsRef,
    persistTempDeletedDmEvents,
    setDmTempDeletedEventsVersion,
    dmProcessedEventsRef,
    dmSubscriptionCloseRef,
    dmLastSyncRef,
    persistDmSyncMeta,
    dmBlockedPeersRef,
    messageItemsRef,
    setDmMessages,
    setDmReactions,
    groupChatsRef,
    upsertGroupChat,
    decryptNostrPaymentMessage,
    parseIncomingPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
    ensureNostrIdentity,
    defaultNostrRelays,
    handlePaymentRequestEventRef,
    DM_SYNC_LOOKBACK_SECONDS,
    persistDmPeerProfileCache,
    contactDisplayLabel,
  });
  const {
    resolveNip17Timestamp,
    resolveNip17Relays,
    publishNip17Giftwraps,
    handleSendReaction,
    handleForwardMessage,
    publishGroupSubjectUpdate,
    resolveMessengerServerEntry,
    sendMessengerFileAttachments,
  } = useDmSend({
    nip17TimestampMode,
    walletDebugEnabled,
    defaultNostrRelays,
    ensureNostrPool,
    safePublish,
    readNostrIdentity,
    handleDmEvent,
    setDmReactions,
    setDmMessageActions,
    groupChatsRef,
    setPendingMessages,
    fileStorageServer,
    fileServers,
    encryptedFileStorageServer,
    encryptedFileServers,
    showToast,
  });
  const contactIndex = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        picture?: string;
      }
    >();
    contacts.forEach((contact) => {
      const normalized = normalizeNostrPubkey(contact.npub || "");
      if (!normalized) return;
      const compressed = normalized.toLowerCase();
      const raw = compressedToRawHex(normalized).toLowerCase();
      const entry = {
        name: contactDisplayLabel(contact),
        picture: contact.picture?.trim() || undefined,
      };
      map.set(compressed, entry);
      map.set(raw, entry);
    });
    return map;
  }, [compressedToRawHex, contacts, normalizeNostrPubkey]);
  const {
    isUnreadThreadStatus,
    collectUnreadThreadItemEventIds,
    dmPreviewForMessage,
    peerLabelFor,
    sharedContactMetaFor,
    buildSharedContactPreview,
    openSharedContactPreview,
    isArchivedDmThread,
    matchesDmThreadSearch,
    openConversationForPeer,
    openConversationForGroup,
    buildShareRelayList,
    sendContactShareToPubkeys,
    handleShareContactToContact,
    closeAttachTray,
    handleToggleAttachTray,
    handleOpenChatPhotoPicker,
    handleOpenChatFilePicker,
    handleOpenChatContactPicker,
  } = useDmThreadUtils({
    inboxPendingItems,
    messageItemsByEventId,
    pendingMessageItemsByEventId,
    pendingCalendarInvitesByEventId,
    pendingCalendarInvites,
    paymentHistoryByEventId,
    contactIndex,
    dmArchivedThreadsVersion,
    groupChats,
    dmSearch,
    displayDmMessages,
    activeThreadPeer,
    shareContactSource,
    profileForm,
    setSharedContactPreview,
    setActiveThreadPeer,
    setDmView,
    setChatView,
    setContactView,
    setActiveContactId,
    setContactDetailOverride,
    setContactReturnView,
    setDmSearch,
    setDmMessages,
    setActiveGroupId,
    setAttachTrayOpen,
    setShareContactPickerOpen,
    setShareContactPickerMode,
    setShareContactSource,
    setShareContactStatus,
    setShareContactBusy,
    dmArchivedThreadsRef,
    dmPeerProfilesRef,
    nostrIdentityRef,
    groupChatsRef,
    isNip05VerifiedForRef,
    chatComposeInputRef,
    chatPhotoInputRef,
    chatFileInputRef,
    shareContactOpenedAtPeerRef,
    normalizeNostrPubkey,
    compressedToRawHex,
    formatNpubDisplay,
    shortenNpubDisplay,
    pickPreferredProfilePhoto,
    makeContactId,
    normalizeContact,
    dmThreadKeyForThread,
    formatContactNpub,
    formatNpub,
    buildContactShareEnvelope,
    sendShareMessage,
    readNostrIdentity,
    defaultNostrRelays,
    buildWalletMessageSyntheticEventId,
    buildCalendarInviteSyntheticEventId,
    normalizeDmPeerHex,
    showToast,
    LS_NOSTR_RELAYS,
    kvStorage,
  });
  useEffect(() => {
    if (!displayDmMessages.length) return;
    const targets = new Set<string>();
    displayDmMessages.forEach((msg) => {
      if (msg.peerPubkey) {
        const normalized = normalizeNostrPubkey(msg.peerPubkey);
        if (normalized) targets.add(normalized);
      }
      if (msg.attachment?.type === "contact" && msg.attachment.npub) {
        const normalized = normalizeNostrPubkey(msg.attachment.npub);
        if (normalized) targets.add(normalized);
      }
    });
    targets.forEach((pubkey) => {
      void ensurePeerProfile(pubkey);
    });
  }, [displayDmMessages, ensurePeerProfile]);
  const {
    dmThreads,
    activeThread,
    activeGroupChat,
    visibleDmThreads,
    contactByHex,
    strangerThreads,
    dmThreadListEntries,
    messageSearchResults,
    activeThreadPendingMessages,
  } = useDmThreadDerived({
    displayDmMessages,
    contactIndex,
    dmPreviewForMessage,
    isArchivedDmThread,
    matchesDmThreadSearch,
    nostrIdentityInfo,
    nostrIdentityRef,
    activeThreadPeer,
    groupChats,
    dmSearch,
    dmView,
    visiblePendingMessages,
    contacts,
    contactsContext,
    shareContactSource,
    compressedToRawHex,
    normalizeNostrPubkey,
  });
  useEffect(() => {
    if (!dmArchivedThreadsRef.current.size) return;
    const next = new Map(dmArchivedThreadsRef.current);
    let changed = false;
    dmThreads.forEach((thread) => {
      const key = dmThreadKeyForThread(thread);
      if (!key) return;
      const archivedAt = next.get(key) ?? 0;
      if (archivedAt <= 0) return;
      const hasNewerMessage = thread.messages.some(
        (message) => !message.eventId.startsWith("draft-") && message.createdAt * 1000 > archivedAt,
      );
      if (hasNewerMessage) {
        next.delete(key);
        changed = true;
      }
    });
    if (!changed) return;
    dmArchivedThreadsRef.current = next;
    persistArchivedDmThreads(next);
    setDmArchivedThreadsVersion((value) => value + 1);
  }, [dmThreads, persistArchivedDmThreads]);
  const activeGroupMuted = !!(activeGroupChat && dmMutedGroupsRef.current.has(activeGroupChat.groupId.toLowerCase()));
  const activeGroupLeft = !!(activeGroupChat && dmLeftGroupsRef.current.has(activeGroupChat.groupId.toLowerCase()));
  useEffect(() => {
    if (!open || !isChatPage || chatView !== "conversation" || !activeThread) {
      dmAutoScrollStateRef.current = { threadPeer: activeThread?.peerPubkey ?? null, itemCount: 0 };
      return;
    }
    const nextState = {
      threadPeer: activeThread.peerPubkey,
      itemCount: activeThread.messages.length + activeThreadPendingMessages.length,
    };
    const prevState = dmAutoScrollStateRef.current;
    const threadChanged = prevState.threadPeer !== nextState.threadPeer;
    const grew = nextState.itemCount > prevState.itemCount;
    dmAutoScrollStateRef.current = nextState;
    if (!threadChanged && !grew) return;
    // Skip auto-scroll-to-bottom when we are about to scroll to a specific message
    if (threadChanged && scrollToMessageIdRef.current) return;
    const scroller = messagesScrollRef.current;
    if (!scroller) return;
    const behavior: ScrollBehavior = threadChanged ? "auto" : "smooth";
    if (threadChanged) {
      // Double rAF: first frame lets React flush the new messages into the DOM,
      // second frame fires after the browser has done layout so scrollHeight is final.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior });
        });
      });
    } else {
      requestAnimationFrame(() => {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      });
    }
  }, [activeThread, activeThreadPendingMessages.length, chatView, isChatPage, open]);
  useEffect(() => {
    if (!scrollToMessageId || chatView !== "conversation") return;
    scrollToMessageIdRef.current = scrollToMessageId;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = messagesScrollRef.current;
        const el = scroller?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(scrollToMessageId)}"]`);
        if (el && scroller) {
          // Scroll within the container (not viewport) to avoid breaking the fixed compose bar
          const scrollerRect = scroller.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          const targetTop = scroller.scrollTop + elRect.top - scrollerRect.top - scroller.clientHeight / 2 + elRect.height / 2;
          scroller.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
          el.classList.add("chat-message--highlight");
          setTimeout(() => el.classList.remove("chat-message--highlight"), 2000);
        }
        scrollToMessageIdRef.current = null;
        setScrollToMessageId(null);
      });
    });
  }, [scrollToMessageId, chatView, activeThread]);
  useEffect(() => {
    if (dmView !== "thread" || activeThread) return;
    setDmView(dmListViewRef.current);
    setActiveThreadPeer(null);
    setActiveGroupId(null);
    if (isChatPage && (chatView === "conversation" || chatView === "group-info" || chatView === "group-members" || chatView === "group-name-edit")) {
      setChatView("threads");
    }
  }, [activeThread, chatView, dmView, isChatPage]);
  useEffect(() => {
    if (activeGroupChat) return;
    setRenameGroupBusy(false);
    setRenameGroupDraft("");
    setGroupMembersSearch("");
    if (chatView === "group-info" || chatView === "group-members" || chatView === "group-name-edit") {
      setChatView(activeThread ? "conversation" : "threads");
    }
  }, [activeGroupChat, activeThread, chatView]);
  const {
    persistMutedGroups,
    persistLeftGroups,
    setGroupMutedState,
    setGroupLeftState,
    markThreadReadThrough,
    closeThreadIfActive,
    clearArchivedDmThread,
    handleArchiveDmThread,
    handleDeleteDmThread,
    openActiveGroupInfo,
    handleToggleActiveGroupMute,
    handleToggleActiveGroupMembership,
    toggleBlockPeer,
    handleAddPeerToContacts,
  } = useDmThreadActions({
    dmMutedGroupsRef,
    setDmMutedGroupsVersion,
    dmLeftGroupsRef,
    setDmLeftGroupsVersion,
    dmThreadReadAtRef,
    persistDmThreadReadState,
    setDmThreadReadAtVersion,
    dmArchivedThreadsRef,
    persistArchivedDmThreads,
    setDmArchivedThreadsVersion,
    dmTempDeletedEventsRef,
    persistTempDeletedDmEvents,
    setDmTempDeletedEventsVersion,
    dmProcessedEventsRef,
    dmBlockedPeersRef,
    persistBlockedPeers,
    setDmBlockedPeersVersion,
    setDmMessageActions,
    setDmExpandedMessages,
    setDmMessages,
    setPendingMessages,
    cancelDmLongPress,
    persistGroupStateSet,
    activeThreadPeer,
    isChatPage,
    setActiveThreadPeer,
    setActiveGroupId,
    setDmView,
    dmListViewRef,
    setChatView,
    activeGroupChat,
    activeThread,
    setRenameGroupDraft,
    setGroupMembersSearch,
    setGroupInfoTab,
    setAttachTrayOpen,
    setShareContactPickerMode,
    setShareContactSource,
    setShareContactStatus,
    setChatCompose,
    setShareContactPickerOpen,
    upsertContact,
    getPeerProfile,
    peerLabelFor,
    formatNpub,
    collectUnreadThreadItemEventIds,
    onMarkMessagesRead,
    showToast,
  });
  const {
    threadUnreadMap,
    strangerUnreadCount,
    mainUnreadCount,
  } = useThreadUnreadCounts({
    dmThreads,
    messageItemsByEventId,
    pendingMessageItemsByEventId,
    pendingCalendarInvitesByEventId,
    isUnreadThreadStatus,
    dmMutedGroupsRef,
    dmLeftGroupsRef,
    dmThreadReadAtRef,
    dmMutedGroupsVersion,
    dmLeftGroupsVersion,
    dmThreadReadAtVersion,
    strangerThreads,
    visibleDmThreads,
  });
  useEffect(() => {
    onDmUnreadCountChange?.(mainUnreadCount);
  }, [mainUnreadCount, onDmUnreadCountChange]);
  const activeThreadBlocked = activeThread
    ? dmBlockedPeersRef.current.has(activeThread.peerPubkey.toLowerCase())
    : false;
  useEffect(() => {
    if (!activeThread) return;
    const latestIncomingCreatedAt = activeThread.messages.reduce((latest, message) => {
      if (!message.isIncoming || message.eventId.startsWith("draft-")) return latest;
      return Math.max(latest, message.createdAt);
    }, 0);
    if (latestIncomingCreatedAt > 0) {
      markThreadReadThrough(activeThread.peerPubkey, latestIncomingCreatedAt);
    }
    const unreadIds = collectUnreadThreadItemEventIds(activeThread.messages, activeThread.peerPubkey);
    if (unreadIds.length) {
      onMarkMessagesRead(unreadIds);
    }
  }, [activeThread, collectUnreadThreadItemEventIds, markThreadReadThrough, onMarkMessagesRead]);
  const {
    sortedContacts,
    visibleContacts,
    shareRecipientOptions,
    publicFollowOptions,
    lightningContactCount,
  } = useContactsDerived({
    contacts,
    contactsContext,
    shareContactSource,
    compressedToRawHex,
    normalizeNostrPubkey,
    contactSyncMeta,
    formatNpub,
  });
  const {
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
  } = useContactPaymentActions({
    mintUrl,
    info,
    activeThread,
    activeGroupChat,
    renameGroupDraft,
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
  const contactsPanelContent = (context: "lightning" | "ecash") => {
    if (contactsContext !== context) return null;
    const hasContacts = visibleContacts.length > 0;
    const contactPanelHeight = CONTACT_PANEL_HEIGHT;
    return (
      <div
        className="flex flex-col gap-3 text-xs"
        style={{ minHeight: contactPanelHeight, maxHeight: contactPanelHeight }}
      >
        <div className="contacts-list-view flex-1 min-h-0">
          {hasContacts ? (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="contact-list">
                {visibleContacts.map((contact) => {
                  const displayName = contactDisplayLabel(contact);
                  const displayNameTrimmed = truncateContactName(displayName);
                  const subtitle = contactSubtitle(contact) || "No details added";
                  const subtitleIsNip05 =
                    !!contact.nip05 &&
                    !!subtitle &&
                    normalizeNip05(contact.nip05) === normalizeNip05(subtitle);
                  const nip05Verified =
                    subtitleIsNip05 &&
                    isNip05VerifiedForRef.current?.(contact.id, contact.nip05, contact.npub);
                  const photo = contact.picture?.trim();
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      onClick={() => handleSelectContact(contact)}
                    >
                      <div className={photo ? "contact-avatar contact-avatar--image" : "contact-avatar"}>
                        {photo ? (
                          <img src={photo} alt={displayName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(displayName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{displayNameTrimmed}</div>
                        <div
                          className={`contact-row__meta${subtitleIsNip05 ? " contact-row__meta--nip05" : ""}`}
                        >
                          <span className="contact-row__meta-text">{subtitle}</span>
                          {subtitleIsNip05 && nip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </div>
                      </div>
                      <span className="contact-chevron">›</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="contact-empty text-secondary">
              {context === "ecash"
                ? "Add a contact with an npub from the Contacts tab."
                : "Save a lightning address from the Contacts tab."}
            </div>
          )}
        </div>
      </div>
    );
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
    skipContactsEventRef.current = true;
    saveContactsToStorage(contacts);
    if (skipContactsTimerRef.current) {
      clearTimeout(skipContactsTimerRef.current);
    }
    skipContactsTimerRef.current = setTimeout(() => {
      skipContactsEventRef.current = false;
      skipContactsTimerRef.current = null;
    }, 0);
  }, [contacts]);

  useEffect(() => {
    if (!contactsOpen) {
      resetContactForm();
      setContactsContext(null);
      contactsContextRef.current = null;
    }
  }, [contactsOpen, resetContactForm]);

  const {
    parseNip05Address,
    normalizeNip05,
    resolveNip05Record,
    handleLookupContact,
    handleContactImportAction,
    handleImportPublicFollow,
    handleScannedContactPayload,
    handleDeleteContact,
    buildContactShareValue,
  } = useContactLookup({
    compressedToRawHex,
    contactLookupBusy,
    contactLookupInput,
    contactsPublishQueuedRef,
    defaultNostrRelays,
    ensureNostrPool,
    formatNpub,
    setActiveContactId,
    setContactLookupBusy,
    setContactLookupError,
    setContactLookupInput,
    setContactView,
    setContacts,
    setPublicFollowPickerOpen,
    setScannerMessage,
    setScannedContact,
    setShowScanner,
    upsertContact,
  });





  const profileShareValue = useMemo(() => {
    if (profileSharePayload) return profileSharePayload;
    // Read identity directly — not gated by paymentRequestsEnabled so new accounts
    // without payment requests still get a QR on their contact card.
    const identity = readNostrIdentity().identity ?? nostrIdentityRef.current;
    return identity ? formatNpub(identity.pubkey) : null;
  }, [formatNpub, profileSharePayload, readNostrIdentity]);
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
    if (!open || !solifeLightningAddressEnabled) return;
    let cancelled = false;
    const loadSolife = async () => {
      setSolifeCustomStatus((current) => (current === "purchasing" ? current : "loading"));
      setSolifeMintStatus((current) => (current === "saving" ? current : "loading"));
      try {
        const config = await fetchSolifeConfig();
        if (cancelled) return;
        setSolifeConfig(config);
        setSolifeMintUrl(config.mintUrl || "");
        setSolifeMintOverride(false);
        setSolifeCustomStatus((current) => (current === "purchasing" ? current : "idle"));
        const storedSk = nostrSkSync();
        if (!storedSk) {
          setSolifeMintStatus("idle");
          setSolifeMintMessage("");
          return;
        }
        const accountResult = await fetchSolifeAccount(storedSk);
        if (cancelled) return;
        setSolifeConfig(accountResult.config);
        setSolifeMintUrl(accountResult.account.lightningAddressMintUrl || accountResult.config.mintUrl || "");
        setSolifeMintOverride(accountResult.account.lightningAddressMintOverride === true);
        setSolifeMintDraft(
          accountResult.account.lightningAddressMintOverride ? accountResult.account.lightningAddressMintUrl || "" : "",
        );
        setSolifeMintStatus("idle");
        setSolifeMintMessage("");
      } catch (err: any) {
        if (cancelled) return;
        setSolifeCustomStatus((current) => (current === "purchasing" ? current : "error"));
        setSolifeCustomMessage(err?.message || "Unable to load Solife address pricing.");
        setSolifeMintStatus((current) => (current === "saving" ? current : "error"));
        setSolifeMintMessage(err?.message || "Unable to load Solife mint settings.");
      }
    };
    void loadSolife();
    return () => {
      cancelled = true;
    };
  }, [open, solifeLightningAddressEnabled]);

  const handlePurchaseSolifeCustomAddress = useCallback(async () => {
    if (!solifeLightningAddressEnabled) return;
    const handle = solifeCustomHandle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
      setSolifeCustomStatus("error");
      setSolifeCustomMessage("Handle must be 2-32 characters using lowercase letters, numbers, _ or -.");
      return;
    }
    const storedSk = nostrSkSync();
    if (!storedSk) {
      setSolifeCustomStatus("error");
      setSolifeCustomMessage("Add your Taskify Nostr key in Settings → Nostr before claiming a Solife address.");
      return;
    }

    setSolifeCustomStatus("purchasing");
    setSolifeCustomMessage("Checking Solife address pricing...");
    setSolifeCustomAddress("");

    let createdFeeToken = "";
    let createdFeeTokenMint = "";
    let createdFeeTokenProofs: Proof[] = [];

    try {
      const config = solifeConfig || (await fetchSolifeConfig());
      setSolifeConfig(config);
      const feeSats = Math.max(0, Math.floor(Number(config.customAddressPriceSats) || 0));

      if (feeSats > 0) {
        const paymentMint = config.mintUrl;
        setSolifeCustomMessage(`Creating ${formatSatAmount(feeSats)} fee token from ${paymentMint}...`);
        const tokenResult = await createSendToken(feeSats, { mintUrl: paymentMint });
        createdFeeToken = tokenResult.token;
        createdFeeTokenMint = tokenResult.mintUrl;
        createdFeeTokenProofs = tokenResult.proofs || [];
        setHistory((history) => [
          buildHistoryEntry({
            id: `solife-custom-fee-${Date.now()}`,
            summary: `Solife address fee for ${handle}@${SOLIFE_LIGHTNING_ADDRESS_DOMAIN}`,
            detail: createdFeeToken,
            detailKind: "token",
            revertToken: createdFeeToken,
            type: "ecash",
            direction: "out",
            amountSat: feeSats,
            mintUrl: createdFeeTokenMint,
            tokenState: createdFeeTokenProofs.length
              ? {
                  mintUrl: createdFeeTokenMint,
                  proofs: createdFeeTokenProofs.map((proof) => {
                    const stored: StoredProofForState = {
                      secret: proof.secret,
                      amount: proof.amount,
                      id: proof.id,
                      C: proof.C,
                    };
                    if (proof.witness) stored.witness = proof.witness;
                    const y = computeProofY(proof.secret);
                    if (y) stored.y = y;
                    return stored;
                  }),
                }
              : undefined,
          }),
          ...history,
        ]);
      }

      setSolifeCustomMessage(`Claiming ${handle}@${SOLIFE_LIGHTNING_ADDRESS_DOMAIN}...`);
      const result = await claimSolifeCustomAddress(storedSk, {
        handle,
        token: createdFeeToken,
        relays: defaultNostrRelays,
      });
      setSolifeCustomAddress(result.address.address);
      setSolifeCustomHandle("");
      setSolifeCustomStatus("success");
      setSolifeCustomMessage(`Claimed ${result.address.address}`);
      showToast(`claimed ${result.address.address}`, 3000);
    } catch (err: any) {
      setSolifeCustomStatus("error");
      const tokenNote = createdFeeToken
        ? " The fee token was saved to wallet history in case you need to redeem it back."
        : "";
      setSolifeCustomMessage(`${err?.message || "Unable to claim Solife address."}${tokenNote}`);
    }
  }, [
    buildHistoryEntry,
    createSendToken,
    defaultNostrRelays,
    setHistory,
    showToast,
    solifeConfig,
    solifeCustomHandle,
    solifeLightningAddressEnabled,
  ]);

  const handleSaveSolifeMint = useCallback(
    async (useDefault = false) => {
      if (!solifeLightningAddressEnabled) return;
      const storedSk = nostrSkSync();
      if (!storedSk) {
        setSolifeMintStatus("error");
        setSolifeMintMessage("Add your Taskify Nostr key in Settings → Nostr before changing your Solife mint.");
        return;
      }
      const nextMintUrl = useDefault ? null : solifeMintDraft.trim() || null;
      setSolifeMintStatus("saving");
      setSolifeMintMessage(useDefault ? "Resetting to Solife default mint..." : "Saving Solife mint...");
      try {
        const result = await updateSolifeLightningAddressMint(storedSk, nextMintUrl);
        setSolifeConfig(result.config);
        setSolifeMintUrl(result.mintUrl);
        setSolifeMintOverride(result.mintOverride);
        setSolifeMintDraft(result.mintOverride ? result.mintUrl : "");
        setSolifeMintStatus("success");
        setSolifeMintMessage(
          result.mintOverride ? `Using ${result.mintUrl} for your Solife address.` : "Using the Solife default mint.",
        );
        showToast("Solife mint updated", 2500);
      } catch (err: any) {
        setSolifeMintStatus("error");
        setSolifeMintMessage(err?.message || "Unable to update your Solife mint.");
      }
    },
    [showToast, solifeLightningAddressEnabled, solifeMintDraft],
  );

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
    const storedSk = nostrSkSync();
    const providerDomain = solifeLightningAddressEnabled ? SOLIFE_LIGHTNING_ADDRESS_DOMAIN : "npub.cash";
    if (!storedSk) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(`Add your Taskify Nostr key in Settings → Nostr to use ${providerDomain}.`);
      return;
    }
    try {
      const identity = deriveNpubCashIdentity(storedSk, { domain: providerDomain });
      setNpubCashIdentity({ npub: identity.npub, address: identity.address });
      setNpubCashIdentityError(null);
    } catch (err: any) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(err?.message || `Unable to derive ${providerDomain} address.`);
    }
  }, [lightningAddressEnabled, open, solifeLightningAddressEnabled]);

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
    totalBalance,
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

  const contentClass = useMemo(
    () => `wallet-modal__content${walletTab === "wallet" ? " wallet-modal__content--home" : ""}`,
    [walletTab],
  );




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

  useEffect(() => {
    if (!contactsSyncEnabled) {
      contactsPublishQueuedRef.current = false;
      return;
    }
    const fingerprint = computeContactsFingerprint(contacts);
    contactsFingerprintRef.current = fingerprint;
    if (!contacts.length && !contactSyncMeta.fingerprint) {
      contactsPublishQueuedRef.current = false;
      return;
    }
    if (contactSyncMeta.fingerprint && contactSyncMeta.fingerprint === fingerprint) {
      if (contactsPublishState !== "publishing") {
        contactsPublishQueuedRef.current = false;
      }
      return;
    }
    contactsPublishQueuedRef.current = true;
  }, [computeContactsFingerprint, contactSyncMeta.fingerprint, contacts, contactsPublishState, contactsSyncEnabled]);

  useEffect(() => {
    if (!contactsSyncEnabled) return;
    if (nostrMissingReason) return;
    void migrateNip51ContactsIfNeeded({ silent: true });
  }, [contactsSyncEnabled, nostrMissingReason, migrateNip51ContactsIfNeeded]);

  useEffect(() => {
    if (!contactsSyncEnabled) return;
    if (!contactsPublishQueuedRef.current) return;
    const timer = window.setTimeout(() => {
      if (contactsPublishQueuedRef.current) {
        void publishContactsToNostr({ silent: true });
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [contactsSyncEnabled, contacts, contactSyncMeta.fingerprint, publishContactsToNostr]);

  useEffect(() => {
    if (!contactsTabOpen && !contactsOpen && !chatModeUsesContacts) {
      contactProfilesRefreshedRef.current = false;
      return;
    }
    if (!contactProfilesRefreshedRef.current) {
      contactProfilesRefreshedRef.current = true;
      void refreshContactProfiles();
      if (contactsSyncEnabled) {
        void loadProfileMetadata();
        void syncContactsFromNostr({ silent: true });
      }
    }
  }, [chatModeUsesContacts, contactsOpen, contactsSyncEnabled, contactsTabOpen, loadProfileMetadata, refreshContactProfiles, syncContactsFromNostr]);

  useEffect(() => {
    if (contactsTabOpen) return;
    setContactView("list");
    setActiveContactId(null);
    resetContactEditDraft();
    setContactEditError("");
    setContactLookupError("");
    setContactLookupInput("");
    setPublicFollowPickerOpen(false);
  }, [contactsTabOpen, resetContactEditDraft]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (contactView !== "detail") return;
    if (activeContactId && activeContactId !== "profile") {
      const exists = contacts.some((entry) => entry.id === activeContactId);
      if (!exists) {
        setContactView("list");
        setActiveContactId(null);
      }
    }
  }, [activeContactId, contactView, contacts, contactsTabOpen]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (contactView !== "detail") return;
    const panelEl = contactsPanelRef.current?.closest(".sheet-panel") as HTMLElement | null;
    panelEl?.scrollTo({ top: 0 });
  }, [activeContactId, contactView, contactsTabOpen]);

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

  useEffect(() => {
    void startDmSubscription();
    return () => {
      stopDmSubscription();
    };
  }, [startDmSubscription, stopDmSubscription]);

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
    totalBalance,
    pendingBalance,
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
          const interpretation = interpretEcashInput(pendingScan.token);
          if (interpretation.kind !== "token") {
            showToast("Unrecognized eCash token.", 3500);
            break;
          }
          try {
            await redeemEcashToken(interpretation.value);
          } catch (err: any) {
            showToast(err?.message || "Unable to redeem scanned eCash token.", 4000);
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
        default:
          closeCamera();
          break;
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
        const paymentResult = await payMintInvoice(paymentRequest);
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
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
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
        const paymentResult = await payMintInvoice(invoice.pr);
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
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
        setLnurlPayData(null);
      } else if (isBolt11Input) {
        const paymentResult = await payMintInvoice(normalized);
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
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
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

  const myCardUsername = formatContactUsername(profileForm.username);
  const myCardName = profileForm.displayName.trim() || myCardUsername || "My Card";
  const myCardLightning = profileForm.lud16.trim() || deriveDefaultLightningAddress();
  const myCardNpub = useMemo(() => {
    const identity = readNostrIdentity().identity ?? nostrIdentityRef.current;
    return identity ? formatNpub(identity.pubkey) : "";
  }, [formatNpub, readNostrIdentity, profileSharePayload]);
  const myCardSubtitle =
    myCardLightning || profileForm.nip05.trim() || myCardNpub || "My Card";
  const profileCard = {
    id: "profile",
    kind: myCardNpub ? ("nostr" as const) : ("custom" as const),
    name: myCardName,
    displayName: profileForm.displayName.trim(),
    username: sanitizeUsername(profileForm.username),
    address: myCardLightning,
    paymentRequest: "",
    npub: myCardNpub,
    nip05: profileForm.nip05.trim(),
    about: profileForm.about.trim(),
    picture: profileForm.picture.trim(),
    updatedAt: profileUpdatedAt,
  };
  const {
    activeConversationContact,
    chatAttachTrayHeight,
    chatAttachContactOptions,
    activeGroupAvatarMembers,
    activeGroupMembers,
    filteredActiveGroupMembers,
    groupAvatarMembersFor,
  } = useChatGroupDerived({
    activeThread,
    activeGroupChat,
    contactByHex,
    sortedContacts,
    myCardNpub,
    myCardName,
    profileCard,
    groupMembersSearch,
    chatKeyboardHeight,
    chatKeyboardHeightCache,
    nostrIdentityInfo,
    nostrIdentityRef,
    dmPeerProfilesRef,
    getPeerProfile,
    peerLabelFor,
    compressedToRawHex,
    normalizeNostrPubkey,
    formatNpub,
    sanitizeUsername,
    contactDisplayLabel,
    formatContactUsername,
    formatContactNpub,
    pickPreferredProfilePhoto,
    shortenNpubDisplay,
    profileUpdatedAt,
  });
  const {
    activeContact,
    detailTarget,
    sharedContactPreviewContact,
    scannedContactSaved,
    scannedContactFollowed,
    sharedContactPreviewSaved,
    sharedContactPreviewCanAccept,
    detailContactFollowed,
    contactSubtitle,
    handleOpenChatEcash,
    handleOpenChatLightning,
    openGroupMemberDetail,
    buildContactFields,
    verifyContactNip05,
    ensureNip05Verification,
    isNip05VerifiedFor,
    handleSaveScannedContact,
    handleSaveSharedContactPreview,
    handleToggleFollowScannedContact,
    handleStartEditCurrentContact,
    handleCancelContactEdit,
    handleToggleFollowDetailContact,
    handleCopyContactField,
    processProfilePhotoFile,
    handleProfilePhotoChange,
    handleClearProfilePhoto,
    handleContactEditSubmit,
  } = useContactDetail({
    nip05Checks,
    contacts,
    contactsRef,
    contactSyncMeta,
    contactsSyncEnabled,
    scannedContact,
    sharedContactPreview,
    contactDetailOverride,
    activeContactId,
    contactEditDraft,
    profileForm,
    profileUpdatedAt,
    nostrIdentityInfo,
    myCardName,
    profileCard,
    activeGroupMembers,
    activeConversationContact,
    nostrMissingReason,
    preferredFileServer,
    fileServers,
    profilePhotoBusy,
    nostrIdentityRef,
    contactsPublishQueuedRef,
    profilePhotoUploadRef,
    setNip05Checks,
    setScannedContact,
    setSharedContactPreview,
    setContactDetailOverride,
    setActiveContactId,
    setContactEditDraft,
    setContactReturnView,
    setContactView,
    setDmSearch,
    setChatView,
    setContactEditError,
    setContactLookupError,
    setContactLookupInput,
    setShowCustomContactFields,
    setProfilePhotoError,
    setProfilePhotoBusy,
    setProfileStatus,
    setProfileMessage,
    setProfileForm,
    normalizeNip05,
    normalizeNostrPubkey,
    compressedToRawHex,
    resolveNip05Record,
    upsertContact,
    publishContactsToNostr,
    persistContactSyncMeta,
    sanitizeUsername,
    formatContactNpub,
    formatContactUsername,
    showToast,
    peerLabelFor,
    openEcashSendToContact,
    openEcashSendSheet,
    openLightningSendSheet,
    applyLightningContact,
    closeAttachTray,
    onAcceptMessage,
    handleReturnToProfileCard,
    resetContactEditDraft,
    ensureNostrIdentity,
    publishProfileMetadata,
    deriveDefaultLightningAddress,
    isDataUrl,
    estimateDataUrlSize,
  });
  const detailShareValue =
    activeContactId === "profile"
      ? profileShareValue
      : detailTarget
        ? buildContactShareValue(detailTarget as Contact)
        : null;
  const detailUsername = detailTarget ? formatContactUsername(detailTarget.username) : "";
  const detailFields = buildContactFields(detailTarget);
  const detailHasLightning = activeContact ? contactHasLightning(activeContact) : false;
  const detailCanShare = activeContact ? contactHasNpub(activeContact) : false;

  useEffect(() => {
    if (!detailTarget?.id) return;
    ensureNip05Verification(detailTarget.id, detailTarget.nip05, detailTarget.npub, detailTarget.updatedAt ?? null);
  }, [detailTarget, ensureNip05Verification]);

  useEffect(() => {
    ensureNip05VerificationRef.current = ensureNip05Verification;
  }, [ensureNip05Verification]);

  useEffect(() => {
    isNip05VerifiedForRef.current = isNip05VerifiedFor;
  }, [isNip05VerifiedFor]);

    const detailNip05Normalized = normalizeNip05(detailTarget?.nip05 ?? null);
    const detailNpubHex = detailTarget?.npub
      ? compressedToRawHex(normalizeNostrPubkey(detailTarget.npub) ?? detailTarget.npub).toLowerCase()
      : null;
    const detailNip05Verified =
      !!detailNip05Normalized &&
      !!detailNpubHex &&
      isNip05VerifiedFor(detailTarget?.id ?? "", detailTarget?.nip05, detailTarget?.npub);

    const scannedContactTitle = scannedContact ? contactPrimaryName(scannedContact) : "Contact";
    const scannedContactUsername = scannedContact ? formatContactUsername(scannedContact.username) : "";
    const scannedContactShareValue = scannedContact ? buildContactShareValue(scannedContact) : null;
    const scannedContactFields = buildContactFields(scannedContact);
    const scannedContactNip05Verified = scannedContact
      ? isNip05VerifiedFor(scannedContact.id, scannedContact.nip05, scannedContact.npub)
      : false;
    const scannedContactCanShare = !!scannedContact && contactHasNpub(scannedContact);
    useEffect(() => {
      if (!scannedContact?.id) return;
      ensureNip05Verification(
        scannedContact.id,
        scannedContact.nip05,
        scannedContact.npub,
        scannedContact.updatedAt ?? null,
      );
    }, [ensureNip05Verification, scannedContact]);
    const sharedContactPreviewTitle = sharedContactPreviewContact ? contactPrimaryName(sharedContactPreviewContact) : "Contact";
    const sharedContactPreviewUsername = sharedContactPreviewContact
      ? formatContactUsername(sharedContactPreviewContact.username)
      : "";
    const sharedContactPreviewShareValue = sharedContactPreviewContact
      ? buildContactShareValue(sharedContactPreviewContact)
      : null;
    const sharedContactPreviewFields = buildContactFields(sharedContactPreviewContact);
    const sharedContactPreviewNip05Verified = sharedContactPreviewContact
      ? isNip05VerifiedFor(
          sharedContactPreviewContact.id,
          sharedContactPreviewContact.nip05,
          sharedContactPreviewContact.npub,
        )
      : false;
    const scannedContactCanFollow = !!scannedContact && scannedContactSaved && !!scannedContact.npub.trim();
    const sharedContactPreviewCanShare =
      !!sharedContactPreviewContact && contactHasNpub(sharedContactPreviewContact);
    useEffect(() => {
      if (!sharedContactPreviewContact?.id) return;
      ensureNip05Verification(
        sharedContactPreviewContact.id,
        sharedContactPreviewContact.nip05,
        sharedContactPreviewContact.npub,
        sharedContactPreviewContact.updatedAt ?? null,
      );
    }, [ensureNip05Verification, sharedContactPreviewContact]);
    useEffect(() => {
      if (open && isChatPage && chatView === "conversation") return;
      setSharedContactPreview(null);
    }, [chatView, isChatPage, open]);


    const scannedContactHeader = scannedContact ? (
      <div className="contacts-sheet-header contacts-sheet-header--detail">
        <button
          className="glass-icon-button pressable"
          onClick={() => setScannedContact(null)}
          aria-label="Close contact"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
        <div className="contacts-header-spacer" aria-hidden="true" />
        {!scannedContactSaved ? (
          <button
            type="button"
            className="contact-pill contact-pill--accent contact-pill--compact contact-pill--wrap pressable"
            onClick={handleSaveScannedContact}
          >
            Add contact
          </button>
        ) : scannedContactCanFollow ? (
          <button
            type="button"
            className="contact-pill contact-pill--accent contact-pill--compact pressable"
            onClick={handleToggleFollowScannedContact}
          >
            {scannedContactFollowed ? "Unfollow" : "Follow"}
          </button>
        ) : (
          <div className="contacts-header-spacer" aria-hidden="true" />
        )}
      </div>
    ) : null;
    const sharedContactPreviewHeader = sharedContactPreview ? (
      <div className="contacts-sheet-header contacts-sheet-header--detail">
        <button
          className="glass-icon-button pressable"
          onClick={() => setSharedContactPreview(null)}
          aria-label="Close shared contact"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
        <div className="contacts-header-spacer" aria-hidden="true" />
        <button
          type="button"
          className="contact-pill contact-pill--accent contact-pill--compact contact-pill--wrap pressable"
          onClick={handleSaveSharedContactPreview}
          disabled={sharedContactPreviewSaved && !sharedContactPreviewCanAccept}
        >
          {sharedContactPreviewSaved && !sharedContactPreviewCanAccept ? "In contacts" : "Add to contacts"}
        </button>
      </div>
    ) : null;

  useEffect(() => {
    const candidates: { id: string; nip05: string; npub: string; updatedAt?: number | null }[] = [];
    const seen = new Set<string>();
    const addCandidate = (contact: Contact | typeof profileCard) => {
      if (!contact.id || !contact.nip05 || !contact.npub) return;
      const normalizedNip05 = normalizeNip05(contact.nip05);
      const normalizedNpub = normalizeNostrPubkey(contact.npub);
      if (!normalizedNip05 || !normalizedNpub) return;
      const key = `${contact.id}:${normalizedNip05}`;
      if (seen.has(key)) return;
      seen.add(key);
      const updatedAt = (contact as Contact).updatedAt ?? (contact === profileCard ? profileUpdatedAt : null);
      candidates.push({ id: contact.id, nip05: normalizedNip05, npub: normalizedNpub, updatedAt });
    };

    if (contactsTabOpen) {
      addCandidate(profileCard);
      sortedContacts.forEach(addCandidate);
    }

    if (contactsOpen && contactsContext) {
      visibleContacts.forEach(addCandidate);
    }

    candidates.forEach(({ id, nip05, npub, updatedAt }) => ensureNip05Verification(id, nip05, npub, updatedAt));
  }, [
    contactsContext,
    contactsOpen,
    contactsTabOpen,
    ensureNip05Verification,
    normalizeNip05,
    normalizeNostrPubkey,
    profileCard,
    profileUpdatedAt,
    sortedContacts,
    visibleContacts,
  ]);


    const detailTitle = detailTarget ? contactPrimaryName(detailTarget) : "Contact";
    const detailIsNostrContact = useMemo(() => {
      if (!detailTarget) return false;
      if (detailTarget.id === "profile" || (detailTarget as any).isProfile || detailTarget.kind === "custom") {
        return false;
      }
      const hasNpub = !!normalizeNostrPubkey(detailTarget.npub || "");
      const hasVerifiedNip05 = !!(
        detailTarget.nip05 &&
        isNip05VerifiedFor(detailTarget.id, detailTarget.nip05, detailTarget.npub)
      );
      return hasNpub || hasVerifiedNip05;
    }, [detailTarget, isNip05VerifiedFor, normalizeNostrPubkey]);
    const detailContactCanFollow = !!detailTarget && detailIsNostrContact && !!detailTarget.npub.trim();
    const detailCanAddContact = !!detailTarget && activeContactId !== "profile" && !activeContact;

    const profileHeaderPhoto = profileCard.picture?.trim();
    const contactsHeaderTitle =
      contactView === "edit"
        ? contactEditDraft.isProfile
          ? "Edit My Card"
          : contactEditDraft.id
            ? "Edit Contact"
            : "New Contact"
        : contactView === "detail"
          ? ""
          : isContactsPage
            ? ""
            : "Contacts";

    const contactsHeaderLeft =
      contactView === "list" && isContactsPage ? (
        <button
          type="button"
          className={`contact-avatar pressable${profileHeaderPhoto ? " contact-avatar--image contact-avatar--profile" : " contact-avatar--profile"}`}
          onClick={() => {
            setActiveContactId("profile");
            setContactView("detail");
          }}
          aria-label="Open profile"
          title="Open profile"
        >
          {profileHeaderPhoto ? (
            <img src={profileHeaderPhoto} alt={myCardName} className="contact-avatar__img" />
          ) : (
            contactInitials(myCardName)
          )}
        </button>
      ) : contactView === "list" ? (
        <button
          className="glass-icon-button pressable"
          onClick={closeContactsTab}
          aria-label="Close contacts"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      ) : contactView === "detail" ? (
        <button
          className="glass-icon-button pressable"
          onClick={handleBackToContactsList}
          aria-label={contactReturnView === "group-members" ? "Back to members" : contactReturnView === "group-info" ? "Back to group info" : "Back to contacts"}
        >
          <BackIcon className="h-5 w-5" />
        </button>
      ) : (
        <button
          className="glass-icon-button pressable"
          onClick={handleCancelContactEdit}
          aria-label="Cancel contact changes"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      );

    const contactsHeaderRight =
      contactView === "list" ? (
        <button
          type="button"
          className="glass-icon-button glass-icon-button--accent pressable"
          onClick={handleStartAddContact}
          title="Add contact"
          aria-label="Add contact"
        >
          <span className="text-xl leading-none">+</span>
        </button>
      ) : contactView === "detail" && detailTarget ? (
        detailCanAddContact ? (
          <button
            type="button"
            className="contact-pill contact-pill--accent contact-pill--compact pressable"
            onClick={handleStartEditCurrentContact}
          >
            Add contact
          </button>
        ) : detailIsNostrContact ? (
          detailContactCanFollow ? (
            <button
              type="button"
              className="contact-pill contact-pill--accent contact-pill--compact pressable"
              onClick={handleToggleFollowDetailContact}
            >
              {detailContactFollowed ? "Unfollow" : "Follow"}
            </button>
          ) : (
            <div className="contacts-header-spacer" aria-hidden="true" />
          )
        ) : (
          <button
            type="button"
            className="glass-icon-button glass-icon-button--accent pressable"
            onClick={handleStartEditCurrentContact}
            aria-label="Edit contact"
          >
            <PencilIcon className="h-4 w-4" />
          </button>
        )
      ) : contactView === "edit" ? (
        <button
          type="button"
          className="glass-icon-button glass-icon-button--accent pressable"
          aria-label="Save contact"
          onClick={() => {
            void handleContactEditSubmit();
          }}
          disabled={contactsPublishState === "publishing" || profileStatus === "publishing" || profilePhotoBusy}
        >
          <CheckIcon className="h-4 w-4" />
        </button>
      ) : (
        <div className="contacts-header-spacer" aria-hidden="true" />
      );

    const contactsHeader = (
      <div className="contacts-sheet-header contacts-sheet-header--detail">
        {contactsHeaderLeft}
        {contactsHeaderTitle ? (
          <div className="contacts-sheet-title">{contactsHeaderTitle}</div>
        ) : (
          <div className="contacts-header-spacer" aria-hidden="true" />
        )}
        {contactsHeaderRight}
      </div>
    );


  const inConversation = isChatPage && chatView === "conversation";
  const hideAppTabSwitcher = isChatPage && chatView !== "threads";
  const walletRootClass = `wallet-modal${showBottomNav && !hideAppTabSwitcher ? " wallet-modal--with-nav" : ""}${isContactsPage ? " wallet-modal--contacts" : ""}${isChatPage ? " wallet-modal--chat" : ""}${hideAppTabSwitcher ? " wallet-modal--app-nav-hidden" : ""}${inConversation ? " wallet-modal--chat-convo" : ""}`;
  const contactsPanelInline = !showTabSwitcher && isContactsPage;
  const contactsPanelOpen = contactsTabOpen || contactsPanelInline;
  const showWalletTabSwitcher = showTabSwitcher && !isContactsPage && !isChatPage;

  if (!open) return null;

  return (
    <div className={walletRootClass}>
      {!isContactsPage && !isChatPage && (
        <>
          <div className="wallet-modal__header">
            <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
            {walletTab !== "messages" && (
              <>
                <button
                  type="button"
                  className={unitButtonClass}
                  onClick={handleTogglePrimary}
                  aria-disabled={!canToggleCurrency}
                  title={canToggleCurrency ? "Toggle primary currency" : "Currency toggle available when conversion is enabled"}
                >
                  {unitLabel}
                </button>
                <button className="ghost-button button-sm pressable" onClick={()=>setShowHistory(true)}>History</button>
              </>
            )}
          </div>
          {walletTab !== "messages" && (
            <div className="wallet-modal__toolbar">
              <button className="ghost-button button-sm pressable" onClick={()=>setShowMintBalances(true)}>Mints</button>
              <button className="ghost-button button-sm pressable" onClick={()=>setShowNwcSheet(true)}>Swap</button>
              {onOpenBounties && (
                <button className="ghost-button button-sm pressable" onClick={onOpenBounties}>
                  Bounties
                </button>
              )}
            </div>
          )}
          <div className={contentClass}>
            {walletTab === "wallet" && (
              <>
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
              <div className="wallet-balance-card__amount">{primaryAmountDisplay}</div>
              {secondaryAmountDisplay && (
                <div className="wallet-balance-card__secondary">{secondaryAmountDisplay}</div>
              )}
              {(pendingBalanceDisplay || priceMeta) && (
                <div className="wallet-balance-card__meta space-y-1">
                  {pendingBalanceDisplay && <div>{pendingBalanceDisplay}</div>}
                  {priceMeta && <div>{priceMeta}</div>}
                </div>
              )}
            </button>
            <div className="wallet-modal__cta">
              <button className="accent-button pressable" onClick={openReceiveLightningSheet}>{"Receive"}</button>
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
              </>
            )}
            {walletTab === "messages" && (
              <div className="wallet-messages">
            <div className="wallet-messages__search">
              <div className="chat-page__search-shell">
                <input
                  className="wallet-messages__search-input"
                  placeholder="Search"
                  value={dmSearch}
                  onChange={(event) => setDmSearch(event.target.value)}
                />
                {dmSearch.length > 0 && (
                  <button
                    type="button"
                    className="chat-page__search-clear pressable"
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={() => setDmSearch("")}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className="wallet-messages__body">
              {(dmView === "list" || dmView === "strangers") && (
                <div className="wallet-messages__list space-y-2">
                  {dmView === "strangers" && !dmSearch.trim() && (
                    <button
                      className="wallet-messages__thread pressable"
                      onClick={() => {
                        dmListViewRef.current = "list";
                        setDmView("list");
                        setActiveThreadPeer(null);
                      }}
                    >
                      <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&larr;</div>
                      <div className="wallet-messages__thread-body">
                        <div className="wallet-messages__thread-title">Back to everyone</div>
                        <div className="wallet-messages__thread-preview">View all conversations</div>
                      </div>
                    </button>
                  )}
                  {dmThreadListEntries.map((entry) => {
                    if (entry.kind === "strangers") {
                      return (
                        <button
                          key="wallet-strangers-group"
                          className="wallet-messages__thread wallet-messages__thread--stranger pressable"
                          onClick={() => {
                            dmListViewRef.current = "strangers";
                            setDmView("strangers");
                            setActiveThreadPeer(null);
                          }}
                        >
                          <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&#9678;</div>
                          <div className="wallet-messages__thread-body">
                            <div className="wallet-messages__thread-title">
                              Strangers{strangerUnreadCount > 0 ? ` (${strangerUnreadCount})` : ""}
                            </div>
                            <div className="wallet-messages__thread-preview">{entry.lastPreview}</div>
                          </div>
                          <div className="wallet-messages__thread-meta">
                            <span className="wallet-messages__thread-date">
                              {formatShortDate(entry.lastCreatedAt)}
                            </span>
                            {strangerUnreadCount > 0 && (
                              <span className="chat-unread-badge">{strangerUnreadCount}</span>
                            )}
                          </div>
                        </button>
                      );
                    }
                    const thread = entry.thread;
                    const isGroupThread = !!thread.groupId;
                    const groupMeta = isGroupThread ? groupChats.find((g) => g.groupId === thread.groupId) : null;
                    const groupAvatarMembers = isGroupThread ? groupAvatarMembersFor(groupMeta, thread, groupMeta?.name || "Group") : [];
                    const meta = isGroupThread
                      ? { label: groupMeta?.name || "Group", picture: undefined, subtitle: `${groupMeta?.members.length || 0} members`, verifiedNip05: null }
                      : peerLabelFor(thread.peerPubkey);
                    const unreadCount = threadUnreadMap.get(thread.peerPubkey) || 0;
                    return (
                      <SwipeableDmThreadRow
                        key={thread.peerPubkey}
                        onArchive={() => handleArchiveDmThread(thread)}
                        onDelete={() => handleDeleteDmThread(thread)}
                      >
                        <button
                          className="wallet-messages__thread pressable"
                          onClick={() => {
                            dmListViewRef.current = dmView === "strangers" ? "strangers" : "list";
                            setActiveThreadPeer(thread.peerPubkey);
                            setDmView("thread");
                            const unreadIds = collectUnreadThreadItemEventIds(thread.messages, thread.peerPubkey);
                            if (unreadIds.length) {
                              onMarkMessagesRead(unreadIds);
                            }
                          }}
                        >
                          <div className={`wallet-messages__avatar${isGroupThread ? " wallet-messages__avatar--group" : ""}`}>
                            {isGroupThread ? (
                              <GroupAvatar members={groupAvatarMembers} />
                            ) : meta.picture ? (
                              <img
                                src={meta.picture}
                                alt={meta.label}
                                className="wallet-messages__avatar-img"
                              />
                            ) : (
                              <span>{meta.label.slice(0, 2)}</span>
                            )}
                          </div>
                          <div className="wallet-messages__thread-body">
                            <div className="wallet-messages__thread-title">
                              {meta.label}
                            </div>
                            <div className="wallet-messages__thread-preview">{thread.lastPreview}</div>
                          </div>
                          <div className="wallet-messages__thread-meta">
                            <span className="wallet-messages__thread-date">
                              {formatShortDate(thread.lastCreatedAt)}
                            </span>
                            {unreadCount > 0 && <span className="chat-unread-badge">{unreadCount}</span>}
                          </div>
                        </button>
                      </SwipeableDmThreadRow>
                    );
                  })}
                {dmThreadListEntries.length === 0 && (
                  <div className="wallet-messages__empty text-secondary text-sm text-center">
                    {dmView === "strangers" && !dmSearch.trim()
                      ? "No stranger messages yet."
                      : "No messages yet. Incoming DMs will appear here."}
                  </div>
                )}
                </div>
              )}
              {dmView === "thread" && activeThread && (
                <div className="wallet-messages__thread-view">
                <div className="wallet-messages__thread-header">
	                  <button
	                    className="glass-icon-button pressable"
	                    onClick={() => {
	                      setDmView(dmListViewRef.current);
	                      setActiveThreadPeer(null);
	                    }}
	                  >
                    <BackIcon className="h-4 w-4" />
                  </button>
	                  {(() => {
	                    const meta = peerLabelFor(activeThread.peerPubkey);
	                    return (
	                      <div className="wallet-messages__thread-title">
	                        <div className="wallet-messages__thread-title-text">{meta.label}</div>
	                      </div>
	                    );
	                  })()}
                  <span className="wallet-messages__thread-date">
                    {formatDmDay(activeThread.lastCreatedAt)}
                  </span>
                </div>
                {activeThread.isStranger && (
                  <div className="wallet-messages__stranger-actions">
                    <button
                      type="button"
                      className="wallet-messages__stranger-button wallet-messages__stranger-button--muted pressable"
                      onClick={() => toggleBlockPeer(activeThread.peerPubkey)}
                    >
                      {activeThreadBlocked ? "Unblock User" : "Block User"}
                    </button>
                    <button
                      type="button"
                      className="wallet-messages__stranger-button wallet-messages__stranger-button--accent pressable"
                      onClick={() => handleAddPeerToContacts(activeThread.peerPubkey)}
                    >
                      Add to contacts
                    </button>
                  </div>
                )}
                <div className="wallet-messages__thread-messages">
                  {activeThread.messages.map((msg) => {
                    const matchedItem =
                      messageItemsByEventId.get(msg.eventId) || pendingMessageItemsByEventId.get(msg.eventId);
                    const matchedInvite = pendingCalendarInvitesByEventId.get(msg.eventId);
                    const isPayment = msg.attachment?.type === "payment";
                    const isContact = msg.attachment?.type === "contact";
                    const isBoard = msg.attachment?.type === "board";
                    const isTask = msg.attachment?.type === "task";
                    const isEvent = msg.attachment?.type === "event";
                    const isStructured = !!msg.attachment && msg.attachment.type !== "text";
                    const bubbleClass = `wallet-message__bubble${isStructured ? " wallet-message__bubble--card" : ""}`;
                    const expanded = isDmMessageExpanded(msg.eventId);
                    const paymentHistoryEntry = isPayment
                      ? paymentHistoryByEventId.get(msg.eventId.toLowerCase())
                      : null;
                    const paymentCreatedSeconds = paymentHistoryEntry?.createdAt
                      ? Math.floor(paymentHistoryEntry.createdAt / 1000)
                      : msg.createdAt;
                    const cardDayLabel = (() => {
                      const date = new Date(paymentCreatedSeconds * 1000);
                      const day = date.getDate();
                      if (!Number.isFinite(day)) return "–";
                      return `${day}`.padStart(2, "0");
                    })();
                    const cardDate = formatShortDate(paymentCreatedSeconds);
                    const paymentDetails = isPayment
                      ? selectIncomingPaymentFromPayload(
                          tryParseJson<PaymentRequestPayload>(msg.attachment?.raw ?? null) ??
                            tryParseJson<PaymentRequestPayload>(msg.content) ??
                            msg.attachment?.raw ??
                            msg.content,
                        )
                      : null;
                    const paymentAmount =
                      paymentDetails?.amount ??
                      (isPayment ? msg.attachment?.amountSat ?? null : null);
                    const paymentUnit =
                      paymentDetails?.unit && typeof paymentDetails.unit === "string"
                        ? paymentDetails.unit.toLowerCase()
                        : "sat";
                    const paymentMintRaw =
                      paymentDetails?.mint && typeof paymentDetails.mint === "string"
                        ? normalizeMintUrl(paymentDetails.mint)
                        : null;
                    const paymentMint = paymentHistoryEntry
                      ? resolveMintDisplay(paymentHistoryEntry)
                      : paymentMintRaw;
                    const paymentToken =
                      paymentHistoryEntry?.detail ||
                      (paymentDetails?.token as string | undefined) ||
                      (isPayment && typeof msg.attachment?.raw === "string" ? msg.attachment.raw : "");
                    const paymentTitle =
                      paymentHistoryEntry?.amountSat != null
                        ? formatHistoryAmount(paymentHistoryEntry)
                        : paymentAmount != null
                        ? paymentUnit === "sat"
                          ? formatSatAmount(Math.max(0, Math.floor(paymentAmount)))
                          : `${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                        : "Payment request received";
                    const paymentStatusInfo = paymentHistoryEntry ? deriveHistoryStatus(paymentHistoryEntry) : null;
                    const paymentSubtitle =
                      paymentHistoryEntry?.summary ||
                      (paymentStatusInfo?.label
                        ? [paymentStatusInfo.label, paymentMint].filter(Boolean).join(" • ")
                        : null) ||
                      (isPayment && msg.attachment?.detail) ||
                      paymentMint ||
                      "Tap to view payment details";
                    const contactAttachment = isContact ? msg.attachment : null;
                    const contactMeta = contactAttachment
                      ? sharedContactMetaFor(
                          contactAttachment.npub,
                          contactAttachment.contactName ||
                            contactAttachment.displayName ||
                            contactAttachment.username ||
                            matchedItem?.contact?.displayName ||
                            matchedItem?.contact?.name ||
                            matchedItem?.title,
                          contactAttachment.picture,
                        )
                      : null;
                    const taskAttachment = isTask ? msg.attachment?.task : null;
                    const taskDueSeconds = taskAttachment?.dueISO
                      ? Math.floor(new Date(taskAttachment.dueISO).getTime() / 1000)
                      : null;
                    const taskHasDue = !!(taskDueSeconds && Number.isFinite(taskDueSeconds) && taskDueSeconds > 0);
                    const taskDayLabel = taskHasDue
                      ? (() => {
                          const date = new Date((taskDueSeconds as number) * 1000);
                          const day = date.getDate();
                          if (!Number.isFinite(day)) return cardDayLabel;
                          return `${day}`.padStart(2, "0");
                        })()
                      : cardDayLabel;
                    const taskCardDate = taskHasDue ? formatShortDate(taskDueSeconds as number) : cardDate;
                    const taskDueLabel = taskHasDue
                      ? `Due ${formatDmDay(taskDueSeconds as number)}${
                          taskAttachment?.dueTimeEnabled ? ` · ${formatDmTime(taskDueSeconds as number)}` : ""
                        }`
                      : "Shared task";
                    const taskSubtasks = Array.isArray(taskAttachment?.subtasks)
                      ? taskAttachment.subtasks
                          .map((subtask) => subtask.title?.trim())
                          .filter((title): title is string => !!title)
                      : [];
                    const isTaskAssignment = !!(taskAttachment?.assignment || matchedItem?.task?.assignment);
                    const eventAttachment = isEvent ? msg.attachment : null;
                    const eventReferenceSeconds =
                      eventAttachment?.start ? parseDateLikeToUnixSeconds(eventAttachment.start, msg.createdAt) : msg.createdAt;
                    const eventDayLabel = (() => {
                      const date = new Date(eventReferenceSeconds * 1000);
                      const day = date.getDate();
                      if (!Number.isFinite(day)) return cardDayLabel;
                      return `${day}`.padStart(2, "0");
                    })();
                    const eventCardDate = formatShortDate(eventReferenceSeconds);
                    const eventWhenLabel =
                      eventAttachment?.whenLabel ||
                      (matchedInvite && formatCalendarInviteWhen ? formatCalendarInviteWhen(matchedInvite) : "") ||
                      "Event invite";
                    const eventTitle = eventAttachment?.title || matchedInvite?.title || "Event invite";
                    const eventCopyValue =
                      (
                        eventAttachment?.view ||
                        matchedInvite?.view ||
                        eventAttachment?.canonical ||
                        matchedInvite?.canonical ||
                        [eventTitle, eventWhenLabel].filter(Boolean).join("\n")
                      ).trim() || eventTitle;
                    const cardTime = `${formatDmDay(paymentCreatedSeconds)} · ${formatDmTime(paymentCreatedSeconds)}`;
                    const paymentAmountLabel =
                      paymentHistoryEntry?.amountSat != null
                        ? formatHistoryAmount(paymentHistoryEntry)
                        : paymentAmount != null
                          ? paymentUnit === "sat"
                            ? formatSatAmount(Math.max(0, Math.floor(paymentAmount)))
                            : `${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                          : null;
                    const paymentStatusLabel = paymentStatusInfo?.label;
                    const paymentSummary = paymentHistoryEntry?.summary;
                    const actionStatus = matchedItem?.status || matchedInvite?.status;
                    const showActionButtons =
                      actionStatus !== "accepted" &&
                      actionStatus !== "declined" &&
                      actionStatus !== "tentative" &&
                      actionStatus !== "deleted" &&
                      actionStatus !== "dismissed";
                    const boardStatusLabel = getWalletMessageStatusLabel("board", actionStatus);
                    const contactStatusLabel = getWalletMessageStatusLabel("contact", actionStatus);
                    const taskStatusLabel = getWalletMessageStatusLabel("task", actionStatus);
                    const eventStatusLabel = getCalendarInviteStatusLabel(actionStatus);
                    const copyValue = buildDmCopyValue(msg, {
                      paymentToken,
                      boardId: isBoard
                        ? msg.attachment?.boardId || msg.attachment?.boardName || msg.content
                        : undefined,
                      contactNpub:
                        contactAttachment?.npub ||
                        formatNpubDisplay(contactAttachment?.npub || msg.peerPubkey) ||
                        formatNpub(msg.peerPubkey) ||
                        msg.peerPubkey,
                      taskPayload: taskAttachment || matchedItem?.task || null,
                    });
                    const copyLabel =
                      msg.attachment?.type === "board"
                        ? "Board ID"
                        : msg.attachment?.type === "contact"
                          ? "Pubkey"
                          : msg.attachment?.type === "task"
                            ? "Task"
                          : msg.attachment?.type === "payment"
                            ? "Token"
                            : "Message";
                    const isActionOpen = dmMessageActions?.eventId === msg.eventId;
                    const hasReactions = (dmReactions.get(msg.rumorEventId || msg.eventId)?.length ?? 0) > 0;
                    const stackClass = `wallet-message__stack${msg.isIncoming ? "" : " wallet-message__stack--out"}`;
                    return (
                      <div
                        key={msg.eventId}
                        className={`wallet-message ${msg.isIncoming ? "wallet-message--in" : "wallet-message--out"}`}
                      >
                        <div className={stackClass}>
                          <div className={`chat-bubble-wrap${hasReactions ? " chat-bubble-wrap--reacted" : ""}`}>
                          <div
                            className={bubbleClass}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelDmLongPress();
                              setDmMessageActions({ eventId: msg.eventId, copyValue, msg });
                            }}
                            onPointerDown={(event) => {
                              if ((event.target as HTMLElement | null)?.closest("button")) return;
                              cancelDmLongPress();
                              dmLongPressTimerRef.current = window.setTimeout(() => {
                                setDmMessageActions({ eventId: msg.eventId, copyValue, msg });
                              }, 420);
                            }}
                            onPointerUp={cancelDmLongPress}
                            onPointerLeave={cancelDmLongPress}
                            onPointerCancel={cancelDmLongPress}
                          >
                            {isBoard && (
                              <div className="wallet-message__card wallet-message__card--inline">
                                <div className="wallet-message__card-icon">{cardDayLabel}</div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {msg.attachment?.boardName || "Shared board"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">
                                    Add this board to your workspace
                                  </div>
                                  {showActionButtons ? (
                                    <div className="wallet-message__card-actions">
                                    <button
                                      className="accent-button button-sm pressable"
                                      onClick={() => {
                                        if (matchedItem) onAcceptMessage(matchedItem.id);
                                      }}
                                      disabled={!matchedItem}
                                    >
                                      Add board
                                    </button>
                                    <button
                                      className="ghost-button button-sm pressable"
                                      onClick={() => {
                                        if (matchedItem) onDismissMessage(matchedItem.id);
                                      }}
                                      disabled={!matchedItem}
                                    >
                                      Dismiss
                                    </button>
                                    </div>
                                  ) : (
                                    boardStatusLabel && (
                                      <div className="wallet-message__card-status">{boardStatusLabel}</div>
                                    )
                                  )}
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                              </div>
                            )}
                            {isContact && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon wallet-message__card-icon--contact">
                                  {contactMeta?.picture ? (
                                    <img src={contactMeta.picture} alt={contactMeta.label} className="wallet-message__avatar-img" />
                                  ) : (
                                    <span>{cardDayLabel}</span>
                                  )}
                                </div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {contactMeta?.label || contactAttachment?.contactName || "Shared contact"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">
                                    {contactMeta?.subtitle || "Shared contact"}
                                  </div>
                                  {contactMeta?.verifiedNip05 && (
                                    <div className="wallet-message__badge">NIP-05 verified</div>
                                  )}
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {(contactMeta?.npub || contactAttachment?.npub) && (
                                        <div className="wallet-message__detail-row">
                                          <span>Npub</span>
                                          <div className="wallet-message__detail-value">
                                            <span className="wallet-message__mono">
                                              {contactMeta?.npub ||
                                                formatNpubDisplay(contactAttachment?.npub) ||
                                                ""}
                                            </span>
                                            <button
                                              type="button"
                                              className="ghost-button button-xs pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void copyMessageValue(
                                                  contactMeta?.npub ||
                                                    formatNpubDisplay(contactAttachment?.npub) ||
                                                    "",
                                                  "npub",
                                                );
                                              }}
                                            >
                                              Copy
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                      {(contactAttachment?.nip05 || contactMeta?.verifiedNip05) && (
                                        <div className="wallet-message__detail-row">
                                          <span>NIP-05</span>
                                          <div className="wallet-message__detail-value">
                                            {contactMeta?.verifiedNip05 || contactAttachment?.nip05}
                                            {contactMeta?.verifiedNip05 && (
                                              <span className="wallet-message__badge">Verified</span>
                                            )}
                                          </div>
                                        </div>
                                      )}
                                      {contactAttachment?.address && (
                                        <div className="wallet-message__detail-row">
                                          <span>Lightning</span>
                                          <span className="wallet-message__detail-value">
                                            {contactAttachment.address}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {showActionButtons ? (
                                      <div className="wallet-message__card-actions">
                                        <button
                                          className="accent-button button-sm pressable"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (matchedItem) onAcceptMessage(matchedItem.id);
                                          }}
                                          disabled={!matchedItem}
                                        >
                                          Add contact
                                        </button>
                                        <button
                                          className="ghost-button button-sm pressable"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (matchedItem) onDismissMessage(matchedItem.id);
                                          }}
                                          disabled={!matchedItem}
                                        >
                                          Dismiss
                                        </button>
                                      </div>
                                    ) : (
                                      contactStatusLabel && (
                                        <div className="wallet-message__card-status">{contactStatusLabel}</div>
                                      )
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {isTask && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon">{taskDayLabel}</div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {taskAttachment?.title || "Shared task"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">{taskDueLabel}</div>
                                </div>
                                <div className="wallet-message__card-meta">{taskCardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {taskAttachment?.note && (
                                        <div className="wallet-message__detail-row">
                                          <span>Note</span>
                                          <span className="wallet-message__detail-value">
                                            {taskAttachment.note}
                                          </span>
                                        </div>
                                      )}
                                      {taskHasDue && (
                                        <div className="wallet-message__detail-row">
                                          <span>Due</span>
                                          <span className="wallet-message__detail-value">
                                            {taskDueLabel.replace("Due ", "")}
                                          </span>
                                        </div>
                                      )}
                                      {taskSubtasks.length > 0 && (
                                        <div className="wallet-message__detail-row">
                                          <span>Subtasks</span>
                                          <span className="wallet-message__detail-value">
                                            {taskSubtasks.join(", ")}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {showActionButtons ? (
                                      <div className="wallet-message__card-actions">
                                        {isTaskAssignment ? (
                                          <>
                                            <button
                                              className="accent-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onAcceptMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Accept
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onMaybeMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Maybe
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable text-rose-400"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onDeclineMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Decline
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <button
                                              className="accent-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onAcceptMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Add task
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void copyMessageValue(copyValue, "Task");
                                              }}
                                            >
                                              Copy
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onDismissMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Dismiss
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    ) : (
                                      taskStatusLabel && (
                                        <div className="wallet-message__card-status">{taskStatusLabel}</div>
                                      )
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {isEvent && (
                              <div className="wallet-message__card wallet-message__card--inline">
                                <div className="wallet-message__card-icon">{eventDayLabel}</div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">{eventTitle}</div>
                                  <div className="wallet-message__card-subtitle">{eventWhenLabel}</div>
                                  {showActionButtons ? (
                                    <div className="wallet-message__card-actions">
                                      <button
                                        className="accent-button button-sm pressable"
                                        onClick={() => matchedInvite && onCalendarInviteRsvp?.(matchedInvite, "accepted")}
                                        disabled={!matchedInvite}
                                      >
                                        Add event
                                      </button>
                                      <button
                                        className="ghost-button button-sm pressable"
                                        onClick={() => void copyMessageValue(eventCopyValue, "Event")}
                                      >
                                        Copy
                                      </button>
                                      <button
                                        className="ghost-button button-sm pressable"
                                        onClick={() => matchedInvite && onDismissCalendarInvite?.(matchedInvite)}
                                        disabled={!matchedInvite}
                                      >
                                        Dismiss
                                      </button>
                                    </div>
                                  ) : (
                                    eventStatusLabel && (
                                      <div className="wallet-message__card-status">{eventStatusLabel}</div>
                                    )
                                  )}
                                </div>
                                <div className="wallet-message__card-meta">{eventCardDate}</div>
                              </div>
                            )}
                            {isPayment && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon wallet-message__card-icon--payment">
                                  {cardDayLabel}
                                </div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">{paymentTitle}</div>
                                  <div className="wallet-message__card-subtitle">{paymentSubtitle}</div>
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {paymentAmountLabel && (
                                        <div className="wallet-message__detail-row">
                                          <span>Amount</span>
                                          <span className="wallet-message__detail-value">{paymentAmountLabel}</span>
                                        </div>
                                      )}
                                      {paymentStatusLabel && (
                                        <div className="wallet-message__detail-row">
                                          <span>Status</span>
                                          <span className="wallet-message__detail-value">{paymentStatusLabel}</span>
                                        </div>
                                      )}
                                      {paymentMint && (
                                        <div className="wallet-message__detail-row">
                                          <span>Mint</span>
                                          <span className="wallet-message__detail-value">{paymentMint}</span>
                                        </div>
                                      )}
                                      <div className="wallet-message__detail-row">
                                        <span>Received</span>
                                        <span className="wallet-message__detail-value">{cardTime}</span>
                                      </div>
                                      {paymentSummary && (
                                        <div className="wallet-message__detail-row wallet-message__detail-row--stacked">
                                          <span>History</span>
                                          <div className="wallet-message__token">{paymentSummary}</div>
                                        </div>
                                      )}
                                      {paymentToken && (
                                        <div className="wallet-message__detail-row wallet-message__detail-row--stacked">
                                          <span>Token</span>
                                          <div className="wallet-message__token">
                                            {paymentToken}
                                          </div>
                                          <div className="wallet-message__card-actions">
                                            <button
                                              type="button"
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void copyMessageValue(paymentToken, "Token");
                                              }}
                                            >
                                              Copy token
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                            {msg.attachment?.type === "text" && (
                              <>
                                {msg.replyToEventId && (() => {
                                  const replied = dmMessages.find((m) => m.eventId === msg.replyToEventId);
                                  if (!replied) return null;
                                  return (
                                    <div className="chat-reply-quote">
                                      <div className="chat-reply-quote__bar" />
                                      <div className="chat-reply-quote__text">
                                        {replied.content.length > 80 ? replied.content.slice(0, 80) + "…" : replied.content}
                                      </div>
                                    </div>
                                  );
                                })()}
                                <div className="wallet-message__text">{renderFormattedText(msg.content)}</div>
                                <div className="wallet-message__time">
                                  {formatDmDay(msg.createdAt)} · {formatDmTime(msg.createdAt)}
                                </div>
                              </>
                            )}
                          </div>
                          {(() => {
                            const reactionKey = msg.rumorEventId || msg.eventId;
                            const msgReactions = dmReactions.get(reactionKey);
                            if (!msgReactions?.length) return null;
                            const grouped = new Map<string, DmReaction[]>();
                            for (const r of msgReactions) {
                              const arr = grouped.get(r.emoji) || [];
                              arr.push(r);
                              grouped.set(r.emoji, arr);
                            }
                            return (
                              <div className={`chat-tapbacks${msg.isIncoming ? " chat-tapbacks--in" : " chat-tapbacks--out"}`}>
                                {Array.from(grouped.entries()).map(([emoji, reactions]) => (
                                  <button
                                    key={emoji}
                                    type="button"
                                    className="chat-tapback pressable"
                                    onClick={() => setDmReactionDetail({ eventId: reactionKey })}
                                  >
                                    <span className="chat-tapback__emoji">{emoji}</span>
                                    {reactions.length > 1 && <span className="chat-tapback__count">{reactions.length}</span>}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              )}
            </div>
          </div>
        )}
            {walletTab === "contacts" && (
              <div className="wallet-messages__empty text-secondary text-sm text-center space-y-3">
            <div>Contacts live here now. Open the Contacts panel to add or manage entries.</div>
            <button
              className="accent-button button-sm pressable"
              onClick={() => {
                setWalletTab("contacts");
                setContactsTabOpen(true);
              }}
            >
              Open contacts
            </button>
          </div>
            )}
          </div>

          {showWalletTabSwitcher && (
            <div className="wallet-tab-switcher">
              <div className="wallet-tab-switcher__pill">
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "wallet" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => setWalletTab("wallet")}
                >
                  <div className="wallet-tab-switcher__icon">
                    <WalletGlyphIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">Wallet</div>
                </button>
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "messages" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => {
                    setWalletTab("messages");
                    setDmView("list");
                  }}
                >
                  <div className="wallet-tab-switcher__icon">
                    <ChatBubbleIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">
                    Messages{mainUnreadCount > 0 ? ` (${mainUnreadCount})` : ""}
                  </div>
                </button>
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "contacts" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => {
                    setWalletTab("contacts");
                    setContactsTabOpen(true);
                  }}
                >
                  <div className="wallet-tab-switcher__icon">
                    <PersonIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">Contacts</div>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Chat Page ─────────────────────────────────────────────────── */}
      {isChatPage && (
        <div className="chat-page">
          {chatView === "threads" && (
            <div className="chat-page__threads">
              {/* Header */}
              <div className={`chat-page__header chat-page__header--safe-area${contactView !== "list" ? " chat-page__header--compact" : ""}`}>
                <button
                  type="button"
                  className={`contact-avatar pressable${profileCard.picture?.trim() ? " contact-avatar--image contact-avatar--profile" : " contact-avatar--profile"}`}
                  onClick={() => {
                    setActiveContactId("profile");
                    setContactView("detail");
                    setChatView("new-message");
                  }}
                  aria-label="Open profile"
                >
                  {profileCard.picture?.trim() ? (
                    <img src={profileCard.picture.trim()} alt={myCardName} className="contact-avatar__img" />
                  ) : (
                    contactInitials(myCardName)
                  )}
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">Chat</div>
                <button
                  type="button"
                  className="glass-icon-button glass-icon-button--accent pressable"
                  onClick={() => setChatView("new-message")}
                  title="New message"
                  aria-label="New message"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>

              {/* Search */}
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Search"
                    value={dmSearch}
                    onChange={(event) => setDmSearch(event.target.value)}
                  />
                  {dmSearch.length > 0 && (
                    <button
                      type="button"
                      className="chat-page__search-clear pressable"
                      aria-label="Clear search"
                      title="Clear search"
                      onClick={() => setDmSearch("")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
		              {/* Thread list */}
		              <div className="chat-page__thread-list">
		                {dmView === "strangers" && !dmSearch.trim() && (
		                  <button
		                    className="wallet-messages__thread pressable"
		                    onClick={() => {
		                      dmListViewRef.current = "list";
		                      setDmView("list");
		                      setActiveThreadPeer(null);
		                    }}
		                  >
		                    <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&larr;</div>
		                    <div className="wallet-messages__thread-body">
		                      <div className="wallet-messages__thread-title">Back to everyone</div>
		                      <div className="wallet-messages__thread-preview">View all conversations</div>
		                    </div>
		                  </button>
		                )}
		                {dmThreadListEntries.map((entry) => {
		                  if (entry.kind === "strangers") {
		                    return (
		                      <button
		                        key="strangers-group"
		                        className="wallet-messages__thread wallet-messages__thread--stranger pressable"
		                        onClick={() => {
		                          dmListViewRef.current = "strangers";
		                          setDmView("strangers");
		                          setActiveThreadPeer(null);
		                        }}
		                      >
		                        <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&#9678;</div>
		                        <div className="wallet-messages__thread-body">
		                          <div className="wallet-messages__thread-title">
		                            Strangers{strangerUnreadCount > 0 ? ` (${strangerUnreadCount})` : ""}
		                          </div>
		                          <div className="wallet-messages__thread-preview">{entry.lastPreview}</div>
		                        </div>
		                        <div className="wallet-messages__thread-meta">
		                          <span className="wallet-messages__thread-date">
		                            {formatShortDate(entry.lastCreatedAt)}
		                          </span>
		                          {strangerUnreadCount > 0 && (
		                            <span className="chat-unread-badge">{strangerUnreadCount}</span>
		                          )}
		                        </div>
		                      </button>
		                    );
		                  }
		                  const thread = entry.thread;
		                  const isGroupThread = !!thread.groupId;
		                  const groupMeta = isGroupThread ? groupChats.find((g) => g.groupId === thread.groupId) : null;
		                  const groupAvatarMembers = isGroupThread ? groupAvatarMembersFor(groupMeta, thread, groupMeta?.name || "Group") : [];
		                  const meta = isGroupThread
		                    ? { label: groupMeta?.name || "Group", picture: undefined, subtitle: `${groupMeta?.members.length || 0} members`, verifiedNip05: null }
		                    : peerLabelFor(thread.peerPubkey);
		                  const unreadCount = threadUnreadMap.get(thread.peerPubkey) || 0;
		                  return (
		                    <SwipeableDmThreadRow
		                      key={thread.peerPubkey}
		                      onArchive={() => handleArchiveDmThread(thread)}
		                      onDelete={() => handleDeleteDmThread(thread)}
		                    >
		                      <button
		                        className="wallet-messages__thread pressable"
		                        onClick={() => {
		                          dmListViewRef.current = dmView === "strangers" ? "strangers" : "list";
		                          setActiveThreadPeer(thread.peerPubkey);
		                          if (isGroupThread) setActiveGroupId(thread.groupId!);
		                          setChatView("conversation");
		                          setDmView("thread");
		                          const unreadIds = collectUnreadThreadItemEventIds(thread.messages, thread.peerPubkey);
		                          if (unreadIds.length) {
		                            onMarkMessagesRead(unreadIds);
		                          }
		                        }}
		                      >
		                        <div className={`wallet-messages__avatar${isGroupThread ? " wallet-messages__avatar--group" : ""}`}>
		                          {isGroupThread ? (
		                            <GroupAvatar members={groupAvatarMembers} />
		                          ) : meta.picture ? (
		                            <img src={meta.picture} alt={meta.label} className="wallet-messages__avatar-img" />
		                          ) : (
		                            <span>{meta.label.slice(0, 2)}</span>
		                          )}
		                        </div>
		                        <div className="wallet-messages__thread-body">
		                          <div className="wallet-messages__thread-title">
		                            {meta.label}
		                          </div>
		                          <div className="wallet-messages__thread-preview">{thread.lastPreview}</div>
		                        </div>
		                        <div className="wallet-messages__thread-meta">
		                          <span className="wallet-messages__thread-date">
		                            {formatShortDate(thread.lastCreatedAt)}
		                          </span>
		                          {unreadCount > 0 && (
		                            <span className="chat-unread-badge">{unreadCount}</span>
		                          )}
		                        </div>
		                      </button>
		                    </SwipeableDmThreadRow>
		                  );
		                })}
		                {dmThreadListEntries.length === 0 && messageSearchResults.length === 0 && (
		                  <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "3rem 1rem" }}>
		                    {dmView === "strangers" && !dmSearch.trim()
		                      ? "No stranger messages yet."
		                      : "No messages yet. Start a conversation or incoming DMs will appear here."}
		                  </div>
		                )}
		                {dmSearch.trim() && messageSearchResults.length > 0 && (
		                  <>
		                    <div className="chat-page__section-label" style={{ marginTop: "0.5rem" }}>Messages</div>
		                    {messageSearchResults.map(({ thread, message }) => {
		                      const isGroupThread = !!thread.groupId;
		                      const groupMeta = isGroupThread ? groupChats.find((g) => g.groupId === thread.groupId) : null;
		                      const threadMeta = isGroupThread
		                        ? { label: groupMeta?.name || "Group", picture: undefined }
		                        : peerLabelFor(thread.peerPubkey);
		                      const q = dmSearch.trim().toLowerCase();
		                      const matchIdx = message.content.toLowerCase().indexOf(q);
		                      const previewBefore = matchIdx > 0 ? message.content.slice(Math.max(0, matchIdx - 30), matchIdx) : "";
		                      const matchText = message.content.slice(matchIdx, matchIdx + q.length);
		                      const previewAfter = message.content.slice(matchIdx + q.length, matchIdx + q.length + 60);
		                      return (
		                        <button
		                          key={`${thread.peerPubkey}-${message.eventId}`}
		                          className="wallet-messages__thread pressable"
		                          onClick={() => {
		                            dmListViewRef.current = "list";
		                            setDmSearch("");
		                            setActiveThreadPeer(thread.peerPubkey);
		                            if (isGroupThread) setActiveGroupId(thread.groupId!);
		                            setChatView("conversation");
		                            setDmView("thread");
		                            setScrollToMessageId(message.eventId);
		                          }}
		                        >
		                          <div className={`wallet-messages__avatar${isGroupThread ? " wallet-messages__avatar--group" : ""}`}>
		                            {isGroupThread ? (
		                              <GroupAvatar members={groupAvatarMembersFor(groupMeta, thread, threadMeta.label)} />
		                            ) : threadMeta.picture ? (
		                              <img src={threadMeta.picture} alt={threadMeta.label} className="wallet-messages__avatar-img" />
		                            ) : (
		                              <span>{threadMeta.label.slice(0, 2)}</span>
		                            )}
		                          </div>
		                          <div className="wallet-messages__thread-body">
		                            <div className="wallet-messages__thread-title">{threadMeta.label}</div>
		                            <div className="wallet-messages__thread-preview">
		                              {previewBefore && <span style={{ opacity: 0.7 }}>{matchIdx > 0 ? "…" : ""}{previewBefore}</span>}
		                              <mark className="chat-msg-result__mark">{matchText}</mark>
		                              {previewAfter && <span style={{ opacity: 0.7 }}>{previewAfter}{previewAfter.length === 60 ? "…" : ""}</span>}
		                            </div>
		                          </div>
		                          <div className="wallet-messages__thread-meta">
		                            <span className="wallet-messages__thread-date">{formatShortDate(message.createdAt)}</span>
		                          </div>
		                        </button>
		                      );
		                    })}
		                  </>
		                )}
		              </div>

            </div>
          )}

          {chatView === "conversation" && activeThread && (
            <div className="chat-conversation">
              {/* Conversation header */}
              <div className="chat-conversation__header">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    setChatView("threads");
                    setActiveThreadPeer(null);
                    setActiveGroupId(null);
                    setDmView(dmListViewRef.current);
                  }}
                  aria-label="Back to threads"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                {(() => {
                  // Group conversation header
                  if (activeThread.groupId) {
                    const groupMeta = activeGroupChat;
                    const groupLabel = groupMeta?.name || "Group";
                    const memberCount = groupMeta?.members.length || 0;
                    return (
                      <button
                        type="button"
                        className="chat-conversation__peer-center pressable"
                        onClick={openActiveGroupInfo}
                        aria-label={`Open group info for ${groupLabel}`}
                      >
                        <div className="chat-conversation__peer-avatar chat-conversation__peer-avatar--lg chat-conversation__peer-avatar--group">
                          <GroupAvatar members={activeGroupAvatarMembers} />
                        </div>
                        <div className="chat-conversation__peer-name">{groupLabel}</div>
                        {memberCount > 0 && (
                          <div className="chat-conversation__peer-subtitle">{memberCount} members</div>
                        )}
                      </button>
                    );
                  }
                  // DM conversation header
                  const ownNormalized = normalizeNostrPubkey(myCardNpub);
                  const ownHex = ownNormalized ? compressedToRawHex(ownNormalized).toLowerCase() : "";
                  const isSelf = ownHex !== "" && activeThread.peerPubkey === ownHex;
                  const meta = isSelf
                    ? { label: myCardName, picture: profileCard.picture?.trim() || undefined, subtitle: undefined, verifiedNip05: null }
                    : peerLabelFor(activeThread.peerPubkey);
                  const openContact = () => {
                    if (isSelf) return;
                    const existingContact = contacts.find((contact) => {
                      const normalized = normalizeNostrPubkey(contact.npub || "");
                      const contactHex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                      return contactHex === activeThread.peerPubkey;
                    });
                    if (existingContact) {
                      setContactReturnView("new-message");
                      setActiveContactId(existingContact.id);
                      setContactDetailOverride(null);
                      setContactView("detail");
                    } else {
                      const peerMeta = getPeerProfile(activeThread.peerPubkey);
                      const created = upsertContact({
                        npub: formatNpub(activeThread.peerPubkey) || "",
                        name: peerMeta.displayName || peerMeta.username || peerMeta.label,
                        displayName: peerMeta.displayName || peerMeta.label,
                        username: sanitizeUsername(peerMeta.username || ""),
                        address: peerMeta.lud16 || "",
                        nip05: peerMeta.nip05 || "",
                        about: peerMeta.about || "",
                        picture: peerMeta.picture || "",
                      });
                      if (created) {
                        setContactReturnView("new-message");
                        setActiveContactId(created.id);
                        setContactDetailOverride(null);
                        setContactView("detail");
                      } else {
                        setActiveContactId(null);
                        setContactDetailOverride(null);
                        setContactEditDraft({
                          id: null,
                          name: peerMeta.displayName || peerMeta.username || peerMeta.label,
                          displayName: peerMeta.displayName || peerMeta.label,
                          username: sanitizeUsername(peerMeta.username || ""),
                          address: peerMeta.lud16 || "",
                          npub: formatNpub(activeThread.peerPubkey) || "",
                          nip05: peerMeta.nip05 || "",
                          about: peerMeta.about || "",
                          picture: peerMeta.picture || "",
                          isProfile: false,
                        });
                        setContactView("edit");
                      }
                    }
                    setChatView("new-message");
                  };
                  return (
                    <button
                      type="button"
                      className={`chat-conversation__peer-center${isSelf ? "" : " pressable"}`}
                      onClick={openContact}
                      aria-label={isSelf ? "My notes" : `Open contact card for ${meta.label}`}
                    >
                      <div className="chat-conversation__peer-avatar chat-conversation__peer-avatar--lg">
                        {meta.picture ? (
                          <img src={meta.picture} alt={meta.label} />
                        ) : (
                          <span>{meta.label.slice(0, 2)}</span>
                        )}
                      </div>
                      <div className="chat-conversation__peer-name">{meta.label}</div>
                    </button>
                  );
                })()}
                <div className="chat-conversation__header-spacer" />
              </div>

              {/* Stranger actions */}
              {activeThread.isStranger && (() => {
                const ownNormalized = normalizeNostrPubkey(myCardNpub);
                const ownHex = ownNormalized ? compressedToRawHex(ownNormalized).toLowerCase() : "";
                return ownHex === "" || activeThread.peerPubkey !== ownHex;
              })() && (
                <div className="chat-conversation__stranger-bar">
                  <button
                    type="button"
                    className="ghost-button button-xs pressable"
                    onClick={() => toggleBlockPeer(activeThread.peerPubkey)}
                  >
                    {dmBlockedPeersRef.current.has(activeThread.peerPubkey) ? "Unblock" : "Block"}
                  </button>
                  <button
                    type="button"
                    className="accent-button button-xs pressable"
                    onClick={() => handleAddPeerToContacts(activeThread.peerPubkey)}
                  >
                    Add to contacts
                  </button>
                </div>
              )}

              {/* Messages */}
              <div
                ref={messagesScrollRef}
                className="chat-conversation__messages"
                style={{ ["--chat-timestamp-reveal-width" as any]: `${CHAT_TIMESTAMP_REVEAL_WIDTH}px` }}
                onTouchStart={(e) => {
                  dragTouchStartX.current = e.touches[0].clientX;
                  dragTouchStartY.current = e.touches[0].clientY;
                  dragDirectionLocked.current = null;
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-duration", "0ms");
                  }
                }}
                onTouchMove={(e) => {
                  const dx = dragTouchStartX.current - e.touches[0].clientX;
                  const dy = Math.abs(e.touches[0].clientY - dragTouchStartY.current);
                  if (!dragDirectionLocked.current) {
                    if (Math.abs(dx) > dy + 4) dragDirectionLocked.current = "horizontal";
                    else if (dy > Math.abs(dx) + 4) dragDirectionLocked.current = "vertical";
                  }
                  if (dragDirectionLocked.current !== "horizontal") return;
                  const offset = Math.max(0, Math.min(CHAT_TIMESTAMP_REVEAL_WIDTH, dx));
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-offset", `${offset}px`);
                  }
                }}
                onTouchEnd={() => {
                  dragDirectionLocked.current = null;
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-duration", "300ms");
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-offset", "0px");
                  }
                }}
              >
                <div ref={messagesInnerRef} className="chat-messages-inner">
                  {activeThread.messages.filter((msg) => !msg.eventId.startsWith("draft-")).map((msg, idx, arr) => {
                    const prevMsg = idx > 0 ? arr[idx - 1] : null;
                    const prevDay = prevMsg ? new Date(prevMsg.createdAt * 1000) : null;
                    const msgDay = new Date(msg.createdAt * 1000);
                    const showDateSep = !prevDay ||
                      prevDay.getFullYear() !== msgDay.getFullYear() ||
                      prevDay.getMonth() !== msgDay.getMonth() ||
                      prevDay.getDate() !== msgDay.getDate();
                    const matchedItem =
                      messageItemsByEventId.get(msg.eventId) || pendingMessageItemsByEventId.get(msg.eventId);
                    const matchedInvite = pendingCalendarInvitesByEventId.get(msg.eventId);
                    const isPayment = msg.attachment?.type === "payment";
                    const isContact = msg.attachment?.type === "contact";
                    const isBoard = msg.attachment?.type === "board";
                    const isTask = msg.attachment?.type === "task";
                    const isEvent = msg.attachment?.type === "event";
                    const isStructured = !!msg.attachment && msg.attachment.type !== "text";
                    const bubbleClass = `chat-bubble${msg.isIncoming ? " chat-bubble--in" : " chat-bubble--out"}${isStructured ? " chat-bubble--card" : ""}${isContact ? " chat-bubble--contact-shell" : ""}${isTask ? " chat-bubble--task-share-shell" : ""}`;
                    const isIncomingGroupMessage = !!(activeThread.groupId && msg.isIncoming && msg.senderPubkey);
                    const senderMeta =
                      isIncomingGroupMessage && msg.senderPubkey ? peerLabelFor(msg.senderPubkey) : null;
                    const expanded = isDmMessageExpanded(msg.eventId);
                    const paymentState = isPayment
                      ? (() => {
                          const historyEntry = paymentHistoryByEventId.get(msg.eventId.toLowerCase()) || null;
                          const paymentCreatedAtMs = historyEntry?.createdAt || msg.createdAt * 1000;
                          const paymentDetails = selectIncomingPaymentFromPayload(
                            tryParseJson<PaymentRequestPayload>(msg.attachment?.raw ?? null) ??
                              tryParseJson<PaymentRequestPayload>(msg.content) ??
                              msg.attachment?.raw ??
                              msg.content,
                          );
                          const paymentAmount =
                            historyEntry?.amountSat ??
                            paymentDetails?.amount ??
                            (typeof msg.attachment?.amountSat === "number" ? msg.attachment.amountSat : null);
                          const paymentUnit =
                            paymentDetails?.unit && typeof paymentDetails.unit === "string"
                              ? paymentDetails.unit.toLowerCase()
                              : "sat";
                          const paymentMintRaw =
                            paymentDetails?.mint && typeof paymentDetails.mint === "string"
                              ? normalizeMintUrl(paymentDetails.mint)
                              : null;
                          const paymentMintLabel = historyEntry
                            ? resolveMintDisplay(historyEntry)
                            : paymentMintRaw;
                          const paymentDetailValue =
                            historyEntry?.detail ||
                            (paymentDetails?.token as string | undefined) ||
                            (typeof msg.attachment?.raw === "string" ? msg.attachment.raw : "") ||
                            "";
                          const resolvedType =
                            historyEntry?.type ??
                            (historyEntry?.detailKind === "invoice"
                              ? "lightning"
                              : paymentDetailValue
                                ? "ecash"
                                : undefined);
                          const typeLabel =
                            resolvedType === "lightning"
                              ? "Lightning"
                              : resolvedType === "ecash"
                                ? "Ecash"
                                : "Payment";
                          const timeLabel = formatRelativeTime(paymentCreatedAtMs);
                          const amountLabel = historyEntry
                            ? formatHistoryAmount(historyEntry)
                            : paymentAmount != null
                              ? paymentUnit === "sat"
                                ? formatSatAmount(Math.max(0, Math.floor(paymentAmount)), { sign: msg.isIncoming ? "+" : "−" })
                                : `${msg.isIncoming ? "+" : "−"}${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                              : null;
                          const fiatValue =
                            historyEntry?.fiatValueUsd != null
                              ? historyEntry.fiatValueUsd
                              : walletConversionEnabled && paymentAmount != null
                                ? captureFiatValueUsd(Math.max(0, Math.floor(paymentAmount)))
                                : null;
                          const fiatLabel =
                            walletConversionEnabled && fiatValue != null ? formatUsdAmount(fiatValue) : null;
                          const statusInfo = historyEntry
                            ? deriveHistoryStatus(historyEntry)
                            : {
                                label: msg.isIncoming ? "Received" : "Paid",
                                tone: (msg.isIncoming ? "success" : undefined) as "success" | undefined,
                              };
                          const detailKind =
                            historyEntry?.detailKind ||
                            (paymentDetailValue && isCashuTokenDetail(paymentDetailValue, "token") ? "token" : undefined);
                          const detailIsToken = isCashuTokenDetail(paymentDetailValue || undefined, detailKind);
                          const detailLabel = detailIsToken
                            ? "Cashu token"
                            : detailKind === "invoice"
                              ? "Lightning invoice"
                              : undefined;
                          const copyLabel = detailIsToken
                            ? "Copy token"
                            : detailKind === "invoice"
                              ? "Copy invoice"
                              : "Copy detail";
                          const pendingAction =
                            historyEntry && historyEntry.pendingTokenId && historyEntry.pendingStatus !== "redeemed"
                              ? {
                                  ariaLabel: "Redeem saved token",
                                  handler: () => handleRedeemPendingHistoryItem(historyEntry),
                                  busy: historyRedeemStates[historyEntry.id]?.status === "pending",
                                  status: historyRedeemStates[historyEntry.id],
                                }
                              : historyEntry && historyEntry.mintQuote
                                ? {
                                    ariaLabel: "Refresh invoice",
                                    handler: () => handleCheckHistoryMintQuote(historyEntry),
                                    busy: historyMintQuoteStates[historyEntry.id]?.status === "pending",
                                    status: historyMintQuoteStates[historyEntry.id],
                                  }
                                : historyEntry && historyEntry.tokenState && historyEntry.tokenState.lastState !== "SPENT"
                                  ? {
                                      ariaLabel: "Check token state",
                                      handler: () => performTokenStateCheck(historyEntry),
                                      busy: historyCheckStates[historyEntry.id]?.status === "pending",
                                      status: historyCheckStates[historyEntry.id],
                                    }
                                  : null;
                          return {
                            historyEntry,
                            paymentCreatedAtMs,
                            typeLabel,
                            timeLabel,
                            amountLabel,
                            fiatLabel,
                            mintLabel: paymentMintLabel,
                            statusInfo,
                            detailValue: paymentDetailValue,
                            detailLabel,
                            detailIsToken,
                            copyLabel,
                            pendingAction,
                            summary:
                              historyEntry?.summary ||
                              msg.attachment?.detail ||
                              (paymentMintLabel ? `${statusInfo.label} ${paymentMintLabel}` : null),
                            amountSatLabel:
                              paymentAmount != null
                                ? paymentUnit === "sat"
                                  ? formatSatAmount(Math.max(0, Math.floor(paymentAmount)))
                                  : `${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                                : "—",
                            createdLabel: new Date(paymentCreatedAtMs).toLocaleString(),
                            showRedeemButton: !!(historyEntry?.pendingTokenId && historyEntry.pendingStatus !== "redeemed"),
                            canMarkTokenSpent: !!historyEntry?.tokenState && historyEntry.tokenState.lastState !== "SPENT",
                          };
                        })()
                      : null;
                    const contactAttachment = isContact ? msg.attachment : null;
                    const contactMeta = contactAttachment
                      ? sharedContactMetaFor(
                          contactAttachment.npub,
                          contactAttachment.contactName ||
                            contactAttachment.displayName ||
                            contactAttachment.username ||
                            matchedItem?.contact?.displayName ||
                            matchedItem?.contact?.name ||
                            matchedItem?.title,
                          contactAttachment.picture || matchedItem?.contact?.picture || null,
                        )
                      : null;
                    const taskAttachment = isTask ? msg.attachment?.task || matchedItem?.task || null : null;
                    const taskDueSeconds = taskAttachment?.dueISO
                      ? Math.floor(new Date(taskAttachment.dueISO).getTime() / 1000)
                      : null;
                    const taskHasDue = !!(taskDueSeconds && Number.isFinite(taskDueSeconds) && taskDueSeconds > 0);
                    const taskDayLabel = taskHasDue
                      ? `${new Date((taskDueSeconds as number) * 1000).getDate()}`.padStart(2, "0")
                      : `${new Date(msg.createdAt * 1000).getDate()}`.padStart(2, "0");
                    const taskCardDate = taskHasDue ? formatShortDate(taskDueSeconds as number) : formatShortDate(msg.createdAt);
                    const taskDueLabel = taskHasDue
                      ? `Due ${formatDmDay(taskDueSeconds as number)}${
                          taskAttachment?.dueTimeEnabled ? ` · ${formatDmTime(taskDueSeconds as number)}` : ""
                        }`
                      : "Shared task";
                    const taskSubtasks = Array.isArray(taskAttachment?.subtasks)
                      ? taskAttachment.subtasks
                          .map((subtask) => subtask.title?.trim())
                          .filter((title): title is string => !!title)
                      : [];
                    const isTaskAssignment = !!(taskAttachment?.assignment || matchedItem?.task?.assignment);
                    const taskCopyValue = isTask
                      ? buildDmCopyValue(msg, { taskPayload: taskAttachment || matchedItem?.task || null })
                      : "";
                    const eventAttachment = isEvent ? msg.attachment : null;
                    const eventReferenceSeconds =
                      eventAttachment?.start ? parseDateLikeToUnixSeconds(eventAttachment.start, msg.createdAt) : msg.createdAt;
                    const eventDayLabel = `${new Date(eventReferenceSeconds * 1000).getDate()}`.padStart(2, "0");
                    const eventCardDate = formatShortDate(eventReferenceSeconds);
                    const eventWhenLabel =
                      eventAttachment?.whenLabel ||
                      (matchedInvite && formatCalendarInviteWhen ? formatCalendarInviteWhen(matchedInvite) : "") ||
                      "Event invite";
                    const eventTitle = eventAttachment?.title || matchedInvite?.title || "Event invite";
                    const eventCopyValue =
                      (
                        eventAttachment?.view ||
                        matchedInvite?.view ||
                        eventAttachment?.canonical ||
                        matchedInvite?.canonical ||
                        [eventTitle, eventWhenLabel].filter(Boolean).join("\n")
                      ).trim() || eventTitle;
                    const actionStatus = matchedItem?.status || matchedInvite?.status;
                    const showActionButtons =
                      actionStatus !== "accepted" &&
                      actionStatus !== "declined" &&
                      actionStatus !== "tentative" &&
                      actionStatus !== "deleted" &&
                      actionStatus !== "dismissed";
                    const contactStatusLabel = getWalletMessageStatusLabel("contact", actionStatus as WalletMessageItem["status"]);
                    const taskStatusLabel = getWalletMessageStatusLabel("task", actionStatus as WalletMessageItem["status"]);
                    const eventStatusLabel = getCalendarInviteStatusLabel(actionStatus);
                    const hasReactions = (dmReactions.get(msg.rumorEventId || msg.eventId)?.length ?? 0) > 0;

                    return (
                      <React.Fragment key={msg.eventId}>
                        {showDateSep && (
                          <div className="chat-date-separator">{formatDmDateSeparator(msg.createdAt)}</div>
                        )}
                        <div data-msg-id={msg.eventId} className={`chat-message ${msg.isIncoming ? "chat-message--in" : "chat-message--out"}`}>
                          <div className={`chat-message__body${senderMeta ? " chat-message__body--group-in" : ""}`}>
                            {senderMeta && (
                              <div className={`chat-message__sender-avatar${senderMeta.picture ? " chat-message__sender-avatar--image" : ""}`}>
                                {senderMeta.picture ? (
                                  <img src={senderMeta.picture} alt={senderMeta.label} className="contact-avatar__img" />
                                ) : (
                                  contactInitials(senderMeta.label)
                                )}
                              </div>
                            )}
                            <div className={`chat-message__content${senderMeta ? " chat-message__content--group-in" : ""}`}>
                              {senderMeta && <div className="chat-message__sender-name">{senderMeta.label}</div>}
                              <div className={`chat-bubble-wrap${hasReactions ? " chat-bubble-wrap--reacted" : ""}`}>
                              <div
                                className={bubbleClass}
                                onContextMenu={(ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  cancelDmLongPress();
                                  setDmMessageActions({ eventId: msg.eventId, copyValue: buildDmCopyValue(msg, {}), msg });
                                }}
                                onPointerDown={(ev) => {
                                  if ((ev.target as HTMLElement | null)?.closest("button,a")) return;
                                  cancelDmLongPress();
                                  dmLongPressTimerRef.current = window.setTimeout(() => {
                                    setDmMessageActions({ eventId: msg.eventId, copyValue: buildDmCopyValue(msg, {}), msg });
                                  }, 420);
                                }}
                                onPointerUp={cancelDmLongPress}
                                onPointerLeave={cancelDmLongPress}
                                onPointerCancel={cancelDmLongPress}
                              >
                              {isBoard && (
                                <div className="chat-bubble__card">
                                  <div className="chat-bubble__card-title">{msg.attachment?.boardName || "Shared board"}</div>
                                  <div className="chat-bubble__card-meta">Add this board to your workspace</div>
                                  {showActionButtons && (
                                    <div className="chat-bubble__card-actions">
                                      <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Add board</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onDismissMessage(matchedItem.id)}>Dismiss</button>
                                    </div>
                                  )}
                                  {!showActionButtons && actionStatus && (
                                    <div className="chat-bubble__card-status">{actionStatus}</div>
                                  )}
                                </div>
                              )}
                              {isContact && (() => {
                                const contactName =
                                  contactMeta?.label ||
                                  contactAttachment?.contactName ||
                                  contactAttachment?.displayName ||
                                  contactAttachment?.username ||
                                  "Contact";
                                const contactSubtitle = contactMeta?.subtitle || "Shared contact";
                                return (
                                  <div className="chat-bubble__card chat-bubble__card--contact-preview">
                                    <button
                                      type="button"
                                      className="chat-bubble__contact-preview pressable"
                                      onClick={() => openSharedContactPreview(contactAttachment, matchedItem)}
                                    >
                                      <div className="chat-bubble__contact-avatar">
                                        {contactMeta?.picture ? (
                                          <img src={contactMeta.picture} alt={contactName} className="contact-avatar__img" />
                                        ) : (
                                          contactInitials(contactName)
                                        )}
                                      </div>
                                      <div className="chat-bubble__contact-copy">
                                        <div className="chat-bubble__contact-name">{contactName}</div>
                                        <div className="chat-bubble__contact-subtitle">
                                          <span>{contactSubtitle}</span>
                                          {contactMeta?.verifiedNip05 && (
                                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                                          )}
                                        </div>
                                      </div>
                                      <span className="chat-bubble__contact-chevron" aria-hidden="true">›</span>
                                    </button>
                                    {!showActionButtons && contactStatusLabel && (
                                      <div className="chat-bubble__card-status">{contactStatusLabel}</div>
                                    )}
                                  </div>
                                );
                              })()}
                              {isTask && (() => {
                                const taskMetaLabel = isTaskAssignment
                                  ? "Task assignment"
                                  : taskHasDue
                                    ? taskDueLabel
                                    : "";
                                const taskHasBoardDetail = !!taskAttachment?.note?.trim() || taskSubtasks.length > 0;
                                return (
                                  <div className="chat-bubble__task-share">
                                    <div className="task-card" data-form={taskHasBoardDetail ? "stacked" : "pill"}>
                                      <div className="flex items-start gap-3">
                                        <div
                                          className="icon-button flex-shrink-0 chat-bubble__task-check"
                                          style={{ ["--icon-size" as any]: "1.85rem" }}
                                          aria-hidden="true"
                                        />
                                        <div className="flex-1 min-w-0 space-y-1">
                                          <div className="task-card__title">{taskAttachment?.title || "Shared task"}</div>
                                          {taskMetaLabel && <div className="task-card__meta">{taskMetaLabel}</div>}
                                        </div>
                                      </div>
                                      {taskAttachment?.note && (
                                        <div
                                          className="task-card__details text-xs text-secondary break-words"
                                          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                                        >
                                          {taskAttachment.note}
                                        </div>
                                      )}
                                      {taskSubtasks.length > 0 && (
                                        <ul className="task-card__details mt-2 space-y-1.5 text-xs text-secondary">
                                          {taskSubtasks.slice(0, 6).map((title) => (
                                            <li key={title} className="subtask-row">
                                              <input type="checkbox" checked={false} readOnly disabled className="subtask-row__checkbox" />
                                              <span className="subtask-row__text text-secondary">{title}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                    {showActionButtons && (
                                      <div className="chat-bubble__task-action-bar">
                                        {isTaskAssignment ? (
                                          <>
                                            <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Accept</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onMaybeMessage(matchedItem.id)}>Maybe</button>
                                            <button type="button" className="ghost-button button-xs pressable text-rose-400" onClick={() => matchedItem && onDeclineMessage(matchedItem.id)}>Decline</button>
                                          </>
                                        ) : (
                                          <>
                                            <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Add task</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => void copyMessageValue(taskCopyValue, "Task")}>Copy</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onDismissMessage(matchedItem.id)}>Dismiss</button>
                                          </>
                                        )}
                                      </div>
                                    )}
                                    {!showActionButtons && taskStatusLabel && (
                                      <div className="chat-bubble__task-status">{taskStatusLabel}</div>
                                    )}
                                  </div>
                                );
                              })()}
                              {isEvent && (
                                <div className="chat-bubble__card chat-bubble__card--structured">
                                  <div className="chat-bubble__card-shell">
                                    <div className="wallet-message__card-icon">{eventDayLabel}</div>
                                    <div className="wallet-message__card-body">
                                      <div className="wallet-message__card-title">{eventTitle}</div>
                                      <div className="wallet-message__card-subtitle">{eventWhenLabel}</div>
                                    </div>
                                    <div className="wallet-message__card-meta">{eventCardDate}</div>
                                  </div>
                                  {showActionButtons && (
                                    <div className="wallet-message__card-actions">
                                      <button type="button" className="accent-button button-xs pressable" onClick={() => matchedInvite && onCalendarInviteRsvp?.(matchedInvite, "accepted")}>Add event</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => void copyMessageValue(eventCopyValue, "Event")}>Copy</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedInvite && onDismissCalendarInvite?.(matchedInvite)}>Dismiss</button>
                                    </div>
                                  )}
                                  {!showActionButtons && eventStatusLabel && (
                                    <div className="chat-bubble__card-status">{eventStatusLabel}</div>
                                  )}
                                </div>
                              )}
                              {isPayment && (
                                <div className="chat-bubble__payment-history">
                                  <div className={`wallet-history__item${expanded ? " wallet-history__item--open" : ""}`}>
                                    <button
                                      type="button"
                                      className="wallet-history__summary pressable"
                                      onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                      aria-expanded={expanded}
                                      aria-label="Toggle payment details"
                                    >
                                      <div className="wallet-history__icon" aria-hidden="true">
                                        {paymentState?.typeLabel === "Lightning" ? (
                                          <LightningGlyph className="wallet-history__glyph" />
                                        ) : (
                                          <EcashGlyph className="wallet-history__glyph" />
                                        )}
                                      </div>
                                      <div className="wallet-history__body">
                                        <div className="wallet-history__title-row">
                                          <span className="wallet-history__type">{paymentState?.typeLabel || "Payment"}</span>
                                        </div>
                                        <div className="wallet-history__meta-row">
                                          <span
                                            className={`wallet-history__status${
                                              paymentState?.statusInfo?.tone ? ` wallet-history__status--${paymentState.statusInfo.tone}` : ""
                                            }`}
                                          >
                                            {paymentState?.statusInfo?.label || "Received"}
                                          </span>
                                        </div>
                                      </div>
                                      <div className="wallet-history__value">
                                        {paymentState?.amountLabel && (
                                          <span
                                            className={`wallet-history__amount wallet-history__amount--${
                                              msg.isIncoming ? "in" : "out"
                                            }`}
                                          >
                                            {paymentState.amountLabel}
                                          </span>
                                        )}
                                        {paymentState?.fiatLabel && (
                                          <span className="wallet-history__fiat">{paymentState.fiatLabel}</span>
                                        )}
                                        {paymentState?.pendingAction && (
                                          <button
                                            type="button"
                                            className="wallet-history__refresh"
                                            disabled={paymentState.pendingAction.busy}
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              paymentState.pendingAction?.handler();
                                            }}
                                            aria-label={paymentState.pendingAction.ariaLabel}
                                          >
                                            ↻
                                          </button>
                                        )}
                                      </div>
                                    </button>
                                    {expanded && paymentState && (
                                      <div className="wallet-history__details">
                                        {paymentState.detailLabel && paymentState.detailValue && (
                                          <QrCodeCard
                                            className="wallet-history__qr"
                                            value={paymentState.detailValue}
                                            label={paymentState.detailLabel}
                                            copyLabel={paymentState.copyLabel}
                                            size={220}
                                            enableNut16Animation={paymentState.detailIsToken}
                                          />
                                        )}
                                        <div className="wallet-history__details-grid">
                                          <div className="wallet-history__metric">
                                            <span>Amount</span>
                                            <span className="wallet-history__metric-value">
                                              {paymentState.amountSatLabel}
                                            </span>
                                          </div>
                                          {paymentState.fiatLabel && (
                                            <div className="wallet-history__metric">
                                              <span>Fiat</span>
                                              <span className="wallet-history__metric-value">{paymentState.fiatLabel}</span>
                                            </div>
                                          )}
                                          <div className="wallet-history__metric">
                                            <span>Status</span>
                                            <span className="wallet-history__metric-value">
                                              {paymentState.statusInfo.label}
                                            </span>
                                          </div>
                                          <div className="wallet-history__metric">
                                            <span>{msg.isIncoming ? "Time received" : "Time sent"}</span>
                                            <span className="wallet-history__metric-value">
                                              {paymentState.createdLabel}
                                            </span>
                                          </div>
                                          {paymentState.mintLabel && (
                                            <div className="wallet-history__metric">
                                              <span>Mint</span>
                                              <span className="wallet-history__metric-value">{paymentState.mintLabel}</span>
                                            </div>
                                          )}
                                        </div>
                                        {paymentState.summary && (
                                          <div className="wallet-history__detail-note">
                                            {paymentState.summary}
                                            {paymentState.historyEntry?.relatedTaskTitle && (
                                              <div className="wallet-history__detail-task">
                                                Task: {paymentState.historyEntry.relatedTaskTitle}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {paymentState.pendingAction?.status?.message && (
                                          <div
                                            className={`wallet-history__helper${
                                              paymentState.pendingAction.status.status === "error"
                                                ? " wallet-history__helper--error"
                                                : paymentState.pendingAction.status.status === "success"
                                                  ? " wallet-history__helper--success"
                                                  : ""
                                            }`}
                                          >
                                            {paymentState.pendingAction.status.message}
                                          </div>
                                        )}
                                        {paymentState.historyEntry?.pendingTokenId &&
                                          paymentState.showRedeemButton && (
                                            <div className="wallet-history__section">
                                              <div className="wallet-history__section-content">
                                                <button
                                                  className="accent-button button-sm pressable"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    handleRedeemPendingHistoryItem(paymentState.historyEntry!);
                                                  }}
                                                  disabled={historyRedeemStates[paymentState.historyEntry.id]?.status === "pending"}
                                                >
                                                  Redeem
                                                </button>
                                                {historyRedeemStates[paymentState.historyEntry.id]?.message && (
                                                  <div
                                                    className={`wallet-history__helper${
                                                      historyRedeemStates[paymentState.historyEntry.id]?.status === "error"
                                                        ? " wallet-history__helper--error"
                                                        : historyRedeemStates[paymentState.historyEntry.id]?.status === "success"
                                                          ? " wallet-history__helper--success"
                                                          : ""
                                                    }`}
                                                  >
                                                    {historyRedeemStates[paymentState.historyEntry.id]?.message}
                                                  </div>
                                                )}
                                              </div>
                                              {paymentState.historyEntry.pendingTokenMint && (
                                                <div className="wallet-history__helper">
                                                  Saved mint: {paymentState.historyEntry.pendingTokenMint}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        {paymentState.historyEntry?.tokenState && (
                                          <div className="wallet-history__section space-y-2">
                                            <div className="wallet-history__section-title">Token state</div>
                                            <div className="wallet-history__section-content space-y-2 text-xs text-secondary">
                                              <div className="text-tertiary break-all">
                                                Mint: {paymentState.historyEntry.tokenState.mintUrl}
                                              </div>
                                              <div className="flex flex-wrap gap-2 items-center">
                                                <button
                                                  className="ghost-button button-sm pressable"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    performTokenStateCheck(paymentState.historyEntry!);
                                                  }}
                                                  disabled={historyCheckStates[paymentState.historyEntry.id]?.status === "pending"}
                                                >
                                                  Check token state
                                                </button>
                                                {historyCheckStates[paymentState.historyEntry.id]?.status === "pending" && <span>Checking…</span>}
                                                {historyCheckStates[paymentState.historyEntry.id]?.status === "success" &&
                                                  historyCheckStates[paymentState.historyEntry.id]?.message && (
                                                    <span className="text-accent">
                                                      {historyCheckStates[paymentState.historyEntry.id]?.message}
                                                    </span>
                                                  )}
                                                {historyCheckStates[paymentState.historyEntry.id]?.status === "error" &&
                                                  historyCheckStates[paymentState.historyEntry.id]?.message && (
                                                    <span className="text-rose-400">
                                                      {historyCheckStates[paymentState.historyEntry.id]?.message}
                                                    </span>
                                                  )}
                                              </div>
                                              {typeof paymentState.historyEntry.tokenState.lastCheckedAt === "number" && (
                                                <div className="text-tertiary">
                                                  Last checked: {new Date(paymentState.historyEntry.tokenState.lastCheckedAt).toLocaleString()}
                                                </div>
                                              )}
                                              {paymentState.historyEntry.tokenState.lastWitnesses &&
                                                Object.keys(paymentState.historyEntry.tokenState.lastWitnesses).length > 0 && (
                                                  <div className="space-y-1">
                                                    <div className="text-tertiary">Witness data</div>
                                                    {Object.entries(paymentState.historyEntry.tokenState.lastWitnesses).map(([y, witness]) => (
                                                      <div key={y} className="break-all">
                                                        <div className="text-tertiary">Y: {y}</div>
                                                        <div>{witness}</div>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                            </div>
                                          </div>
                                        )}
                                        {paymentState.historyEntry?.mintQuote && (
                                          <div className="wallet-history__section space-y-2">
                                            <div className="wallet-history__section-title">Invoice</div>
                                            <div className="wallet-history__section-content space-y-1 text-xs text-secondary">
                                              {paymentState.historyEntry.mintQuote.mintUrl && (
                                                <div className="text-tertiary break-all">
                                                  Mint: {paymentState.historyEntry.mintQuote.mintUrl}
                                                </div>
                                              )}
                                              <div className="text-tertiary">
                                                Amount: {formatSatAmount(paymentState.historyEntry.mintQuote.amount)}
                                              </div>
                                              <div className="flex flex-wrap gap-2 items-center">
                                                <button
                                                  className="ghost-button button-sm pressable"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    handleCheckHistoryMintQuote(paymentState.historyEntry!);
                                                  }}
                                                  disabled={historyMintQuoteStates[paymentState.historyEntry.id]?.status === "pending"}
                                                >
                                                  Check invoice
                                                </button>
                                                {historyMintQuoteStates[paymentState.historyEntry.id]?.status === "pending" && <span>Checking…</span>}
                                                {historyMintQuoteStates[paymentState.historyEntry.id]?.status === "success" &&
                                                  historyMintQuoteStates[paymentState.historyEntry.id]?.message && (
                                                    <span className="text-accent">
                                                      {historyMintQuoteStates[paymentState.historyEntry.id]?.message}
                                                    </span>
                                                  )}
                                                {historyMintQuoteStates[paymentState.historyEntry.id]?.status === "error" &&
                                                  historyMintQuoteStates[paymentState.historyEntry.id]?.message && (
                                                    <span className="text-rose-400">
                                                      {historyMintQuoteStates[paymentState.historyEntry.id]?.message}
                                                    </span>
                                                  )}
                                              </div>
                                              {paymentState.historyEntry.mintQuote.createdAt && (
                                                <div className="text-tertiary">
                                                  Created: {new Date(paymentState.historyEntry.mintQuote.createdAt).toLocaleString()}
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        )}
                                        {paymentState.historyEntry?.revertToken && (
                                          <div className="wallet-history__section space-y-2">
                                            <div className="wallet-history__section-title">Revert</div>
                                            <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                                              <button
                                                className="accent-button button-sm pressable"
                                                onClick={(event) => {
                                                  event.stopPropagation();
                                                  handleRevertHistoryToken(paymentState.historyEntry!);
                                                }}
                                                disabled={historyRevertState[paymentState.historyEntry.id]?.status === "pending"}
                                              >
                                                Revert token
                                              </button>
                                              {historyRevertState[paymentState.historyEntry.id]?.status === "pending" && <span>Redeeming…</span>}
                                              {historyRevertState[paymentState.historyEntry.id]?.status === "success" &&
                                                historyRevertState[paymentState.historyEntry.id]?.message && (
                                                  <span className="text-accent">
                                                    {historyRevertState[paymentState.historyEntry.id]?.message}
                                                  </span>
                                                )}
                                              {historyRevertState[paymentState.historyEntry.id]?.status === "error" &&
                                                historyRevertState[paymentState.historyEntry.id]?.message && (
                                                  <span className="text-rose-400">
                                                    {historyRevertState[paymentState.historyEntry.id]?.message}
                                                  </span>
                                                )}
                                            </div>
                                          </div>
                                        )}
                                        {paymentState.historyEntry && (
                                          <div className="wallet-history__section space-y-2">
                                            <div className="wallet-history__section-title">Actions</div>
                                            <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                                              {paymentState.canMarkTokenSpent && (
                                                <button
                                                  type="button"
                                                  className="ghost-button button-sm pressable"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    handleMarkHistoryTokenSpent(paymentState.historyEntry!);
                                                  }}
                                                >
                                                  Mark token spent
                                                </button>
                                              )}
                                              <button
                                                type="button"
                                                className="ghost-button button-sm pressable"
                                                onClick={(event) => {
                                                  event.stopPropagation();
                                                  handleDeleteHistoryEntry(paymentState.historyEntry!);
                                                }}
                                              >
                                                Delete entry
                                              </button>
                                              {paymentState.detailValue && !paymentState.detailLabel && (
                                                <button
                                                  type="button"
                                                  className="ghost-button button-sm pressable"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    void copyMessageValue(paymentState.detailValue, "Payment detail");
                                                  }}
                                                >
                                                  Copy detail
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                              {msg.attachment?.type === "text" && (() => {
                                const msgUrls = extractUrlsFromText(msg.content);
                                const repliedMsg = msg.replyToEventId ? dmMessages.find((m) => m.eventId === msg.replyToEventId) : null;
                                return (
                                  <div className="chat-bubble__card chat-bubble__card--text">
                                    {repliedMsg && (
                                      <div className="chat-reply-quote">
                                        <div className="chat-reply-quote__bar" />
                                        <div className="chat-reply-quote__text">
                                          {repliedMsg.content.length > 80 ? repliedMsg.content.slice(0, 80) + "…" : repliedMsg.content}
                                        </div>
                                      </div>
                                    )}
                                    <div className="chat-bubble__text">{renderFormattedText(msg.content)}</div>
                                    {msgUrls.length > 0 && (
                                      <div className="chat-link-previews">
                                        {msgUrls.map((url) => {
                                          const domain = extractDomain(url);
                                          const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
                                          const displayUrl = url.length > 55 ? url.slice(0, 52) + "…" : url;
                                          return (
                                            <a
                                              key={url}
                                              href={url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="chat-link-preview pressable"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <img
                                                src={faviconUrl}
                                                alt=""
                                                className="chat-link-preview__favicon"
                                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                              />
                                              <div className="chat-link-preview__copy">
                                                <div className="chat-link-preview__domain">{domain}</div>
                                                <div className="chat-link-preview__url">{displayUrl}</div>
                                              </div>
                                              <span className="chat-link-preview__arrow" aria-hidden="true">↗</span>
                                            </a>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {msg.attachment?.type === "file" && (
                                <MessengerFileBubble
                                  descriptor={{
                                    url: msg.attachment.url,
                                    mimeType: msg.attachment.mimeType,
                                    filename: msg.attachment.filename,
                                    size: msg.attachment.size,
                                    width: msg.attachment.width,
                                    height: msg.attachment.height,
                                    algorithm: msg.attachment.algorithm,
                                    keyHex: msg.attachment.keyHex,
                                    nonceHex: msg.attachment.nonceHex,
                                  }}
                                  isIncoming={msg.isIncoming}
                                />
                              )}
                            </div>
                            {(() => {
                              const reactionKey = msg.rumorEventId || msg.eventId;
                              const msgReactions = dmReactions.get(reactionKey);
                              if (!msgReactions?.length) return null;
                              const grouped = new Map<string, DmReaction[]>();
                              for (const r of msgReactions) {
                                const arr = grouped.get(r.emoji) || [];
                                arr.push(r);
                                grouped.set(r.emoji, arr);
                              }
                              return (
                                <div className={`chat-tapbacks${msg.isIncoming ? " chat-tapbacks--in" : " chat-tapbacks--out"}`}>
                                  {Array.from(grouped.entries()).map(([emoji, reactions]) => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className="chat-tapback pressable"
                                      onClick={() => setDmReactionDetail({ eventId: reactionKey })}
                                    >
                                      <span className="chat-tapback__emoji">{emoji}</span>
                                      {reactions.length > 1 && <span className="chat-tapback__count">{reactions.length}</span>}
                                    </button>
                                  ))}
                                </div>
                              );
                            })()}
                              </div>
                            </div>
                          </div>
                          <div className="chat-message__timestamp">{formatDmTime(msg.createdAt)}</div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {/* Pending messages */}
                  {visiblePendingMessages.map((pm) => (
                    <div key={pm.id} className="chat-message chat-message--out">
                      <div className="chat-message__body">
                        <div className="chat-message__bubble-wrap">
                          <div className="chat-bubble chat-bubble--out chat-bubble--pending">
                            {pm.file ? (
                              <div className={`chat-bubble__card chat-bubble__card--file${isImageMime(pm.file.mimeType) ? " chat-bubble__card--image" : isVideoMime(pm.file.mimeType) ? " chat-bubble__card--video" : isAudioMime(pm.file.mimeType) ? " chat-bubble__card--audio" : " chat-bubble__card--doc"} chat-bubble__card--pending`}>
                                {pm.file.previewUrl && isImageMime(pm.file.mimeType) ? (
                                  <div className="chat-file__image-frame">
                                    <img
                                      src={pm.file.previewUrl}
                                      alt={pm.file.filename}
                                      className="chat-file__image chat-file__image--pending"
                                    />
                                    <div className="chat-file__progress-overlay">
                                      <div className="chat-file__progress-label">
                                        {pm.file.phase === "encrypting"
                                          ? "Encrypting…"
                                          : pm.file.phase === "uploading"
                                            ? `Uploading ${Math.round((pm.file.progress || 0) * 100)}%`
                                            : "Sending…"}
                                      </div>
                                      <div className="chat-file__progress-track">
                                        <div
                                          className="chat-file__progress-bar"
                                          style={{ width: `${Math.round((pm.file.progress || 0) * 100)}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="chat-file__doc chat-file__doc--pending">
                                    <div className="chat-file__doc-icon">
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                                        <polyline points="13 2 13 9 20 9" />
                                      </svg>
                                    </div>
                                    <div className="chat-file__doc-body">
                                      <div className="chat-file__name" title={pm.file.filename}>{pm.file.filename}</div>
                                      <div className="chat-file__size">
                                        {pm.file.phase === "encrypting"
                                          ? "Encrypting…"
                                          : pm.file.phase === "uploading"
                                            ? `Uploading ${Math.round((pm.file.progress || 0) * 100)}%`
                                            : "Sending…"}
                                      </div>
                                      <div className="chat-file__progress-track chat-file__progress-track--doc">
                                        <div
                                          className="chat-file__progress-bar"
                                          style={{ width: `${Math.round((pm.file.progress || 0) * 100)}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="chat-bubble__card chat-bubble__card--text">
                                <div className="chat-bubble__text">{renderFormattedText(pm.content)}</div>
                              </div>
                            )}
                          </div>
                          {pm.status === "sending" && <div className="chat-sending-spinner" />}
                          {pm.status === "sent" && <div className="chat-sending-check" key={`check-${pm.id}`}>✓</div>}
                        </div>
                      </div>
                      <div className="chat-message__timestamp">{formatDmTime(pm.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Compose bar */}
              {activeThread.groupId && activeGroupLeft ? (
                <div className="chat-group-rejoin">
                  <div className="chat-group-rejoin__note">You left this group.</div>
                  <button
                    type="button"
                    className="chat-group-rejoin__button pressable"
                    onClick={handleToggleActiveGroupMembership}
                  >
                    Join Group
                  </button>
                </div>
              ) : (
                <div className="chat-compose-stack">
                  {replyToMessage && (
                    <div className="chat-reply-banner">
                      <div className="chat-reply-banner__bar" />
                      <div className="chat-reply-banner__body">
                        <div className="chat-reply-banner__label">Reply</div>
                        <div className="chat-reply-banner__text">
                          {replyToMessage.content.length > 80 ? replyToMessage.content.slice(0, 80) + "…" : replyToMessage.content}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="chat-reply-banner__close pressable"
                        aria-label="Cancel reply"
                        onClick={() => setReplyToMessage(null)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  )}
                  <input
                    ref={chatPhotoInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0 }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (files.length) {
                        closeAttachTray();
                        void sendMessengerFileAttachments(files, activeThread.peerPubkey);
                      }
                    }}
                  />
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept={CHAT_FILE_PICKER_ACCEPT}
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0 }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (files.length) {
                        closeAttachTray();
                        void sendMessengerFileAttachments(files, activeThread.peerPubkey);
                      }
                    }}
                  />
                  <div className="chat-compose">
                    <button
                      type="button"
                      className={`chat-compose__attach chat-compose__attach--toggle pressable${attachTrayOpen ? " is-open" : ""}`}
                      onClick={handleToggleAttachTray}
                      aria-label={attachTrayOpen ? "Close attachments" : "Open attachments"}
                      aria-expanded={attachTrayOpen}
                      title={attachTrayOpen ? "Close attachments" : "Open attachments"}
                    >
                      <span className="chat-compose__attach-icon" aria-hidden="true">
                        <span className="chat-compose__attach-line chat-compose__attach-line--horizontal" />
                        <span className="chat-compose__attach-line chat-compose__attach-line--vertical" />
                      </span>
                    </button>
                    <input
                      ref={chatComposeInputRef}
                      className="chat-compose__input"
                      placeholder="Message"
	                      value={chatCompose}
	                      onFocus={() => {
	                        setAttachTrayOpen(false);
	                      }}
                      onChange={(e) => setChatCompose(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && chatCompose.trim()) {
                          e.preventDefault();
                          const capturedReply = replyToMessage;
                          void (async () => {
                            const text = chatCompose.trim();
                            if (!text) return;
                            setChatCompose("");
                            setReplyToMessage(null);
                            const pendingId = crypto.randomUUID();
                            const pendingCreatedAt = Math.floor(Date.now() / 1000);
                            setPendingMessages(prev => [
                              ...prev,
                              {
                                id: pendingId,
                                content: text,
                                peerPubkey: activeThread.peerPubkey,
                                createdAt: pendingCreatedAt,
                                status: "sending",
                              },
                            ]);
                            try {
                              const { identity } = readNostrIdentity();
                              if (!identity) return;
                              const senderHex = identity.pubkey.toLowerCase();
                              const isGroup = !!activeThread.groupId;
                              const groupMeta = isGroup ? groupChatsRef.current.find((g) => g.groupId === activeThread.groupId) : null;
                              const groupRecipients = groupMeta ? groupMeta.members.filter((m) => m !== senderHex) : [];
                              const recipientHex = isGroup ? groupRecipients[0] || "" : activeThread.peerPubkey.toLowerCase();
                              const relayTargets = isGroup ? groupRecipients : [recipientHex];
                              const allRelays = new Set<string>();
                              for (const target of relayTargets) {
                                const relays = await resolveNip17Relays(target, defaultNostrRelays);
                                relays.forEach((r) => allRelays.add(r));
                              }
                              const publishRelays = Array.from(allRelays);
                              if (!publishRelays.length) return;
                              const pool = ensureNostrPool();
                              const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
                              const extraTags: string[][] = [];
                              if (isGroup && groupMeta?.name) extraTags.push(["subject", groupMeta.name]);
                              if (capturedReply) {
                                extraTags.push(["e", capturedReply.eventId]);
                              }
                              const { selfWrapEvent } = await publishNip17Giftwraps({
                                content: text,
                                senderHex,
                                recipientHex,
                                senderSecret: identity.secret,
                                publish,
                                ...(isGroup ? { recipientHexes: groupRecipients, extraTags } : { extraTags: capturedReply ? extraTags : undefined }),
                              });
                              if (selfWrapEvent) {
                                await handleDmEvent(selfWrapEvent);
                              }
                              setPendingMessages(prev => prev.map(m => m.id === pendingId ? { ...m, status: "sent" as const } : m));
                              setTimeout(() => setPendingMessages(prev => prev.filter(m => m.id !== pendingId)), 2000);
                            } catch (err) {
                              setPendingMessages(prev => prev.filter(m => m.id !== pendingId));
                              console.warn("[chat] send failed", err);
                              setChatCompose(text);
                            }
                          })();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="chat-compose__send pressable"
                      disabled={!chatCompose.trim()}
                      onClick={() => {
                        const capturedReply = replyToMessage;
                        void (async () => {
                          const text = chatCompose.trim();
                          if (!text) return;
                          setChatCompose("");
                          setReplyToMessage(null);
                          const pendingId = crypto.randomUUID();
                          const pendingCreatedAt = Math.floor(Date.now() / 1000);
                          setPendingMessages(prev => [
                            ...prev,
                            {
                              id: pendingId,
                              content: text,
                              peerPubkey: activeThread.peerPubkey,
                              createdAt: pendingCreatedAt,
                              status: "sending",
                            },
                          ]);
                          try {
                            const { identity } = readNostrIdentity();
                            if (!identity) return;
                            const senderHex = identity.pubkey.toLowerCase();
                            const isGroup = !!activeThread.groupId;
                            const groupMeta = isGroup ? groupChatsRef.current.find((g) => g.groupId === activeThread.groupId) : null;
                            const groupRecipients = groupMeta ? groupMeta.members.filter((m) => m !== senderHex) : [];
                            const recipientHex = isGroup ? groupRecipients[0] || "" : activeThread.peerPubkey.toLowerCase();
                            const relayTargets = isGroup ? groupRecipients : [recipientHex];
                            const allRelays = new Set<string>();
                            for (const target of relayTargets) {
                              const relays = await resolveNip17Relays(target, defaultNostrRelays);
                              relays.forEach((r) => allRelays.add(r));
                            }
                            const publishRelays = Array.from(allRelays);
                            if (!publishRelays.length) return;
                            const pool = ensureNostrPool();
                            const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
                            const extraTags: string[][] = [];
                            if (isGroup && groupMeta?.name) extraTags.push(["subject", groupMeta.name]);
                            if (capturedReply) {
                              extraTags.push(["e", capturedReply.eventId]);
                            }
                            const { selfWrapEvent } = await publishNip17Giftwraps({
                              content: text,
                              senderHex,
                              recipientHex,
                              senderSecret: identity.secret,
                              publish,
                              ...(isGroup ? { recipientHexes: groupRecipients, extraTags } : { extraTags: capturedReply ? extraTags : undefined }),
                            });
                            if (selfWrapEvent) {
                              await handleDmEvent(selfWrapEvent);
                            }
                            setPendingMessages(prev => prev.map(m => m.id === pendingId ? { ...m, status: "sent" as const } : m));
                            setTimeout(() => setPendingMessages(prev => prev.filter(m => m.id !== pendingId)), 2000);
                          } catch (err) {
                            setPendingMessages(prev => prev.filter(m => m.id !== pendingId));
                            console.warn("[chat] send failed", err);
                            setChatCompose(text);
                          }
                        })();
                      }}
                      aria-label="Send message"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                      </svg>
                    </button>
                  </div>
                  <div
                    className={`chat-compose-tray${attachTrayOpen ? " is-open" : ""}`}
                    style={{ ["--chat-compose-tray-height" as any]: `${chatAttachTrayHeight}px` }}
                    aria-hidden={!attachTrayOpen}
                  >
                    <div className="chat-compose-tray__surface">
                      <div className="chat-compose-tray__grid">
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatPhotoPicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3.5" y="5" width="17" height="14" rx="3" />
                              <circle cx="8.5" cy="10" r="1.5" />
                              <path d="m6.5 16 4.2-4.2a1.2 1.2 0 0 1 1.7 0L17.5 17" />
                              <path d="m13.5 14 1.2-1.2a1.2 1.2 0 0 1 1.7 0l1.6 1.6" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">Photos</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatFilePicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M8 3.5h6l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z" />
                              <path d="M14 3.5V8h4" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">File</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatContactPicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="8.25" r="3.25" />
                              <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">Contact</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatEcash}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <ellipse cx="12" cy="8" rx="6.5" ry="2.75" />
                              <path d="M5.5 8v4c0 1.52 2.9 2.75 6.5 2.75s6.5-1.23 6.5-2.75V8" />
                              <path d="M5.5 12v4c0 1.52 2.9 2.75 6.5 2.75s6.5-1.23 6.5-2.75v-4" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">eCash</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatLightning}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M13 2 6 13h4l-1 9 9-13h-4l1-7z" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">Lightning</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {chatView === "group-info" && activeThread?.groupId && activeGroupChat && (() => {
            const groupMediaMessages = activeThread.messages.filter(
              (m) => m.attachment?.type === "file",
            );
            const URL_RE = /https?:\/\/[^\s<>"']+/g;
            const groupLinkMessages = activeThread.messages
              .filter((m) => !m.attachment || m.attachment.type === "text")
              .map((m) => {
                const urls = m.content.match(URL_RE) || [];
                return urls.length ? { message: m, urls } : null;
              })
              .filter(Boolean) as { message: WalletDmMessage; urls: string[] }[];
            return (
              <div className="chat-group-info">
                {/* Header */}
                <div className="chat-page__header chat-page__header--safe-area">
                  <button
                    className="glass-icon-button pressable"
                    onClick={() => setChatView("conversation")}
                    aria-label="Back to conversation"
                  >
                    <BackIcon className="h-5 w-5" />
                  </button>
                  <div className="chat-group-info__header-avatar">
                    <GroupAvatar members={activeGroupAvatarMembers} />
                  </div>
                  <button
                    type="button"
                    className="chat-group-info__edit-btn pressable"
                    onClick={openGroupNameEditor}
                  >
                    Edit
                  </button>
                </div>

                {/* Group name */}
                <div className="chat-group-info__name">{activeGroupChat.name || "Group"}</div>

                {/* Tab bar */}
                <div className="chat-group-info__tab-bar">
                  {(["info", "photos", "links"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`chat-group-info__tab-btn pressable${groupInfoTab === tab ? " chat-group-info__tab-btn--active" : ""}`}
                      onClick={() => setGroupInfoTab(tab)}
                    >
                      {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="chat-group-info__tab-body">
                  {groupInfoTab === "info" && (
                    <>
                      {/* Member grid */}
                      <div className="chat-group-info__member-grid">
                        {activeGroupMembers.map((member) => (
                          <button
                            key={member.memberHex}
                            type="button"
                            className="chat-group-info__member-cell pressable"
                            onClick={() => {
                              setContactReturnView("group-info");
                              setContactView("detail");
                              setDmSearch("");
                              if (member.isSelf) {
                                setActiveContactId("profile");
                                setContactDetailOverride(null);
                              } else if (member.contactId) {
                                setActiveContactId(member.contactId);
                                setContactDetailOverride(null);
                              } else {
                                setActiveContactId(null);
                                setContactDetailOverride(member.detailContact);
                              }
                              setChatView("new-message");
                            }}
                          >
                            <div className={`chat-group-info__member-circle${member.picture ? " chat-group-info__member-circle--image" : ""}`}>
                              {member.picture ? (
                                <img src={member.picture} alt={member.label} className="chat-group-info__member-avatar-img" />
                              ) : (
                                <span>{contactInitials(member.label)}</span>
                              )}
                            </div>
                            <span className="chat-group-info__member-name">{member.label.split(" ")[0]}</span>
                          </button>
                        ))}
                        <button
                          type="button"
                          className="chat-group-info__member-cell pressable"
                          onClick={() => { setGroupMembersSearch(""); setChatView("group-members"); }}
                        >
                          <div className="chat-group-info__member-circle chat-group-info__member-circle--add">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </div>
                          <span className="chat-group-info__member-name">Add</span>
                        </button>
                      </div>
                      {/* Mute + leave */}
                      <div className="chat-group-info__card" style={{ margin: "0 1rem" }}>
                        <div className="chat-group-info__row">
                          <span className="chat-group-info__row-label">Mute</span>
                          <button
                            type="button"
                            className={`edit-toggle pressable${activeGroupMuted ? " is-on" : ""}`}
                            onClick={handleToggleActiveGroupMute}
                            aria-label={activeGroupMuted ? "Unmute group" : "Mute group"}
                            aria-pressed={activeGroupMuted}
                          >
                            <span className="edit-toggle__thumb" />
                          </button>
                        </div>
                        <button
                          type="button"
                          className={`chat-group-info__leave-button pressable${activeGroupLeft ? " chat-group-info__leave-button--join" : ""}`}
                          onClick={handleToggleActiveGroupMembership}
                        >
                          {activeGroupLeft ? "Join Group" : "Leave Group"}
                        </button>
                      </div>
                    </>
                  )}

                  {groupInfoTab === "photos" && (
                    groupMediaMessages.length === 0 ? (
                      <div className="chat-group-info__empty">No photos shared yet.</div>
                    ) : (
                      <div className="chat-group-info__photo-grid">
                        {groupMediaMessages.map((msg) => {
                          const att = msg.attachment as Extract<WalletDmAttachment, { type: "file" }>;
                          return (
                            <div key={msg.eventId} className="chat-group-info__photo-cell">
                              <MessengerFileBubble
                                descriptor={{
                                  url: att.url,
                                  mimeType: att.mimeType,
                                  filename: att.filename ?? undefined,
                                  size: att.size ?? undefined,
                                  width: att.width ?? undefined,
                                  height: att.height ?? undefined,
                                  algorithm: att.algorithm,
                                  keyHex: att.keyHex,
                                  nonceHex: att.nonceHex,
                                }}
                                isIncoming={msg.isIncoming}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}

                  {groupInfoTab === "links" && (
                    groupLinkMessages.length === 0 ? (
                      <div className="chat-group-info__empty">No links shared yet.</div>
                    ) : (
                      <div className="chat-group-info__links-grid">
                        {groupLinkMessages.flatMap(({ message, urls }) =>
                          urls.map((url, i) => {
                            const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
                            const pathSegments = (() => { try { return new URL(url).pathname.split("/").filter(Boolean); } catch { return []; } })();
                            const cardTitle = pathSegments.length > 0
                              ? decodeURIComponent(pathSegments[pathSegments.length - 1]).replace(/[-_]/g, " ").replace(/\.[^.]+$/, "")
                              : domain;
                            const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
                            return (
                              <a
                                key={`${message.eventId}-${i}`}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="chat-group-info__link-card pressable"
                              >
                                <div className="chat-group-info__link-card__preview">
                                  <img
                                    src={faviconUrl}
                                    alt=""
                                    className="chat-group-info__link-card__favicon"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }}
                                  />
                                </div>
                                <div className="chat-group-info__link-card__footer">
                                  <div className="chat-group-info__link-card__title">{cardTitle || domain}</div>
                                  <div className="chat-group-info__link-card__domain">{domain}</div>
                                </div>
                              </a>
                            );
                          })
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })()}

          {chatView === "group-members" && activeThread?.groupId && activeGroupChat && (
            <div className="chat-group-members">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => setChatView("group-info")}
                  aria-label="Back to group info"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  Members ({activeGroupMembers.length})
                </div>
                <div className="chat-conversation__header-spacer" aria-hidden="true" />
              </div>
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Search members"
                    value={groupMembersSearch}
                    onChange={(event) => setGroupMembersSearch(event.target.value)}
                  />
                  {groupMembersSearch.length > 0 && (
                    <button
                      type="button"
                      className="chat-page__search-clear pressable"
                      aria-label="Clear search"
                      title="Clear search"
                      onClick={() => setGroupMembersSearch("")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="chat-group-members__list">
                {filteredActiveGroupMembers.map((member) => (
                  <button
                    key={member.memberHex}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => openGroupMemberDetail(member.memberHex)}
                  >
                    <div className={`contact-avatar${member.picture ? " contact-avatar--image" : ""}`}>
                      {member.picture ? (
                        <img src={member.picture} alt={member.label} className="contact-avatar__img" />
                      ) : (
                        contactInitials(member.label)
                      )}
                    </div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{member.label}</div>
                      {member.subtitle && (
                        <div className="contact-row__meta">
                          <span className="contact-row__meta-text">{truncateContactValue(member.subtitle, 32)}</span>
                        </div>
                      )}
                    </div>
                    <span className="contact-row__chevron">&rsaquo;</span>
                  </button>
                ))}
                {filteredActiveGroupMembers.length === 0 && (
                  <div className="chat-page__empty">No members match your search.</div>
                )}
              </div>
            </div>
          )}

          {chatView === "group-name-edit" && activeThread?.groupId && activeGroupChat && (
            <div className="chat-group-name-edit">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    if (renameGroupBusy) return;
                    setChatView("group-info");
                  }}
                  aria-label="Back to group info"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">Edit Group Name</div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${renameGroupBusy || !renameGroupDraft.trim() ? " chat-page__header-action-text--disabled" : ""}`}
                  onClick={() => {
                    if (!renameGroupBusy && renameGroupDraft.trim()) {
                      void handleRenameGroupSubmit();
                    }
                  }}
                >
                  {renameGroupBusy ? "Saving…" : "Done"}
                </button>
              </div>
              <div className="chat-group-name-edit__body">
                <div className="chat-group-name-edit__title">Edit Group Name</div>
                <label className="chat-new-group__label">Group Name</label>
                <input
                  className="chat-group-name-edit__input"
                  value={renameGroupDraft}
                  onChange={(event) => setRenameGroupDraft(event.target.value)}
                  maxLength={100}
                  autoFocus
                  placeholder="Group Name"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renameGroupDraft.trim() && !renameGroupBusy) {
                      event.preventDefault();
                      void handleRenameGroupSubmit();
                    }
                  }}
                />
              </div>
            </div>
          )}

          {chatView === "new-message" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    if (contactView === "edit") {
                      if (contactEditDraft.isProfile) {
                        handleReturnToProfileCard();
                      } else {
                        handleCancelContactEdit();
                      }
                      return;
                    }
                    if (contactView === "detail") {
                      if (contactReturnView === "group-members") {
                        handleBackToContactsList();
                        return;
                      }
                      if (activeContactId === "profile") {
                        setChatView("threads");
                        setContactView("list");
                        setActiveContactId(null);
                        setContactDetailOverride(null);
                        setContactReturnView("new-message");
                        setDmSearch("");
                      } else {
                        handleBackToContactsList();
                      }
                      return;
                    }
                    setChatView("threads");
                    setContactView("list");
                    setActiveContactId(null);
                    setContactDetailOverride(null);
                    setContactReturnView("new-message");
                    setDmSearch("");
                  }}
                  aria-label={contactView === "edit" ? (contactEditDraft.isProfile ? "Back to profile" : "Cancel") : contactView === "detail" ? (contactReturnView === "group-members" ? "Back to members" : activeContactId === "profile" ? "Back to chats" : "Back to contacts") : "Back to chats"}
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  {contactView === "edit"
                    ? contactEditDraft.isProfile
                      ? "Edit My Card"
                      : contactEditDraft.id
                        ? "Edit Contact"
                        : "New Contact"
                    : contactView === "detail"
                      ? activeContactId === "profile"
                        ? "My Profile"
                        : "Contact"
                      : "New Message"}
                </div>
                {contactView === "list" ? (
                  <button
                    type="button"
                    className="glass-icon-button glass-icon-button--accent pressable"
                    onClick={handleStartAddContact}
                    title="Add contact"
                    aria-label="Add contact"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                ) : contactView === "detail" ? (
                  activeContactId === "profile" ? (
                    <button
                      className="glass-icon-button glass-icon-button--accent pressable"
                      onClick={handleStartEditCurrentContact}
                      aria-label="Edit profile"
                      title="Edit profile"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  ) : detailCanAddContact ? (
                    <button
                      type="button"
                      className="contact-pill contact-pill--accent contact-pill--compact pressable"
                      onClick={handleStartEditCurrentContact}
                    >
                      Add contact
                    </button>
                  ) : detailIsNostrContact ? (
                    detailContactCanFollow ? (
                      <button
                        type="button"
                        className="contact-pill contact-pill--accent contact-pill--compact pressable"
                        onClick={handleToggleFollowDetailContact}
                      >
                        {detailContactFollowed ? "Unfollow" : "Follow"}
                      </button>
                    ) : (
                      <div className="contacts-header-spacer" aria-hidden="true" />
                    )
                  ) : (
                    <button
                      type="button"
                      className="glass-icon-button glass-icon-button--accent pressable"
                      onClick={handleStartEditCurrentContact}
                      aria-label="Edit contact"
                      title="Edit contact"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="glass-icon-button glass-icon-button--accent pressable"
                    aria-label={contactEditDraft.isProfile ? "Save profile" : "Save contact"}
                    onClick={() => {
                      void handleContactEditSubmit();
                    }}
                    disabled={contactsPublishState === "publishing" || profileStatus === "publishing" || profilePhotoBusy}
                  >
                    <CheckIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
              {contactView === "list" && (
                <>
                  <div className="chat-page__search">
                    <div className="chat-page__search-shell">
                      <input
                        className="chat-page__search-input"
                        placeholder="Search contacts"
                        value={dmSearch}
                        onChange={(event) => setDmSearch(event.target.value)}
                      />
                      {dmSearch.length > 0 && (
                        <button
                          type="button"
                          className="chat-page__search-clear pressable"
                          aria-label="Clear search"
                          title="Clear search"
                          onClick={() => setDmSearch("")}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="chat-new-message__list">
                    <div className="chat-new-message__actions">
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={() => {
                          setScannerMessage("");
                          setShowScanner(true);
                        }}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="16" y="3" width="5" height="5" rx="1" /><rect x="3" y="16" width="5" height="5" rx="1" /><path d="M10 4h2" /><path d="M10 8h4" /><path d="M4 10v2" /><path d="M8 10v4" /><path d="M10 10h2" /><path d="M14 10v2" /><path d="M16 10h2" /><path d="M20 10v4" /><path d="M10 14h4" /><path d="M16 14h2" /><path d="M10 18v2" /><path d="M14 16v5" /><path d="M18 18h3" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">Scan QR</span>
                          <span className="chat-new-message__action-subtitle">Add a contact or start a chat from a code</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={() => {
                          setGroupSelectMembers(new Set());
                          setGroupNameDraft("");
                          setChatView("new-group-select");
                        }}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="4" /><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">New Group</span>
                          <span className="chat-new-message__action-subtitle">Create a private group chat</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={handleStartAddContact}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">Add contact</span>
                          <span className="chat-new-message__action-subtitle">Create a contact card manually</span>
                        </span>
                      </button>
                    </div>
                    <div className="chat-new-message__section-label">Contacts</div>
                    <button
                      type="button"
                      className="contact-row contact-row--profile pressable"
                      onClick={() => {
                        const normalized = normalizeNostrPubkey(myCardNpub);
                        const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                        if (hex) {
                          openConversationForPeer(hex);
                        } else {
                          setContactReturnView("new-message");
                          setActiveContactId("profile");
                          setContactDetailOverride(null);
                          setContactView("detail");
                        }
                      }}
                    >
                      <div className={`contact-avatar${profileCard.picture?.trim() ? " contact-avatar--image" : ""}`}>
                        {profileCard.picture?.trim() ? (
                          <img src={profileCard.picture.trim()} alt={myCardName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(myCardName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{myCardName}</div>
                        {myCardSubtitle && (
                          <div className="contact-row__meta">
                            <span className="contact-row__meta-text">{myCardSubtitle}</span>
                          </div>
                        )}
                      </div>
                      <span className="contact-row__chevron">&rsaquo;</span>
                    </button>
                    {sortedContacts
                      .filter((c) => {
                        if (!dmSearch.trim()) return true;
                        const hay = `${c.name} ${c.displayName || ""} ${c.username || ""} ${c.npub} ${c.nip05 || ""}`.toLowerCase();
                        return hay.includes(dmSearch.trim().toLowerCase());
                      })
                      .map((contact) => {
                        const contactLabel = contactDisplayLabel(contact);
                        const photo = contact.picture?.trim();
                        const subtitle = contact.nip05 || contact.npub || contact.address || "";
                        return (
                          <button
                            key={contact.id}
                            className="contact-row pressable"
                            onClick={() => {
                              const normalized = normalizeNostrPubkey(contact.npub || "");
                              const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                              if (hex && openConversationForPeer(hex)) {
                                return;
                              }
                              setContactReturnView("new-message");
                              setActiveContactId(contact.id);
                              setContactDetailOverride(null);
                              setContactView("detail");
                            }}
                          >
                            <div className={`contact-avatar${photo ? " contact-avatar--image" : ""}`}>
                              {photo ? (
                                <img src={photo} alt={contactLabel} className="contact-avatar__img" />
                              ) : (
                                contactInitials(contactLabel)
                              )}
                            </div>
                            <div className="contact-row__text">
                              <div className="contact-row__name">{contactLabel}</div>
                              {subtitle && (
                                <div className="contact-row__meta">
                                  <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                                </div>
                              )}
                            </div>
                            <span className="contact-row__chevron">&rsaquo;</span>
                          </button>
                        );
                      })}
                    {sortedContacts.length === 0 && (
                      <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "2rem 1rem" }}>
                        No contacts yet. Add one or scan a QR to start chatting.
                      </div>
                    )}
                  </div>
                </>
              )}
              {contactView !== "list" && (
                <div className="chat-new-message__list chat-new-message__list--detail">
                  <div ref={contactsPanelRef} className="contacts-shell" aria-busy={contactSyncState.status === "loading" || contactsPublishState === "publishing"}>
                    {contactView === "detail" && detailTarget && (
                      <div className="contact-detail-view">
                        <div className="contact-hero">
                          <div className="contact-hero__center">
                            <div className="contact-qr-wrapper">
                              {detailShareValue ? (
                                <QrCodeCard
                                  className="contact-qr-card"
                                  value={detailShareValue}
                                  label={detailTitle}
                                  size={200}
                                  flat
                                  hideLabel
                                  hideCopyButton
                                />
                              ) : (
                                <div className="contact-qr-placeholder text-secondary">No QR to share yet.</div>
                              )}
                            </div>
                            <div className={`contact-heading${detailTarget.picture ? "" : " contact-heading--text-only"}`}>
                              {detailTarget.picture && (
                                <img src={detailTarget.picture} alt={detailTitle} className="contact-portrait" />
                              )}
                              <div className="contact-heading__text">
                                <div className="flex items-center gap-2">
                                  <div className="contact-name-lg" title={detailTitle}>
                                    {truncateContactName(detailTitle, 34)}
                                  </div>
                                  {activeContactId === "profile" && profileCard.npub && (
                                    <button
                                      type="button"
                                      className="contact-pill contact-pill--circle pressable"
                                      title="Share your npub"
                                      onClick={() => {
                                        setShareContactSource({ ...profileCard, relays: defaultNostrRelays } as Contact);
                                        setShareContactStatus(null);
                                        setShareContactPickerMode("recipient");
                                        setShareContactPickerOpen(true);
                                      }}
                                    >
                                      <ShareArrowIcon className="contact-pill__icon" />
                                    </button>
                                  )}
                                </div>
                                {detailUsername && (
                                  <div className="contact-username" title={detailUsername}>
                                    {truncateContactValue(detailUsername, 33)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>

                        {activeContact && (detailHasLightning || detailCanShare) && (
                          <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                            {detailHasLightning && (
                              <button
                                type="button"
                                className="contact-pill pressable"
                                onClick={() => {
                                  applyLightningContact(activeContact);
                                  setContactsTabOpen(false);
                                }}
                              >
                                Pay lightning
                              </button>
                            )}
                            {detailCanShare && (
                              <button
                                type="button"
                                className="contact-pill pressable"
                                onClick={() => {
                                  openEcashSendToContact(activeContact);
                                  setContactsTabOpen(false);
                                }}
                              >
                                Pay eCash
                              </button>
                            )}
                            {detailCanShare && (
                              <button
                                type="button"
                                className="contact-pill contact-pill--circle pressable"
                                title="Share contact"
                                onClick={() => {
                                  setShareContactSource(activeContact);
                                  setShareContactStatus(null);
                                  setShareContactPickerMode("recipient");
                                  setShareContactPickerOpen(true);
                                }}
                              >
                                <ShareArrowIcon className="contact-pill__icon" />
                              </button>
                            )}
                          </div>
                        )}

                        <div className="contact-fields">
                          {detailFields.length ? (
                            detailFields.map((field) => {
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
                                    <span className={`contact-field__text${field.multiline ? " contact-field__text--multiline" : ""}`}>
                                      {field.multiline ? field.value : truncateContactValue(field.value, 36)}
                                    </span>
                                    {isNip05Field && detailNip05Verified && (
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

                        {activeContact && (
                          <div className="contact-actions-row">
                            <button
                              type="button"
                              className="contact-pill contact-pill--danger pressable"
                              onClick={() => {
                                if (window.confirm("Remove this contact?")) {
                                  handleDeleteContact(activeContact.id);
                                  setContactView("list");
                                  setActiveContactId(null);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {contactView === "detail" && !detailTarget && (
                      <div className="contact-empty text-secondary">
                        Contact not found.{" "}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-primary underline"
                          onClick={handleBackToContactsList}
                        >
                          Go back
                        </button>
                      </div>
                    )}

                    {contactView === "edit" &&
            (() => {
              const profilePhoto = contactEditDraft.picture.trim();
              const profileInitials =
                contactEditDraft.displayName ||
                contactEditDraft.name ||
                contactEditDraft.username ||
                myCardName;
              const showContactFields = contactEditDraft.isProfile || showCustomContactFields;

              return (
                <form
                  id="contact-edit-form"
                  className="contact-edit-view"
                  onSubmit={(event) => event.preventDefault()}
                >
                  {contactEditDraft.isProfile ? (
                    <div className="contact-photo-card">
                      <div className="contact-photo-title">Profile photo</div>
                      <div className="contact-photo-body">
                        <div
                          className={
                            profilePhoto
                              ? "contact-avatar contact-avatar--image contact-avatar--xl"
                              : "contact-avatar contact-avatar--xl"
                          }
                        >
                          {profilePhoto ? (
                            <img src={profilePhoto} alt={profileInitials} className="contact-avatar__img" />
                          ) : (
                            contactInitials(profileInitials)
                          )}
                        </div>
                        <div className="contact-photo-actions">
                          <button
                            type="button"
                            className="accent-button pressable contact-photo-upload"
                            onClick={() => {
                              setProfilePhotoError("");
                              profilePhotoInputRef.current?.click();
                            }}
                            disabled={profilePhotoBusy}
                          >
                            {profilePhotoBusy ? "Processing…" : profilePhoto ? "Replace photo" : "Upload photo"}
                          </button>
                          {profilePhoto && (
                            <button
                              type="button"
                              className="ghost-button button-sm pressable contact-photo-remove"
                              onClick={handleClearProfilePhoto}
                              disabled={profilePhotoBusy}
                            >
                              Remove photo
                            </button>
                          )}
                        </div>
                        <input
                          ref={profilePhotoInputRef}
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={handleProfilePhotoChange}
                        />
                        {profilePhotoError && <div className="contact-error">{profilePhotoError}</div>}
                      </div>
                    </div>
                  ) : (
                    <div className="contact-import-card">
                      <div className="contact-import-title">Import from npub / NIP-05</div>
                      <div className="contact-import-actions contact-import-actions--top">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable contact-import-scan"
                          onClick={() => {
                            setShowScanner(true);
                          }}
                        >
                          Scan QR
                        </button>
                        <button
                          type="button"
                          className="ghost-button button-sm pressable contact-custom-toggle"
                          onClick={() => setShowCustomContactFields((prev) => !prev)}
                        >
                          {showCustomContactFields ? "Hide custom fields" : "Custom contact"}
                        </button>
                        {publicFollowOptions.length > 0 && (
                          <button
                            type="button"
                            className="ghost-button button-sm pressable contact-import-follow"
                            onClick={() => setPublicFollowPickerOpen(true)}
                          >
                            Pick from follows
                          </button>
                        )}
                      </div>
                      <div className="contact-import-row">
                        <input
                          className="contact-edit-input contact-import-input"
                          placeholder="npub1… or name@example.com"
                          value={contactLookupInput}
                          onChange={(e) => setContactLookupInput(e.target.value)}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="accent-button pressable contact-import-button"
                          onClick={async () => {
                            await handleContactImportAction();
                          }}
                          disabled={contactLookupBusy}
                        >
                          {contactLookupBusy ? "…" : contactLookupInput.trim() ? "Import" : "Paste"}
                        </button>
                      </div>
                      {contactLookupError && <div className="contact-error">{contactLookupError}</div>}
                    </div>
                  )}

                  {showContactFields && (
                    <div className="contact-edit-grid">
                      {!contactEditDraft.isProfile && (
                        <input
                          className="contact-edit-input"
                          placeholder="Nickname"
                          value={contactEditDraft.name}
                          onChange={(e) => setContactEditDraft((prev) => ({ ...prev, name: e.target.value }))}
                        />
                      )}
                      <input
                        className="contact-edit-input"
                        placeholder="Display name"
                        value={contactEditDraft.displayName}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, displayName: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="Username"
                        value={contactEditDraft.username}
                        onChange={(e) => {
                          const sanitized = sanitizeUsername(e.target.value);
                          setContactEditDraft((prev) => ({ ...prev, username: sanitized }));
                        }}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="Lightning address"
                        autoComplete="off"
                        value={contactEditDraft.address}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, address: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="npub or hex pubkey"
                        autoComplete="off"
                        value={contactEditDraft.npub}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, npub: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="NIP-05 (name@example.com)"
                        autoComplete="off"
                        value={contactEditDraft.nip05}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, nip05: e.target.value }))}
                      />
                      <textarea
                        className="contact-edit-input contact-edit-textarea"
                        rows={3}
                        placeholder="About"
                        value={contactEditDraft.about}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, about: e.target.value }))}
                      />
                    </div>
                  )}

                  <div className="contact-edit-note text-secondary">
                    Saving publishes your updates to Nostr (contacts stay encrypted).
                  </div>

                  {contactEditError && <div className="contact-error">{contactEditError}</div>}
                </form>
              );
            })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── New Group: Member Selection ──────────────────────────────── */}
          {chatView === "new-group-select" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    setChatView("new-message");
                    setGroupSelectMembers(new Set());
                  }}
                  aria-label="Back"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  New Group ({groupSelectMembers.size}/{MAX_GROUP_MEMBERS})
                </div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${groupSelectMembers.size < 2 ? " chat-page__header-action-text--disabled" : ""}`}
                  disabled={groupSelectMembers.size < 2}
                  onClick={() => {
                    if (groupSelectMembers.size >= 2) {
                      setChatView("new-group-name");
                    }
                  }}
                >
                  Next
                </button>
              </div>
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Who would you like to add?"
                    value={dmSearch}
                    onChange={(event) => setDmSearch(event.target.value)}
                  />
                  {dmSearch.length > 0 && (
                    <button
                      type="button"
                      className="chat-page__search-clear pressable"
                      aria-label="Clear search"
                      onClick={() => setDmSearch("")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="chat-new-message__list">
                {(() => {
                  const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                  // Group contacts by first letter
                  const filteredContacts = sortedContacts.filter((c) => {
                    const hex = (() => {
                      const normalized = normalizeNostrPubkey(c.npub || "");
                      return normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                    })();
                    // Skip self
                    if (hex === ownHex) return false;
                    // Must have a valid nostr pubkey
                    if (!hex) return false;
                    if (!dmSearch.trim()) return true;
                    const hay = `${c.name} ${c.displayName || ""} ${c.username || ""} ${c.npub} ${c.nip05 || ""}`.toLowerCase();
                    return hay.includes(dmSearch.trim().toLowerCase());
                  });
                  // Group by first letter
                  const groups = new Map<string, typeof filteredContacts>();
                  filteredContacts.forEach((c) => {
                    const label = contactDisplayLabel(c);
                    const letter = (label[0] || "#").toUpperCase();
                    const group = groups.get(letter) || [];
                    group.push(c);
                    groups.set(letter, group);
                  });
                  const sortedLetters = [...groups.keys()].sort();
                  return sortedLetters.map((letter) => (
                    <React.Fragment key={letter}>
                      <div className="chat-new-message__section-label">{letter}</div>
                      {groups.get(letter)!.map((contact) => {
                        const contactLabel = contactDisplayLabel(contact);
                        const photo = contact.picture?.trim();
                        const normalized = normalizeNostrPubkey(contact.npub || "");
                        const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                        const subtitle = contact.nip05 || (hex ? `${nip19.npubEncode(hex).slice(0, 12)}...${nip19.npubEncode(hex).slice(-6)}` : "");
                        const isSelected = hex ? groupSelectMembers.has(hex) : false;
                        return (
                          <button
                            key={contact.id}
                            className={`contact-row contact-row--selectable pressable${isSelected ? " contact-row--selected" : ""}`}
                            onClick={() => {
                              if (!hex) return;
                              setGroupSelectMembers((prev) => {
                                const next = new Set(prev);
                                if (next.has(hex)) {
                                  next.delete(hex);
                                } else if (next.size < MAX_GROUP_MEMBERS - 1) {
                                  // -1 because self is always included
                                  next.add(hex);
                                }
                                return next;
                              });
                            }}
                          >
                            <div className={`contact-avatar${photo ? " contact-avatar--image" : ""}`}>
                              {photo ? (
                                <img src={photo} alt={contactLabel} className="contact-avatar__img" />
                              ) : (
                                contactInitials(contactLabel)
                              )}
                            </div>
                            <div className="contact-row__text">
                              <div className="contact-row__name">{contactLabel}</div>
                              {subtitle && (
                                <div className="contact-row__meta">
                                  <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                                </div>
                              )}
                            </div>
                            <div className={`contact-row__checkbox${isSelected ? " contact-row__checkbox--checked" : ""}`}>
                              {isSelected && (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </React.Fragment>
                  ));
                })()}
                {sortedContacts.length === 0 && (
                  <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "2rem 1rem" }}>
                    No contacts yet. Add contacts first to create a group.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── New Group: Name & Create ─────────────────────────────────── */}
          {chatView === "new-group-name" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => setChatView("new-group-select")}
                  aria-label="Back"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  New Group ({groupSelectMembers.size + 1})
                </div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${!groupNameDraft.trim() ? " chat-page__header-action-text--disabled" : ""}`}
                  disabled={!groupNameDraft.trim()}
                  onClick={() => {
                    const name = groupNameDraft.trim();
                    if (!name) return;
                    const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                    const allMembers = [...new Set([ownHex, ...groupSelectMembers])].filter(Boolean).sort();
                    const groupId = generateGroupId(allMembers);
                    const createdAt = Math.floor(Date.now() / 1000);
                    const group: GroupChat = {
                      groupId,
                      name,
                      members: allMembers,
                      createdAt,
                      nameUpdatedAt: createdAt,
                    };
                    upsertGroupChat(group);
                    // Open the group conversation
                    openConversationForGroup(groupId);
                    setGroupSelectMembers(new Set());
                    setGroupNameDraft("");
                    setDmSearch("");
                  }}
                >
                  Create
                </button>
              </div>
              <div className="chat-new-group__form">
                <div className="chat-new-group__name-section">
                  <label className="chat-new-group__label">Group Name</label>
                  <input
                    className="chat-new-group__name-input"
                    placeholder="Please Enter a Group Name"
                    value={groupNameDraft}
                    onChange={(e) => setGroupNameDraft(e.target.value)}
                    maxLength={100}
                    autoFocus
                  />
                </div>
                <div className="chat-new-group__members-section">
                  <label className="chat-new-group__label">Members</label>
                  {(() => {
                    const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                    const memberHexes = [ownHex, ...Array.from(groupSelectMembers)].filter(Boolean);
                    return memberHexes.map((hex) => {
                      const isOwn = hex === ownHex;
                      const meta = isOwn
                        ? { label: myCardName, picture: profileCard.picture?.trim() || undefined }
                        : peerLabelFor(hex);
                      const npubShort = (() => {
                        try {
                          const full = nip19.npubEncode(hex);
                          return `${full.slice(0, 12)}...${full.slice(-6)}`;
                        } catch { return ""; }
                      })();
                      return (
                        <div key={hex} className="contact-row">
                          <div className={`contact-avatar${meta.picture ? " contact-avatar--image" : ""}`}>
                            {meta.picture ? (
                              <img src={meta.picture} alt={meta.label} className="contact-avatar__img" />
                            ) : (
                              contactInitials(meta.label)
                            )}
                          </div>
                          <div className="contact-row__text">
                            <div className="contact-row__name">{meta.label}</div>
                            {npubShort && (
                              <div className="contact-row__meta">
                                <span className="contact-row__meta-text">{npubShort}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}

        </div>
      )}
      {receiveMode === "ecash" && (
        <Suspense fallback={null}>
          <EcashReceiveSheet
        receiveMode={receiveMode}
        closeReceiveEcashSheet={closeReceiveEcashSheet}
        openReceiveLightningSheet={openReceiveLightningSheet}
        ecashReceiveView={ecashReceiveView}
        paymentRequestsEnabled={paymentRequestsEnabled}
        overviewPaymentRequest={overviewPaymentRequest}
        handleOpenEcashRequestAmountView={handleOpenEcashRequestAmountView}
        handleOpenReceiveLock={handleOpenReceiveLock}
        paymentRequestStatusMessage={paymentRequestStatusMessage}
        paymentRequestError={paymentRequestError}
        nostrMissingReason={nostrMissingReason}
        handlePasteEcashClipboard={handlePasteEcashClipboard}
        recvMsg={recvMsg}
        mintSelectionOptions={mintSelectionOptions}
        selectedMintValue={selectedMintValue}
        setMintUrl={setMintUrl}
        mintInfoByUrl={mintInfoByUrl}
        selectedMintLabel={selectedMintLabel}
        selectedMintBalanceLabel={selectedMintBalanceLabel}
        canToggleCurrency={canToggleCurrency}
        handleLightningAmountUnitToggle={handleLightningAmountUnitToggle}
        ecashRequestPrimaryAmountText={ecashRequestPrimaryAmountText}
        ecashRequestSecondaryAmountText={ecashRequestSecondaryAmountText}
        ecashRequestMode={ecashRequestMode}
        handleSetEcashRequestMode={handleSetEcashRequestMode}
        primaryCurrency={primaryCurrency}
        handleEcashRequestKeypadInput={handleEcashRequestKeypadInput}
        canCreateEcashRequest={canCreateEcashRequest}
        handleCreateEcashRequest={handleCreateEcashRequest}
        lastCreatedEcashRequest={lastCreatedEcashRequest}
        satFormatter={satFormatter}
        formatSatAmount={formatSatAmount}
        walletConversionEnabled={walletConversionEnabled}
        btcUsdPrice={btcUsdPrice}
        formatUsdAmount={formatUsdAmount}
        mintUrl={mintUrl}
        ensureOpenPaymentRequest={ensureOpenPaymentRequest}
        setLastCreatedEcashRequest={setLastCreatedEcashRequest}
        setEcashReceiveView={setEcashReceiveView}
          />
        </Suspense>
      )}

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

      {receiveMode === "lightning" && (
        <Suspense fallback={null}>
          <LightningReceiveSheet
        receiveMode={receiveMode}
        closeReceiveLightningSheet={closeReceiveLightningSheet}
        openReceiveEcashSheet={openReceiveEcashSheet}
        lightningReceiveView={lightningReceiveView}
        lightningAddressProvider={activeLightningAddressProvider}
        npubCashLightningAddressEnabled={lightningAddressEnabled}
        npubCashClaimEnabled={npubCashClaimEnabled}
        npubCashIdentity={npubCashIdentity}
        npubCashClaimStatus={npubCashClaimStatus}
        handleClaimNpubCash={handleClaimNpubCash}
        handleCopyLightningAddress={handleCopyLightningAddress}
        lightningAddressDisplay={lightningAddressDisplay}
        npubCashClaimMessage={npubCashClaimMessage}
        npubCashIdentityError={npubCashIdentityError}
        handleOpenLightningAmountView={handleOpenLightningAmountView}
        mintSelectionOptions={mintSelectionOptions}
        selectedMintValue={selectedMintValue}
        setMintUrl={setMintUrl}
        mintInfoByUrl={mintInfoByUrl}
        selectedMintLabel={selectedMintLabel}
        selectedMintBalanceLabel={selectedMintBalanceLabel}
        canToggleCurrency={canToggleCurrency}
        handleLightningAmountUnitToggle={handleLightningAmountUnitToggle}
        lightningPrimaryAmountText={lightningPrimaryAmountText}
        lightningSecondaryAmountText={lightningSecondaryAmountText}
        primaryCurrency={primaryCurrency}
        handleLightningAmountKeypadInput={handleLightningAmountKeypadInput}
        handleCreateInvoice={handleCreateInvoice}
        canCreateMintInvoice={canCreateMintInvoice}
        creatingMintInvoice={creatingMintInvoice}
        mintError={mintError}
        mintQuote={mintQuote}
        activeMintInvoice={activeMintInvoice}
        handleLightningInvoiceBack={handleLightningInvoiceBack}
        lightningInvoiceStatusLabel={lightningInvoiceStatusLabel}
        satFormatter={satFormatter}
        formatSatAmount={formatSatAmount}
        invoiceAmountSecondary={invoiceAmountSecondary}
        mintUrl={mintUrl}
          />
        </Suspense>
      )}

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

      <ActionSheet
        open={contactsOpen && contactsContext !== null}
        onClose={closeContactsSheet}
        title={contactsContext === "ecash" ? "eCash contacts" : "Lightning contacts"}
        stackLevel={60}
      >
        {contactsContext && (
          <div className="wallet-section space-y-3 text-sm">
            {contactsPanelContent(contactsContext)}
          </div>
        )}
      </ActionSheet>

      {contactsPanelOpen && (
        <Suspense fallback={null}>
          <WalletContactsSheet
        contactsPanelOpen={contactsPanelOpen}
        closeContactsTab={closeContactsTab}
        contactsHeader={contactsHeader}
        contactsPanelInline={contactsPanelInline}
        contactsPanelRef={contactsPanelRef}
        contactSyncState={contactSyncState}
        contactsPublishState={contactsPublishState}
        contactView={contactView}
        sortedContacts={sortedContacts}
        profileCard={profileCard}
        myCardName={myCardName}
        myCardSubtitle={myCardSubtitle}
        normalizeNip05={normalizeNip05}
        isNip05VerifiedFor={isNip05VerifiedFor}
        contactInitials={contactInitials}
        setActiveContactId={setActiveContactId}
        setContactView={setContactView}
        detailTarget={detailTarget}
        detailShareValue={detailShareValue}
        detailTitle={detailTitle}
        detailFields={detailFields}
        detailNip05Verified={detailNip05Verified}
        activeContact={activeContact}
        activeContactId={activeContactId}
        detailHasLightning={detailHasLightning}
        detailCanShare={detailCanShare}
        detailUsername={detailUsername}
        truncateContactName={truncateContactName}
        truncateContactValue={truncateContactValue}
        applyLightningContact={applyLightningContact}
        setContactsTabOpen={setContactsTabOpen}
        openEcashSendToContact={openEcashSendToContact}
        setShareContactSource={setShareContactSource}
        setShareContactStatus={setShareContactStatus}
        setShareContactPickerMode={setShareContactPickerMode}
        setShareContactPickerOpen={setShareContactPickerOpen}
        defaultNostrRelays={defaultNostrRelays}
        handleDeleteContact={handleDeleteContact}
        publicFollowOptions={publicFollowOptions}
        setPublicFollowPickerOpen={setPublicFollowPickerOpen}
        showCustomContactFields={showCustomContactFields}
        setShowCustomContactFields={setShowCustomContactFields}
        contactEditDraft={contactEditDraft}
        setContactEditDraft={setContactEditDraft}
        sanitizeUsername={sanitizeUsername}
        contactLookupInput={contactLookupInput}
        setContactLookupInput={setContactLookupInput}
        contactLookupBusy={contactLookupBusy}
        handleContactImportAction={handleContactImportAction}
        contactLookupError={contactLookupError}
        contactEditError={contactEditError}
        handleProfilePhotoChange={handleProfilePhotoChange}
        handleClearProfilePhoto={handleClearProfilePhoto}
        profilePhotoBusy={profilePhotoBusy}
        profilePhotoError={profilePhotoError}
        profilePhotoInputRef={profilePhotoInputRef}
        setProfilePhotoError={setProfilePhotoError}
        setShowScanner={setShowScanner}
        contactSubtitle={contactSubtitle}
        handleCopyContactField={handleCopyContactField}
          />
        </Suspense>
      )}

      <ActionSheet
        open={publicFollowPickerOpen}
        onClose={() => setPublicFollowPickerOpen(false)}
        title="Import from follows"
        stackLevel={75}
      >
        <div className="wallet-section space-y-3 text-sm">
          {publicFollowOptions.length ? (
            <div className="contact-list">
              {publicFollowOptions.map((follow) => {
                const formattedUsername = follow.username ? formatContactUsername(follow.username) : "";
                const nip05Label = follow.nip05 || "";
                const label = follow.petname || nip05Label || formattedUsername || follow.npub;
                const subtitle =
                  nip05Label || formattedUsername || follow.relay || follow.npub;
                return (
                  <button
                    key={follow.pubkey}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => {
                      void handleImportPublicFollow(follow.npub);
                    }}
                  >
                    <div className="contact-avatar">{contactInitials(label)}</div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{truncateContactName(label)}</div>
                      <div className="contact-row__meta">
                        <span className="contact-row__meta-text">{truncateContactValue(subtitle)}</span>
                      </div>
                    </div>
                    <span className="contact-chevron">›</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-secondary">No public follows found yet. Sync contacts to load your follows.</div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet
        open={profileEditorOpen}
        onClose={() => setProfileEditorOpen(false)}
        title="Edit profile"
        stackLevel={80}
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs text-secondary uppercase tracking-wide">Profile</div>
              <div className="font-semibold text-primary">Update your info</div>
            </div>
            <div className="text-right text-[11px] text-secondary">
              {profileStatus === "publishing"
                ? "Publishing…"
                : profileStatus === "loading"
                  ? "Loading…"
                  : profileUpdatedAt
                    ? `Updated ${new Date(profileUpdatedAt).toLocaleString()}`
                    : "Draft"}
            </div>
          </div>
          <div className="grid gap-2">
            <input
              className="pill-input"
              placeholder="Username"
              value={profileForm.username}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, username: e.target.value }))}
              autoComplete="username"
            />
            <input
              className="pill-input"
              placeholder="Display name"
              value={profileForm.displayName}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, displayName: e.target.value }))}
              autoComplete="name"
            />
            <input
              className="pill-input"
              placeholder="Lightning address"
              value={profileForm.lud16}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, lud16: e.target.value }))}
              autoComplete="off"
            />
            <input
              className="pill-input"
              placeholder="NIP-05 (name@example.com)"
              value={profileForm.nip05}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, nip05: e.target.value }))}
              autoComplete="off"
            />
            <textarea
              className="pill-textarea"
              rows={2}
              placeholder="About (optional)"
              value={profileForm.about}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, about: e.target.value }))}
            />
          </div>
          {profileMessage && (
            <div className={`text-[11px] ${profileStatus === "error" ? "text-rose-400" : "text-secondary"}`}>
              {profileMessage}
            </div>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              className="accent-button button-sm pressable"
              type="button"
              onClick={() => {
                void publishProfileMetadata();
              }}
              disabled={profileStatus === "publishing" || profileStatus === "loading"}
            >
              {profileStatus === "publishing" ? "Publishing…" : "Save & publish"}
            </button>
            <button
              className="ghost-button button-sm pressable"
              type="button"
              onClick={() => {
                void loadProfileMetadata();
              }}
              disabled={profileStatus === "loading"}
            >
              Refresh
            </button>
          </div>
          {profileShareValue && (
            <div className="flex flex-col items-center gap-2">
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={profileShareValue}
                label="Your profile"
                copyLabel="Copy profile"
                size={200}
              />
              <div className="text-[11px] text-secondary text-center">
                Share to add you, pay lightning, or send eCash via Nostr.
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

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
                  {contactHasLightning(scannedContact) && (
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
                  {scannedContactCanShare && (
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
                  {scannedContactCanShare && (
                    <button
                      type="button"
                      className="contact-pill contact-pill--circle pressable"
                      title="Share contact"
                      onClick={() => {
                        setShareContactSource(scannedContact);
                        setShareContactStatus(null);
                        setShareContactPickerMode("recipient");
                        setShareContactPickerOpen(true);
                      }}
                    >
                      <ShareArrowIcon className="contact-pill__icon" />
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

        <ActionSheet
          open={!!sharedContactPreview}
          onClose={() => setSharedContactPreview(null)}
          header={sharedContactPreviewHeader}
          stackLevel={76}
        >
          {sharedContactPreviewContact && (
            <div className="contact-detail-view">
              <div className="contact-hero">
                <div className="contact-hero__center">
                  <div className="contact-qr-wrapper">
                    {sharedContactPreviewShareValue ? (
                      <QrCodeCard
                        className="contact-qr-card"
                        value={sharedContactPreviewShareValue}
                        label={sharedContactPreviewTitle}
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
                    className={`contact-heading${sharedContactPreviewContact.picture ? "" : " contact-heading--text-only"}`}
                  >
                    {sharedContactPreviewContact.picture && (
                      <img
                        src={sharedContactPreviewContact.picture}
                        alt={sharedContactPreviewTitle}
                        className="contact-portrait"
                      />
                    )}
                    <div className="contact-heading__text">
                      <div className="contact-name-lg" title={sharedContactPreviewTitle}>
                        {truncateContactName(sharedContactPreviewTitle, 34)}
                      </div>
                      {sharedContactPreviewUsername && (
                        <div className="contact-username" title={sharedContactPreviewUsername}>
                          {truncateContactValue(sharedContactPreviewUsername, 33)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {(contactHasLightning(sharedContactPreviewContact) || sharedContactPreviewCanShare) && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {contactHasLightning(sharedContactPreviewContact) && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        applyLightningContact(sharedContactPreviewContact);
                        setSharedContactPreview(null);
                      }}
                    >
                      Pay lightning
                    </button>
                  )}
                  {sharedContactPreviewCanShare && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        openEcashSendToContact(sharedContactPreviewContact);
                        setSharedContactPreview(null);
                      }}
                    >
                      Pay eCash
                    </button>
                  )}
                  {sharedContactPreviewCanShare && (
                    <button
                      type="button"
                      className="contact-pill contact-pill--circle pressable"
                      title="Share contact"
                      onClick={() => {
                        setShareContactSource(sharedContactPreviewContact);
                        setShareContactStatus(null);
                        setShareContactPickerMode("recipient");
                        setShareContactPickerOpen(true);
                      }}
                    >
                      <ShareArrowIcon className="contact-pill__icon" />
                    </button>
                  )}
                </div>
              )}

              <div className="contact-fields">
                {sharedContactPreviewFields.length ? (
                  sharedContactPreviewFields.map((field) => {
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
                          {isNip05Field && sharedContactPreviewNip05Verified && (
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

      <ActionSheet
        open={shareContactPickerOpen}
        onClose={() => {
          if (shareContactBusy) return;
          setShareContactPickerOpen(false);
          setShareContactPickerMode("recipient");
          setShareContactSource(null);
          setShareContactStatus(null);
        }}
        title="Send contact"
        stackLevel={90}
      >
        {shareContactPickerMode === "chat-source" ? (
          <>
            <div className="text-sm text-secondary mb-2">Choose a contact card to send into this conversation.</div>
            {shareContactStatus && <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>}
            {chatAttachContactOptions.length ? (
              <div className="space-y-2">
                {chatAttachContactOptions.map((contact) => {
                  const label = contactPrimaryName(contact);
                  const subtitle = formatContactNpub(contact.npub) || formatContactUsername(contact.username);
                  const picture = contact.picture?.trim();
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      disabled={shareContactBusy}
                      onClick={() => {
                        void handleSendChatContactAttachment(contact);
                      }}
                    >
                      <div className={`contact-avatar${picture ? " contact-avatar--image" : ""}`}>
                        {picture ? (
                          <img src={picture} alt={label} className="contact-avatar__img" />
                        ) : (
                          contactInitials(label)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{label}</div>
                        {subtitle ? (
                          <div className="contact-row__meta">
                            <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                          </div>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-secondary">Add a contact with a valid npub first.</div>
            )}
          </>
        ) : (
          <>
            {shareContactSource ? (
              <div className="text-sm text-secondary mb-2">
                Send <span className="font-semibold">{contactPrimaryName(shareContactSource)}</span> to a contact.
              </div>
            ) : (
              <div className="text-sm text-secondary mb-2">Choose who to send this contact to.</div>
            )}
            {shareContactStatus && <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>}
            {shareRecipientOptions.length ? (
              <div className="space-y-2">
                {shareRecipientOptions.map((contact) => {
                  const label = contactPrimaryName(contact);
                  const subtitle = formatContactNpub(contact.npub);
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      disabled={shareContactBusy}
                      onClick={() => handleShareContactToContact(contact)}
                    >
                      <div className="contact-avatar">{contactInitials(label)}</div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{label}</div>
                        {subtitle ? (
                          <div className="contact-row__meta">
                            <span className="contact-row__meta-text">{subtitle}</span>
                          </div>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-secondary">Add another contact with an npub to share to.</div>
            )}
          </>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareContactBusy) return;
              setShareContactPickerOpen(false);
              setShareContactPickerMode("recipient");
              setShareContactSource(null);
              setShareContactStatus(null);
            }}
            disabled={shareContactBusy}
          >
            Cancel
          </button>
        </div>
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
                placeholder="https://mint.solife.me"
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
        showNwcManager={showNwcManager}
        closeNwcManager={closeNwcManager}
        hasNwcConnection={hasNwcConnection}
        nwcAlias={nwcAlias}
        nwcConnection={nwcConnection}
        nwcInfo={nwcInfo}
        nwcBalanceSats={nwcBalanceSats}
        nwcStatusLabel={nwcStatusLabel}
        nwcUrlInput={nwcUrlInput}
        setNwcUrlInput={setNwcUrlInput}
        nwcBusy={nwcBusy}
        nwcFeedback={nwcFeedback}
        nwcError={nwcError}
        formatSatAmount={formatSatAmount}
        handleNwcConnect={handleNwcConnect}
        handleNwcTest={handleNwcTest}
        handleNwcDisconnect={handleNwcDisconnect}
          />
        </Suspense>
      )}

      {/* ── Message action overlay (long-press menu) ── */}
      {dmMessageActions && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmMessageActions(null); }}
        >
          <div className="dm-action-panel">
            <div className="dm-action-panel__reactions">
              {["❤️", "👍", "👎", "😂", "😮", "😢"].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="dm-action-panel__reaction pressable"
                  onClick={() => { void handleSendReaction(dmMessageActions.msg, emoji); setDmMessageActions(null); }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="dm-action-panel__list">
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setReplyToMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>
                Reply
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setDmForwardMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>
                Forward
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { void copyMessageValue(dmMessageActions.copyValue, "Message"); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                Copy
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setDmInfoMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Info
              </button>
              <button
                type="button"
                className="dm-action-panel__item dm-action-panel__item--danger pressable"
                onClick={() => handleDeleteDmMessage(dmMessageActions.eventId)}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reaction detail sheet ── */}
      {dmReactionDetail && (() => {
        const reactions = dmReactions.get(dmReactionDetail.eventId) || [];
        const grouped = new Map<string, DmReaction[]>();
        for (const r of reactions) {
          const arr = grouped.get(r.emoji) || [];
          arr.push(r);
          grouped.set(r.emoji, arr);
        }
        return (
          <div
            className="dm-action-overlay"
            onPointerDown={(e) => { if (e.target === e.currentTarget) setDmReactionDetail(null); }}
          >
            <div className="dm-info-panel">
              <div className="dm-info-panel__header">
                <span className="dm-info-panel__title">Reactions</span>
                <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmReactionDetail(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              {Array.from(grouped.entries()).map(([emoji, reactors]) => (
                <div key={emoji} className="dm-reaction-detail__group">
                  <div className="dm-reaction-detail__emoji">{emoji}</div>
                  <div className="dm-reaction-detail__reactors">
                    {reactors.map((r) => {
                      const rp = dmPeerProfilesRef.current.get(r.senderPubkey);
                      const label = rp?.displayName || rp?.name || r.senderPubkey.slice(0, 12) + "…";
                      return (
                        <div key={r.senderPubkey} className="dm-reaction-detail__reactor">
                          <div className="dm-reaction-detail__reactor-avatar">
                            {rp?.picture
                              ? <img src={rp.picture} alt={label} className="contact-avatar__img" />
                              : contactInitials(label)}
                          </div>
                          <span className="dm-reaction-detail__reactor-name">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Info modal ── */}
      {dmInfoMessage && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmInfoMessage(null); }}
        >
          <div className="dm-info-panel">
            <div className="dm-info-panel__header">
              <span className="dm-info-panel__title">Message Info</span>
              <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmInfoMessage(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Time</span>
              <span className="dm-info-panel__value">{new Date(dmInfoMessage.createdAt * 1000).toLocaleString()}</span>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Direction</span>
              <span className="dm-info-panel__value">{dmInfoMessage.isIncoming ? "Received" : "Sent"}</span>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Event ID</span>
              <button
                type="button"
                className="dm-info-panel__value dm-info-panel__value--mono dm-info-panel__value--tap pressable"
                onClick={() => void navigator.clipboard.writeText(dmInfoMessage.eventId)}
                title="Tap to copy"
              >
                {dmInfoMessage.eventId.slice(0, 20)}…
              </button>
            </div>
            {dmInfoMessage.senderPubkey && (
              <div className="dm-info-panel__row">
                <span className="dm-info-panel__label">Sender</span>
                <button
                  type="button"
                  className="dm-info-panel__value dm-info-panel__value--mono dm-info-panel__value--tap pressable"
                  onClick={() => void navigator.clipboard.writeText(dmInfoMessage.senderPubkey!)}
                  title="Tap to copy"
                >
                  {dmInfoMessage.senderPubkey.slice(0, 20)}…
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Forward modal ── */}
      {dmForwardMessage && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmForwardMessage(null); }}
        >
          <div className="dm-forward-panel">
            <div className="dm-forward-panel__header">
              <span className="dm-forward-panel__title">Forward to</span>
              <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmForwardMessage(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="dm-forward-panel__preview">
              {dmForwardMessage.content.length > 60 ? dmForwardMessage.content.slice(0, 60) + "…" : dmForwardMessage.content}
            </div>
            <div className="dm-forward-panel__list">
              {dmThreads.filter((t) => t.peerPubkey !== dmForwardMessage.peerPubkey).map((thread) => {
                const profile = dmPeerProfilesRef.current.get(thread.peerPubkey);
                const label = profile?.displayName || profile?.name || thread.peerPubkey.slice(0, 12) + "…";
                return (
                  <button
                    key={thread.peerPubkey}
                    type="button"
                    className="dm-forward-panel__thread pressable"
                    onClick={() => { void handleForwardMessage(dmForwardMessage, thread.peerPubkey); setDmForwardMessage(null); }}
                  >
                    <div className="dm-forward-panel__thread-avatar">
                      {profile?.picture
                        ? <img src={profile.picture} alt={label} className="contact-avatar__img" />
                        : contactInitials(label)}
                    </div>
                    <span className="dm-forward-panel__thread-name">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );

}
