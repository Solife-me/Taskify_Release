/**
 * Chat's state and behaviour, independent of the wallet: direct and group messages (NIP-17 / NIP-04),
 * contacts and their sync, the user's profile card, and unread counts. `App` mounts this once and
 * keeps it mounted, so messages sync and the unread badge updates while another page is open; the
 * Chat page reads it through `useChatRuntime()`.
 *
 * A Cashu token received in a message is only shown and copied: chat has no wallet functions.
 */
import { useSyncResume } from "../nostr/useSyncResume";
import React, { useEffect, useMemo, useRef, useState } from "react";


import { useToast } from "../context/ToastContext";




import { LS_NOSTR_RELAYS } from "../nostrKeys";
import { kvStorage } from "../storage/kvStorage";
import { buildContactShareEnvelope, sendShareMessage } from "../lib/shareInbox";
import { normalizeNostrPubkey } from "../lib/nostr";








import type { Contact } from "../lib/contacts";
import {
  contactDisplayLabel,
  contactHasNpub,
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
  makeContactId,
  normalizeContact,
  sanitizeUsername,
  saveContactsToStorage,
} from "../lib/contacts";
import type { InboxEntry } from "../domains/inbox/inboxEntries";




import { useDmState, normalizeDmPeerHex } from "./hooks/useDmState";
import { useContactsState } from "./hooks/useContactsState";
import { useDmSubscription, type IncomingShareHandler } from "./hooks/useDmSubscription";
import { useDmSend } from "./hooks/useDmSend";
import { useContactsSync } from "./hooks/useContactsSync";
import { useDmThreadActions } from "./hooks/useDmThreadActions";
import { useContactLookup } from "./hooks/useContactLookup";
import { useContactDetail } from "./hooks/useContactDetail";
import {
  fetchBotCommands,
  loadCachedBotCommands,
  saveCachedBotCommands,
  shouldRefreshCachedBotCommands,
  type BotCommand,
} from "../lib/botCommands";
import { useDmThreadUtils } from "./hooks/useDmThreadUtils";
import { useDmMessageDerived } from "./hooks/useDmMessageDerived";
import { useDmThreadDerived } from "./hooks/useDmThreadDerived";
import { useThreadUnreadCounts } from "./hooks/useThreadUnreadCounts";
import { useContactsDerived } from "./hooks/useContactsDerived";
import { useChatGroupDerived } from "./hooks/useChatGroupDerived";


import {
  CloseIcon,
  avatarInitials,
  shortenNpubDisplay,
} from "./chatUi";
import {
  getInboxEntryStatusLabel,
  estimateDataUrlSize,
  isDataUrl,
  pickPreferredProfilePhoto,
  dmThreadKeyForThread,
  buildInboxEntrySyntheticEventId,
  buildCalendarInviteSyntheticEventId,
  type SharedContactPreview,
} from "./chatHelpers";



import { createContext, useContext } from "react";
import { useNostrSession } from "./hooks/useNostrSession";
import { useGroupRename } from "./hooks/useGroupRename";
import type { InboxSender, SharedTaskPayload } from "taskify-core";
import type { CalendarInvite } from "../domains/calendar/calendarInvitesHook";
import type { ChatMessageRetention } from "../domains/tasks/settingsTypes";
import type { PendingCalendarInvite } from "./chatHelpers";
import { useChatScanner } from "./hooks/useChatScanner";

export type ChatRuntimeProps = {
  /** The Chat page is on screen. */
  active: boolean;
  children?: React.ReactNode;
  contactsSyncEnabled: boolean;
  fileStorageServer: string;
  fileServers?: string;
  /** Where encrypted attachments are uploaded. */
  encryptedFileStorageServer?: string;
  encryptedFileServers?: string;
  /** Shared tasks, boards and calendar invites that arrived by message (the inbox). */
  messageItems: InboxEntry[];
  inboxPendingItems?: InboxEntry[];
  pendingCalendarInvites?: PendingCalendarInvite[];
  onAcceptMessage: (id: string) => void;
  /** Adds a shared task to a board again (from its card in the chat). */
  onAddTaskAgain?: (task: SharedTaskPayload, sender?: InboxSender) => void;
  onMaybeMessage: (id: string) => void;
  onDeclineMessage: (id: string) => void;
  onDismissMessage: (id: string) => void;
  onMarkMessagesRead: (dmEventIds: string[]) => void;
  onCalendarInviteRsvp?: (invite: CalendarInvite, status: string) => void;
  onDismissCalendarInvite?: (invite: CalendarInvite) => void;
  formatCalendarInviteWhen?: (invite: CalendarInvite) => string;
  onDmUnreadCountChange?: (count: number) => void;
  chatMessageRetention?: ChatMessageRetention;
  /** Each incoming share, once, as chat opens it (the inbox has no subscription of its own). */
  onIncomingShare?: IncomingShareHandler;
};

/** Chat's state and actions, as the Chat page reads them. */
export type ChatRuntimeValue = ReturnType<typeof useChatRuntimeValue>;

const ChatRuntimeContext = createContext<ChatRuntimeValue | null>(null);

/** Chat's state and actions, for the Chat page. */
export function useChatRuntime(): ChatRuntimeValue {
  const value = useContext(ChatRuntimeContext);
  if (!value) throw new Error("useChatRuntime needs a ChatRuntime");
  return value;
}

export function ChatRuntime({ children, ...props }: ChatRuntimeProps) {
  const value = useChatRuntimeValue(props);
  return <ChatRuntimeContext.Provider value={value}>{children}</ChatRuntimeContext.Provider>;
}

function useChatRuntimeValue({
  active,
  contactsSyncEnabled,
  fileStorageServer,
  fileServers = "",
  encryptedFileStorageServer = "",
  encryptedFileServers = "",
  messageItems,
  inboxPendingItems,
  pendingCalendarInvites,
  onAcceptMessage,
  onAddTaskAgain,
  onMaybeMessage,
  onDeclineMessage,
  onDismissMessage,
  onMarkMessagesRead,
  onCalendarInviteRsvp,
  onDismissCalendarInvite,
  formatCalendarInviteWhen,
  onDmUnreadCountChange,
  chatMessageRetention = "forever",
  onIncomingShare,
}: Omit<ChatRuntimeProps, "children">) {
  const open = active;
  const onIncomingShareRef = useRef<IncomingShareHandler | null>(onIncomingShare ?? null);
  onIncomingShareRef.current = onIncomingShare ?? null;
  const chatDebugEnabled = import.meta.env.DEV && (() => {
    try {
      return kvStorage.getItem("taskify.chat.debug") === "1";
    } catch {
      return false;
    }
  })();
  const nip17TimestampMode: "random" | "now" = (() => {
    try {
      const value = (kvStorage.getItem("taskify.nip17.timestamp") || "").trim().toLowerCase();
      return value === "now" ? "now" : "random";
    } catch {
      return "random";
    }
  })();

  const { show: showToast } = useToast();
  const [showScanner, setShowScanner] = useState(false);
  const [scannerMessage, setScannerMessage] = useState("");
  const [scannedContact, setScannedContact] = useState<Contact | null>(null);
  const [sharedContactPreview, setSharedContactPreview] = useState<SharedContactPreview | null>(null);
  /** Whether the Chat page is on screen (conversation effects only run while it is). */
  const isChatPage = active;
  const {
    chatView, setChatView,
    chatCompose, setChatCompose,
setPendingMessages,
    groupChats,
    groupSelectMembers, setGroupSelectMembers,
    groupNameDraft, setGroupNameDraft,
    renameGroupDraft, setRenameGroupDraft,
    renameGroupBusy, setRenameGroupBusy,
setActiveGroupId,
    groupMembersSearch, setGroupMembersSearch,
    groupInfoTab, setGroupInfoTab,
    groupChatsRef,
    dmMutedGroupsRef, dmMutedGroupsVersion, setDmMutedGroupsVersion,
    dmLeftGroupsRef, dmLeftGroupsVersion, setDmLeftGroupsVersion,
    dmThreadReadAtRef, dmThreadReadAtVersion, setDmThreadReadAtVersion,
    attachTrayOpen, setAttachTrayOpen,
    chatKeyboardHeight,
    chatKeyboardHeightCache,
    chatComposeInputRef, chatPhotoInputRef, chatFileInputRef,
    messagesScrollRef, messagesInnerRef,
    dragTouchStartX, dragTouchStartY, dragDirectionLocked,
    dmListViewRef, scrollToMessageIdRef, dmAutoScrollStateRef,
    chatModeUsesContacts,
    dmMessages, setDmMessages,
setDmExpandedMessages,
    dmMessageActions, setDmMessageActions,
    replyToMessage, setReplyToMessage,
    dmReactions, setDmReactions,
    dmInfoMessage, setDmInfoMessage,
    dmForwardMessage, setDmForwardMessage,
    dmReactionDetail, setDmReactionDetail,
    dmLongPressTimerRef,
    dmDeletedEventsRef, dmDeletedEventsVersion,
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
isDmMessageExpanded,
    copyMessageValue,
persistTempDeletedDmEvents, persistArchivedDmThreads,
persistBlockedPeers,
    persistDmThreadReadState, persistGroupStateSet,
    upsertGroupChat, persistDmSyncMeta, persistDmPeerProfileCache,
    buildDmCopyValue, handleDeleteDmMessage, cancelDmLongPress,
  } = useDmState({
    open,
    isChatPage,
    chatMessageRetention,
    showToast,
    messageItems,
  });
  const {
    defaultNostrRelays,
    preferredFileServer,

    nostrIdentityRef,
    nostrIdentityInfo,

    ensureNostrPool,

    safePublish,
    readNostrIdentity,
    readProfileEventId,
    persistProfileEventId,
    ensureNostrIdentity,
    decryptNostrPaymentMessage,
    parseIncomingPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
  } = useNostrSession({
    debug: chatDebugEnabled,
    fileStorageServer,
    dmSubscriptionCloseRef,
    identityEnabled: true,
  });
  const nostrMissingReason = nostrIdentityInfo.reason;
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
    chatView,
    setChatView,
    activeThreadPeer,
    persistProfileEventId,
  });
  const {






    migrateNip51ContactsIfNeeded,
    syncContactsFromNostr,
    publishContactsToNostr,

    refreshContactProfiles,
    publishProfileMetadata,
    loadProfileMetadata,
  } = useContactsSync({
    contactsSyncEnabled,
    walletDebugEnabled: chatDebugEnabled,
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
  });
  const {
    messageItemsByEventId,
    pendingMessageItemsByEventId,
    pendingCalendarInvitesByEventId,

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
    dmDeletedEventsRef,
    dmTempDeletedEventsRef,
  });
  const messageItemStatusRef = useRef<Map<string, InboxEntry["status"]>>(new Map());
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
          const label = getInboxEntryStatusLabel(item.type, item.status);
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
    persistDmPeerProfileCache,
    contactDisplayLabel,
    onIncomingShareRef,
  });
  const {

    resolveNip17Relays,
    publishNip17Giftwraps,
    handleSendReaction,
    handleForwardMessage,
    publishGroupSubjectUpdate,

    sendMessengerFileAttachments,
  } = useDmSend({
    nip17TimestampMode,
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
  }, [compressedToRawHex, contacts]);
  const {
    isUnreadThreadStatus,
    collectUnreadThreadItemEventIds,
    dmPreviewForMessage,
    peerLabelFor,
    sharedContactMetaFor,

    openSharedContactPreview,
    isArchivedDmThread,
    matchesDmThreadSearch,
    openConversationForPeer,
    openConversationForGroup,
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
    attachTrayOpen,
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
    buildInboxEntrySyntheticEventId,
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
  }, [dmArchivedThreadsRef, dmThreads, persistArchivedDmThreads, setDmArchivedThreadsVersion]);
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
  }, [activeThread, activeThreadPendingMessages.length, chatView, dmAutoScrollStateRef, isChatPage, messagesScrollRef, open, scrollToMessageIdRef]);
  // Bot commands (NIP-51 kind 30078, d-tag taskify-bot-commands): seeded from
  // the localStorage cache so the "/" menu is instantly available, then
  // refreshed in the background. The published list itself is the signal
  // that the peer is a bot (docs/reference/bot-command-lists.md).
  const [activeBotCommands, setActiveBotCommands] = useState<BotCommand[] | null>(null);
  const activeBotCommandsPeerRef = useRef<string | null>(null);
  const botCommandsFetchingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const peerHex = activeThread && !activeThread.groupId && activeThread.peerPubkey
      ? activeThread.peerPubkey.toLowerCase()
      : null;
    activeBotCommandsPeerRef.current = peerHex;
    if (!open || !isChatPage || chatView !== "conversation" || !peerHex) {
      setActiveBotCommands(null);
      return;
    }
    setActiveBotCommands(loadCachedBotCommands(peerHex));
    if (!shouldRefreshCachedBotCommands(peerHex)) return;
    if (botCommandsFetchingRef.current.has(peerHex)) return;
    botCommandsFetchingRef.current.add(peerHex);
    void (async () => {
      try {
        const pool = ensureNostrPool();
        const relays = await resolveNip17Relays(peerHex, defaultNostrRelays);
        const { commands } = await fetchBotCommands(pool, relays, peerHex);
        if (commands.length) {
          saveCachedBotCommands(peerHex, commands);
          if (activeBotCommandsPeerRef.current === peerHex) setActiveBotCommands(commands);
        }
      } catch {
        // Offline or unreachable — cached commands (if any) still stand.
      } finally {
        botCommandsFetchingRef.current.delete(peerHex);
      }
    })();
  }, [activeThread, chatView, defaultNostrRelays, ensureNostrPool, isChatPage, open, resolveNip17Relays]);
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
  }, [scrollToMessageId, chatView, activeThread, scrollToMessageIdRef, messagesScrollRef, setScrollToMessageId]);
  useEffect(() => {
    if (dmView !== "thread" || activeThread) return;
    setDmView(dmListViewRef.current);
    setActiveThreadPeer(null);
    setActiveGroupId(null);
    if (isChatPage && (chatView === "conversation" || chatView === "group-info" || chatView === "group-members" || chatView === "group-name-edit")) {
      setChatView("threads");
    }
  }, [activeThread, chatView, dmListViewRef, dmView, isChatPage, setActiveGroupId, setActiveThreadPeer, setChatView, setDmView]);
  useEffect(() => {
    if (activeGroupChat) return;
    setRenameGroupBusy(false);
    setRenameGroupDraft("");
    setGroupMembersSearch("");
    if (chatView === "group-info" || chatView === "group-members" || chatView === "group-name-edit") {
      setChatView(activeThread ? "conversation" : "threads");
    }
  }, [activeGroupChat, activeThread, chatView, setChatView, setGroupMembersSearch, setRenameGroupBusy, setRenameGroupDraft]);
  const {




    markThreadReadThrough,


    handleArchiveDmThread,
    handleDeleteDmThread,
    openActiveGroupInfo,
    handleToggleActiveGroupMute,
    handleToggleActiveGroupMembership,
    toggleBlockPeer,
    handleAddPeerToContacts,
    handleSendChatContactAttachment,
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
    setShareContactBusy,
    readNostrIdentity,
    sendContactShareToPubkeys,
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
  }, [contacts, skipContactsEventRef, skipContactsTimerRef]);

  useEffect(() => {
    if (!contactsOpen) {
      setContactsContext(null);
      contactsContextRef.current = null;
    }
  }, [contactsContextRef, contactsOpen, setContactsContext]);

  const {

    normalizeNip05,
    resolveNip05Record,

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
    const identity = readNostrIdentity().identity ?? nostrIdentityInfo.identity;
    return identity ? formatNpub(identity.pubkey) : null;
  }, [formatNpub, nostrIdentityInfo.identity, profileSharePayload, readNostrIdentity]);
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
  }, [computeContactsFingerprint, contactSyncMeta.fingerprint, contacts, contactsFingerprintRef, contactsPublishQueuedRef, contactsPublishState, contactsSyncEnabled]);

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
  }, [contactsSyncEnabled, contacts, contactSyncMeta.fingerprint, publishContactsToNostr, contactsPublishQueuedRef]);

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
  }, [chatModeUsesContacts, contactProfilesRefreshedRef, contactsOpen, contactsSyncEnabled, contactsTabOpen, loadProfileMetadata, refreshContactProfiles, syncContactsFromNostr]);

  useEffect(() => {
    if (contactsTabOpen) return;
    setContactView("list");
    setActiveContactId(null);
    resetContactEditDraft();
    setContactEditError("");
    setContactLookupError("");
    setContactLookupInput("");
    setPublicFollowPickerOpen(false);
  }, [contactsTabOpen, resetContactEditDraft, setActiveContactId, setContactEditError, setContactLookupError, setContactLookupInput, setContactView, setPublicFollowPickerOpen]);

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
  }, [activeContactId, contactView, contacts, contactsTabOpen, setActiveContactId, setContactView]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (contactView !== "detail") return;
    const panelEl = contactsPanelRef.current?.closest(".sheet-panel") as HTMLElement | null;
    panelEl?.scrollTo({ top: 0 });
  }, [activeContactId, contactView, contactsPanelRef, contactsTabOpen]);

  const dmResumeEpoch = useSyncResume();
  useEffect(() => {
    void startDmSubscription();
    return () => {
      stopDmSubscription();
    };
  }, [startDmSubscription, stopDmSubscription, dmResumeEpoch]);

  const contactInitials = (value: string) => {
    return avatarInitials(value);
  };

  const myCardUsername = formatContactUsername(profileForm.username);
  const myCardName = profileForm.displayName.trim() || myCardUsername || "My Card";
  const myCardLightning = profileForm.lud16.trim();
  const myCardNpub = useMemo(() => {
    // nostrIdentityInfo changes whenever the stored key does, so the card follows key changes.
    const identity = readNostrIdentity().identity ?? nostrIdentityInfo.identity;
    return identity ? formatNpub(identity.pubkey) : "";
  }, [formatNpub, nostrIdentityInfo.identity, readNostrIdentity]);
  const myCardSubtitle =
    myCardLightning || profileForm.nip05.trim() || myCardNpub || "My Card";
  const profileCard = useMemo(
    () => ({
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
    }),
    [myCardLightning, myCardName, myCardNpub, profileForm, profileUpdatedAt],
  );
  const {
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
    openGroupMemberDetail,
    buildContactFields,

    ensureNip05Verification,
    isNip05VerifiedFor,
    handleSaveScannedContact,
    handleSaveSharedContactPreview,
    handleToggleFollowScannedContact,
    handleStartEditCurrentContact,
    handleCancelContactEdit,
    handleToggleFollowDetailContact,
    handleCopyContactField,

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
    profileCard,
    activeGroupMembers,
    nostrMissingReason,
    preferredFileServer,
    fileServers,
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
    onAcceptMessage,
    handleReturnToProfileCard,
    resetContactEditDraft,
    ensureNostrIdentity,
    publishProfileMetadata,
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
  const detailCanShare = activeContact ? contactHasNpub(activeContact) : false;

  useEffect(() => {
    if (!detailTarget?.id) return;
    ensureNip05Verification(detailTarget.id, detailTarget.nip05, detailTarget.npub, detailTarget.updatedAt ?? null);
  }, [detailTarget, ensureNip05Verification]);

  useEffect(() => {
    ensureNip05VerificationRef.current = ensureNip05Verification;
  }, [ensureNip05Verification, ensureNip05VerificationRef]);

  useEffect(() => {
    isNip05VerifiedForRef.current = isNip05VerifiedFor;
  }, [isNip05VerifiedFor, isNip05VerifiedForRef]);

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
  }, [contactsContext, contactsOpen, contactsTabOpen, ensureNip05Verification, normalizeNip05, profileCard, profileUpdatedAt, sortedContacts, visibleContacts]);


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
    }, [detailTarget, isNip05VerifiedFor]);
    const detailContactCanFollow = !!detailTarget && detailIsNostrContact && !!detailTarget.npub.trim();
    const detailCanAddContact = !!detailTarget && activeContactId !== "profile" && !activeContact;

  const { handleScannerDetected, handlePasteFromClipboard, handleScannerError, closeScanner } = useChatScanner({
    formatNpub,
    handleScannedContactPayload,
    setScannerMessage,
    setShowScanner,
  });
  const { openGroupNameEditor, handleRenameGroupSubmit } = useGroupRename({
    activeGroupChat,
    renameGroupDraft,
    setRenameGroupDraft,
    setRenameGroupBusy,
    setChatView,
    upsertGroupChat,
    publishGroupSubjectUpdate,
    showToast,
  });

  const value = {
    chatAttachTrayHeight,
    activeBotCommands,
    activeContact,
    activeContactId,
    activeGroupAvatarMembers,
    activeGroupChat,
    activeGroupLeft,
    activeGroupMembers,
    activeGroupMuted,
    activeThread,
    attachTrayOpen,
    buildDmCopyValue,
    cancelDmLongPress,
    chatAttachContactOptions,
    chatCompose,
    chatComposeInputRef,
    chatFileInputRef,
    chatPhotoInputRef,
    chatView,
    closeAttachTray,
    closeScanner,
    collectUnreadThreadItemEventIds,
    compressedToRawHex,
    contactEditDraft,
    contactEditError,
    contactInitials,
    contactLookupBusy,
    contactLookupError,
    contactLookupInput,
    contactReturnView,
    contactSubtitle,
    contactSyncState,
    contactView,
    contacts,
    contactsPanelRef,
    contactsPublishState,
    copyMessageValue,
    defaultNostrRelays,
    detailCanAddContact,
    detailCanShare,
    detailContactCanFollow,
    detailContactFollowed,
    detailFields,
    detailIsNostrContact,
    detailNip05Verified,
    detailShareValue,
    detailTarget,
    detailTitle,
    detailUsername,
    dmBlockedPeersRef,
    dmForwardMessage,
    dmInfoMessage,
    dmListViewRef,
    dmLongPressTimerRef,
    dmMessageActions,
    dmMessages,
    dmPeerProfilesRef,
    dmReactionDetail,
    dmReactions,
    dmSearch,
    dmThreadListEntries,
    dmThreads,
    dmView,
    dragDirectionLocked,
    dragTouchStartX,
    dragTouchStartY,
    ensureNostrPool,
    filteredActiveGroupMembers,
    setContacts,
    migrateNip51ContactsIfNeeded,
    syncContactsFromNostr,
    publishContactsToNostr,
    refreshContactProfiles,
    publishProfileMetadata,
    loadProfileMetadata,
    nip05Checks,
    setNip05Checks,
    ensureNip05VerificationRef,
    contactsRef,
    skipContactsEventRef,
    skipContactsTimerRef,
    contactsTabOpen,
    setContactsTabOpen,
    setContactSyncState,
    setContactsPublishState,
    setContactsPublishMessage,
    contactSyncMetaRef,
    contactSyncMeta,
    setContactSyncMeta,
    persistContactSyncMeta,
    profileSharePayload,
    setProfileSharePayload,
    profileEventIdRef,
    profileFormRef,
    setProfileStatus,
    setProfileMessage,
    setProfileUpdatedAt,
    setContactLookupBusy,
    setContactLookupError,
    contactDetailOverride,
    setShareContactBusy,
    shareContactOpenedAtPeerRef,
    setContactEditError,
    setProfilePhotoBusy,
    profilePhotoUploadRef,
    resetContactEditDraft,
    closeContactsTab,
    contactsPublishQueuedRef,
    contactsFingerprintRef,
    nip51MigrationInFlightRef,
    contactProfilesRefreshedRef,
    computeContactsFingerprint,
    contactsContext,
    contactsContextRef,
    contactsOpen,
    isNip05VerifiedForRef,
    lightningContactCount,
    normalizeNip05,
    setContactsContext,
    setContactsOpen,
    visibleContacts,
    formatCalendarInviteWhen,
    formatNpub,
    getPeerProfile,
    groupAvatarMembersFor,
    groupChats,
    groupChatsRef,
    groupInfoTab,
    groupMembersSearch,
    groupNameDraft,
    groupSelectMembers,
    handleAddPeerToContacts,
    handleSendChatContactAttachment,
    handleArchiveDmThread,
    handleBackToContactsList,
    handleCancelContactEdit,
    handleClearProfilePhoto,
    handleContactEditSubmit,
    handleContactImportAction,
    handleCopyContactField,
    handleDeleteContact,
    handleDeleteDmMessage,
    handleDeleteDmThread,
    handleDmEvent,
    handleForwardMessage,
    handleImportPublicFollow,
    handleOpenChatContactPicker,
    handleOpenChatFilePicker,
    handleOpenChatPhotoPicker,
    handlePasteFromClipboard,
    handleProfilePhotoChange,
    handleRenameGroupSubmit,
    handleReturnToProfileCard,
    handleScannerDetected,
    handleScannerError,
    handleSendReaction,
    handleShareContactToContact,
    handleStartAddContact,
    handleStartEditCurrentContact,
    handleToggleActiveGroupMembership,
    handleToggleActiveGroupMute,
    handleToggleAttachTray,
    handleToggleFollowDetailContact,
    isChatPage,
    isDmMessageExpanded,
    messageItemsByEventId,
    messageSearchResults,
    messagesInnerRef,
    messagesScrollRef,
    myCardName,
    myCardNpub,
    myCardSubtitle,
    nostrIdentityRef,
    onAcceptMessage,
    onAddTaskAgain,
    onCalendarInviteRsvp,
    onDeclineMessage,
    onDismissCalendarInvite,
    onDismissMessage,
    onMarkMessagesRead,
    onMaybeMessage,
    open,
    openActiveGroupInfo,
    openConversationForGroup,
    openConversationForPeer,
    openGroupMemberDetail,
    openGroupNameEditor,
    openSharedContactPreview,
    peerLabelFor,
    pendingCalendarInvitesByEventId,
    pendingMessageItemsByEventId,
    profileCard,
    profileEditorOpen,
    profileForm,
    profileMessage,
    profilePhotoBusy,
    profilePhotoError,
    profilePhotoInputRef,
    profileShareValue,
    profileStatus,
    profileUpdatedAt,
    publicFollowOptions,
    publicFollowPickerOpen,
    publishNip17Giftwraps,
    readNostrIdentity,
    renameGroupBusy,
    renameGroupDraft,
    replyToMessage,
    resolveNip17Relays,
    safePublish,
    scannedContact,
    scannedContactCanShare,
    scannedContactFields,
    scannedContactHeader,
    scannedContactNip05Verified,
    scannedContactShareValue,
    scannedContactTitle,
    scannedContactUsername,
    scannerMessage,
    sendMessengerFileAttachments,
    setActiveContactId,
    setActiveGroupId,
    setActiveThreadPeer,
    setAttachTrayOpen,
    setChatCompose,
    setChatView,
    setContactDetailOverride,
    setContactEditDraft,
    setContactLookupInput,
    setContactReturnView,
    setContactView,
    setDmForwardMessage,
    setDmInfoMessage,
    setDmMessageActions,
    setDmReactionDetail,
    setDmSearch,
    setDmView,
    setGroupInfoTab,
    setGroupMembersSearch,
    setGroupNameDraft,
    setGroupSelectMembers,
    setPendingMessages,
    setProfileEditorOpen,
    setProfileForm,
    setProfilePhotoError,
    setPublicFollowPickerOpen,
    setRenameGroupDraft,
    setReplyToMessage,
    setScannedContact,
    setScannerMessage,
    setScrollToMessageId,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    setShareContactSource,
    setShareContactStatus,
    setSharedContactPreview,
    setShowCustomContactFields,
    setShowScanner,
    shareContactBusy,
    shareContactPickerMode,
    shareContactPickerOpen,
    shareContactSource,
    shareContactStatus,
    shareRecipientOptions,
    sharedContactMetaFor,
    sharedContactPreview,
    sharedContactPreviewCanShare,
    sharedContactPreviewContact,
    sharedContactPreviewFields,
    sharedContactPreviewHeader,
    sharedContactPreviewNip05Verified,
    sharedContactPreviewShareValue,
    sharedContactPreviewTitle,
    sharedContactPreviewUsername,
    showCustomContactFields,
    showScanner,
    sortedContacts,
    strangerUnreadCount,
    threadUnreadMap,
    toggleBlockPeer,
    truncateContactName,
    truncateContactValue,
    upsertContact,
    upsertGroupChat,
    visiblePendingMessages,
  };
  return value;
}
