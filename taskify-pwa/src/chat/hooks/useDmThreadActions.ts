import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { chatStateSyncBus } from "../../nostr/chatStateSyncBus";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import { LS_GROUP_MUTED, LS_GROUP_LEFT } from "../../localStorageKeys";
import { dmThreadKeyForThread, dmThreadKeyForMessage, DM_THREAD_DELETE_CACHE_TTL_MS } from "../chatHelpers";
import type { NostrIdentityInfo } from "../chatHelpers";
import { contactPrimaryName, type Contact, type ContactProfile } from "../../lib/contacts";
import type { GroupChat } from "../../lib/groupChatState";
import type { ChatView, PendingDmMessage, WalletDmMessage, WalletDmThread } from "./useDmState";

type DmView = "list" | "thread" | "strangers";

type DmMessageActions = {
  eventId: string;
  copyValue: string;
  msg: WalletDmMessage;
} | null;

export interface UseDmThreadActionsOptions {
  dmMutedGroupsRef: RefObject<Map<string, number>>;
  setDmMutedGroupsVersion: Dispatch<SetStateAction<number>>;
  dmLeftGroupsRef: RefObject<Set<string>>;
  setDmLeftGroupsVersion: Dispatch<SetStateAction<number>>;
  dmThreadReadAtRef: RefObject<Map<string, number>>;
  persistDmThreadReadState: (next: Map<string, number>) => void;
  setDmThreadReadAtVersion: Dispatch<SetStateAction<number>>;
  dmArchivedThreadsRef: RefObject<Map<string, number>>;
  persistArchivedDmThreads: (threads: Map<string, number>) => void;
  setDmArchivedThreadsVersion: Dispatch<SetStateAction<number>>;
  dmTempDeletedEventsRef: RefObject<Map<string, number>>;
  persistTempDeletedDmEvents: (events: Map<string, number>) => void;
  setDmTempDeletedEventsVersion: Dispatch<SetStateAction<number>>;
  dmProcessedEventsRef: RefObject<Set<string>>;
  dmBlockedPeersRef: RefObject<Set<string>>;
  persistBlockedPeers: (peers: Set<string>) => void;
  setDmBlockedPeersVersion: Dispatch<SetStateAction<number>>;
  setDmMessageActions: Dispatch<SetStateAction<DmMessageActions>>;
  setDmExpandedMessages: Dispatch<SetStateAction<Set<string>>>;
  setDmMessages: Dispatch<SetStateAction<WalletDmMessage[]>>;
  setPendingMessages: Dispatch<SetStateAction<PendingDmMessage[]>>;
  cancelDmLongPress: () => void;
  persistGroupStateSet: (storageKey: string, values: Set<string>) => void;
  activeThreadPeer: string | null;
  isChatPage: boolean;
  setActiveThreadPeer: Dispatch<SetStateAction<string | null>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setDmView: Dispatch<SetStateAction<DmView>>;
  dmListViewRef: RefObject<"list" | "strangers">;
  setChatView: Dispatch<SetStateAction<ChatView>>;
  activeGroupChat: GroupChat | null;
  activeThread: WalletDmThread | null;
  setRenameGroupDraft: Dispatch<SetStateAction<string>>;
  setGroupMembersSearch: Dispatch<SetStateAction<string>>;
  setGroupInfoTab: Dispatch<SetStateAction<"info" | "photos" | "links">>;
  setAttachTrayOpen: Dispatch<SetStateAction<boolean>>;
  setShareContactPickerMode: Dispatch<SetStateAction<"recipient" | "chat-source">>;
  setShareContactSource: Dispatch<SetStateAction<Contact | null>>;
  setShareContactStatus: Dispatch<SetStateAction<string | null>>;
  setChatCompose: Dispatch<SetStateAction<string>>;
  setShareContactPickerOpen: Dispatch<SetStateAction<boolean>>;
  setShareContactBusy: Dispatch<SetStateAction<boolean>>;
  readNostrIdentity: () => NostrIdentityInfo;
  sendContactShareToPubkeys: (
    contact: Contact,
    recipientPubkeys: string[],
  ) => Promise<{ ok: true } | { ok: false; error?: string }>;
  upsertContact: (input: Partial<Contact>) => Contact | null;
  getPeerProfile: (pubkey: string) => ContactProfile | undefined;
  peerLabelFor: (hex: string) => { label: string; picture?: string; subtitle?: string };
  formatNpub: (value: string) => string;
  collectUnreadThreadItemEventIds: (
    messages: WalletDmMessage[],
    peerPubkey: string | null | undefined,
  ) => string[];
  onMarkMessagesRead: (ids: string[]) => void;
  showToast: (message: string, duration?: number) => void;
}

export function useDmThreadActions({
  // DM state refs
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
  // chat nav state
  activeThreadPeer,
  isChatPage,
  setActiveThreadPeer,
  setActiveGroupId,
  setDmView,
  dmListViewRef,
  setChatView,
  // group state
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
  // contact callbacks
  upsertContact,
  getPeerProfile,
  peerLabelFor,
  formatNpub,
  // message callbacks
  collectUnreadThreadItemEventIds,
  onMarkMessagesRead,
  showToast,
}: UseDmThreadActionsOptions) {
  const persistMutedGroups = useCallback((next: Map<string, number>) => {
    try {
      idbKeyValue.setItem(
        TASKIFY_STORE_NOSTR,
        LS_GROUP_MUTED,
        JSON.stringify(Object.fromEntries(Array.from(next.entries()))),
      );
    } catch {
      // ignore storage failures
    }
  }, []);

  const persistLeftGroups = useCallback(
    (next: Set<string>) => persistGroupStateSet(LS_GROUP_LEFT, next),
    [persistGroupStateSet],
  );

  const setGroupMutedState = useCallback(
    (groupId: string, muted: boolean) => {
      const key = (groupId || "").trim().toLowerCase();
      if (!key) return;
      const next = new Map(dmMutedGroupsRef.current);
      if (muted) {
        next.set(key, Date.now());
      } else {
        next.delete(key);
      }
      dmMutedGroupsRef.current = next;
      persistMutedGroups(next);
      setDmMutedGroupsVersion((value) => value + 1);
    },
    [dmMutedGroupsRef, persistMutedGroups, setDmMutedGroupsVersion],
  );

  const setGroupLeftState = useCallback(
    (groupId: string, left: boolean) => {
      const key = (groupId || "").trim().toLowerCase();
      if (!key) return;
      const next = new Set(dmLeftGroupsRef.current);
      if (left) {
        next.add(key);
      } else {
        next.delete(key);
      }
      dmLeftGroupsRef.current = next;
      persistLeftGroups(next);
      setDmLeftGroupsVersion((value) => value + 1);
    },
    [dmLeftGroupsRef, persistLeftGroups, setDmLeftGroupsVersion],
  );

  const markThreadReadThrough = useCallback(
    (threadKey: string | null | undefined, timestampSeconds: number) => {
      const normalizedThreadKey = (threadKey || "").trim().toLowerCase();
      const normalizedTimestamp =
        Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? Math.floor(timestampSeconds) : 0;
      if (!normalizedThreadKey || normalizedTimestamp <= 0) return;
      const existing = dmThreadReadAtRef.current.get(normalizedThreadKey) ?? 0;
      if (normalizedTimestamp <= existing) return;
      const next = new Map(dmThreadReadAtRef.current);
      next.set(normalizedThreadKey, normalizedTimestamp);
      dmThreadReadAtRef.current = next;
      persistDmThreadReadState(next);
      setDmThreadReadAtVersion((value) => value + 1);
      chatStateSyncBus.reportLocalReadThrough({ [normalizedThreadKey]: normalizedTimestamp });
    },
    [dmThreadReadAtRef, persistDmThreadReadState, setDmThreadReadAtVersion],
  );

  const closeThreadIfActive = useCallback(
    (thread: WalletDmThread) => {
      if (activeThreadPeer !== thread.peerPubkey) return;
      setActiveThreadPeer(null);
      setActiveGroupId(null);
      setDmView(dmListViewRef.current);
      if (isChatPage) {
        setChatView("threads");
      }
    },
    [
      activeThreadPeer,
      dmListViewRef,
      isChatPage,
      setActiveGroupId,
      setActiveThreadPeer,
      setChatView,
      setDmView,
    ],
  );

  const clearArchivedDmThread = useCallback(
    (threadKey: string) => {
      const key = threadKey.trim().toLowerCase();
      if (!key || !dmArchivedThreadsRef.current.has(key)) return;
      const next = new Map(dmArchivedThreadsRef.current);
      next.delete(key);
      dmArchivedThreadsRef.current = next;
      persistArchivedDmThreads(next);
      setDmArchivedThreadsVersion((value) => value + 1);
    },
    [dmArchivedThreadsRef, persistArchivedDmThreads, setDmArchivedThreadsVersion],
  );

  const handleArchiveDmThread = useCallback(
    (thread: WalletDmThread) => {
      const key = dmThreadKeyForThread(thread);
      if (!key) return;
      const next = new Map(dmArchivedThreadsRef.current);
      next.set(key, Date.now());
      dmArchivedThreadsRef.current = next;
      persistArchivedDmThreads(next);
      setDmArchivedThreadsVersion((value) => value + 1);
      const unreadIds = collectUnreadThreadItemEventIds(thread.messages, thread.peerPubkey);
      if (unreadIds.length) {
        onMarkMessagesRead(unreadIds);
      }
      markThreadReadThrough(thread.peerPubkey, Math.floor(Date.now() / 1000));
      closeThreadIfActive(thread);
      showToast("Thread archived", 1800);
    },
    [
      closeThreadIfActive,
      collectUnreadThreadItemEventIds,
      dmArchivedThreadsRef,
      markThreadReadThrough,
      onMarkMessagesRead,
      persistArchivedDmThreads,
      setDmArchivedThreadsVersion,
      showToast,
    ],
  );

  const handleDeleteDmThread = useCallback(
    (thread: WalletDmThread) => {
      const key = dmThreadKeyForThread(thread);
      if (!key) return;
      const now = Date.now();
      const cutoffMs = now - DM_THREAD_DELETE_CACHE_TTL_MS;
      const expiresAt = now + DM_THREAD_DELETE_CACHE_TTL_MS;
      const nextTempDeleted = new Map(
        Array.from(dmTempDeletedEventsRef.current.entries()).filter(([, expiry]) => expiry > now),
      );
      thread.messages.forEach((message) => {
        if (message.eventId.startsWith("draft-")) return;
        if (message.createdAt * 1000 < cutoffMs) return;
        nextTempDeleted.set(message.eventId, expiresAt);
        if (message.rumorEventId) {
          nextTempDeleted.set(message.rumorEventId, expiresAt);
        }
        dmProcessedEventsRef.current.add(message.eventId);
      });
      dmTempDeletedEventsRef.current = nextTempDeleted;
      persistTempDeletedDmEvents(nextTempDeleted);
      setDmTempDeletedEventsVersion((value) => value + 1);
      clearArchivedDmThread(key);
      const unreadIds = collectUnreadThreadItemEventIds(thread.messages, thread.peerPubkey);
      if (unreadIds.length) {
        onMarkMessagesRead(unreadIds);
      }
      setDmMessages((prev) => prev.filter((message) => dmThreadKeyForMessage(message) !== key));
      setPendingMessages((prev) =>
        prev.filter((message) => message.peerPubkey.trim().toLowerCase() !== thread.peerPubkey.toLowerCase()),
      );
      setDmExpandedMessages((prev) => {
        const eventIds = new Set(thread.messages.map((message) => message.eventId));
        if (!eventIds.size) return prev;
        const next = new Set(prev);
        eventIds.forEach((eventId) => next.delete(eventId));
        return next;
      });
      setDmMessageActions((prev) => (prev && thread.messages.some((message) => message.eventId === prev.eventId) ? null : prev));
      closeThreadIfActive(thread);
      showToast("Thread deleted", 1800);
    },
    [
      clearArchivedDmThread,
      closeThreadIfActive,
      collectUnreadThreadItemEventIds,
      dmProcessedEventsRef,
      dmTempDeletedEventsRef,
      onMarkMessagesRead,
      persistTempDeletedDmEvents,
      setDmExpandedMessages,
      setDmMessageActions,
      setDmMessages,
      setDmTempDeletedEventsVersion,
      setPendingMessages,
      showToast,
    ],
  );

  const openActiveGroupInfo = useCallback(() => {
    if (!activeThread?.groupId) return;
    setGroupMembersSearch("");
    setRenameGroupDraft(activeGroupChat?.name || "");
    setGroupInfoTab("info");
    setChatView("group-info");
  }, [
    activeGroupChat?.name,
    activeThread?.groupId,
    setChatView,
    setGroupInfoTab,
    setGroupMembersSearch,
    setRenameGroupDraft,
  ]);

  const handleToggleActiveGroupMute = useCallback(() => {
    if (!activeGroupChat) return;
    const nextMuted = !dmMutedGroupsRef.current.has(activeGroupChat.groupId.toLowerCase());
    setGroupMutedState(activeGroupChat.groupId, nextMuted);
    if (!nextMuted && activeThread?.groupId === activeGroupChat.groupId) {
      markThreadReadThrough(activeGroupChat.groupId, Math.floor(Date.now() / 1000));
    }
    showToast(nextMuted ? "Group muted" : "Group unmuted", 2000);
  }, [
    activeGroupChat,
    activeThread?.groupId,
    dmMutedGroupsRef,
    markThreadReadThrough,
    setGroupMutedState,
    showToast,
  ]);

  const handleToggleActiveGroupMembership = useCallback(() => {
    if (!activeGroupChat) return;
    const nextLeft = !dmLeftGroupsRef.current.has(activeGroupChat.groupId.toLowerCase());
    setGroupLeftState(activeGroupChat.groupId, nextLeft);
    if (nextLeft) {
      setAttachTrayOpen(false);
      setShareContactPickerOpen(false);
      setShareContactPickerMode("recipient");
      setShareContactSource(null);
      setShareContactStatus(null);
      setChatCompose("");
    }
    showToast(nextLeft ? "You left the group" : "You rejoined the group", 2400);
  }, [
    activeGroupChat,
    dmLeftGroupsRef,
    setAttachTrayOpen,
    setChatCompose,
    setGroupLeftState,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    setShareContactSource,
    setShareContactStatus,
    showToast,
  ]);

  const toggleBlockPeer = useCallback(
    (peerPubkey: string) => {
      const key = (peerPubkey || "").toLowerCase().trim();
      if (!key) return;
      const next = new Set(dmBlockedPeersRef.current);
      const isBlocking = !next.has(key);
      if (isBlocking) {
        next.add(key);
      } else {
        next.delete(key);
      }
      dmBlockedPeersRef.current = next;
      persistBlockedPeers(next);
      setDmBlockedPeersVersion((v) => v + 1);
      setDmMessageActions(null);
      cancelDmLongPress();
      showToast(isBlocking ? "User blocked" : "User unblocked", isBlocking ? 2000 : 1600);
    },
    [
      cancelDmLongPress,
      dmBlockedPeersRef,
      persistBlockedPeers,
      setDmBlockedPeersVersion,
      setDmMessageActions,
      showToast,
    ],
  );

  const handleAddPeerToContacts = useCallback(
    (peerPubkey: string) => {
      if (!peerPubkey) return;
      const npub = formatNpub(peerPubkey);
      const profile = getPeerProfile(peerPubkey);
      const label = peerLabelFor(peerPubkey);
      const contact = upsertContact({
        npub,
        name: profile?.displayName || profile?.username || label.label,
        displayName: profile?.displayName || label.label,
        username: profile?.username,
        address: profile?.lud16 || "",
        picture: profile?.picture,
      });
      if (contact) {
        showToast("Added to contacts", 2000);
      } else {
        showToast("Unable to add contact", 2400);
      }
    },
    [formatNpub, getPeerProfile, peerLabelFor, showToast, upsertContact],
  );

  /** Sends a contact card into the open conversation (every other member, for a group). */
  const handleSendChatContactAttachment = useCallback(
    async (contact: Contact) => {
      if (!activeThread) {
        setShareContactStatus("Open a conversation first.");
        return;
      }
      const ownPubkey = readNostrIdentity().identity?.pubkey.toLowerCase();
      const recipients = activeThread.groupId && activeGroupChat
        ? activeGroupChat.members
            .map((member) => member.toLowerCase())
            .filter((member) => member && member !== ownPubkey)
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
      } catch (err) {
        setShareContactStatus((err as { message?: string } | null)?.message || "Unable to send contact.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      activeGroupChat,
      activeThread,
      readNostrIdentity,
      sendContactShareToPubkeys,
      setShareContactBusy,
      setShareContactPickerMode,
      setShareContactPickerOpen,
      setShareContactSource,
      setShareContactStatus,
      showToast,
    ],
  );

  return {
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
    handleSendChatContactAttachment,
  };
}
