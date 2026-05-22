// @ts-nocheck
import { useCallback } from "react";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import { LS_GROUP_MUTED, LS_GROUP_LEFT } from "../../localStorageKeys";
import { dmThreadKeyForThread, dmThreadKeyForMessage, DM_THREAD_DELETE_CACHE_TTL_MS } from "../../wallet/walletModalHelpers";
import type { WalletDmThread } from "../../hooks/wallet/useDmState";

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
  // contact callbacks
  upsertContact,
  getPeerProfile,
  peerLabelFor,
  formatNpub,
  // message callbacks
  collectUnreadThreadItemEventIds,
  onMarkMessagesRead,
  showToast,
}) {
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
    [persistMutedGroups],
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
    [persistLeftGroups],
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
    },
    [persistDmThreadReadState],
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
    [activeThreadPeer, isChatPage],
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
    [persistArchivedDmThreads],
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
      markThreadReadThrough,
      onMarkMessagesRead,
      persistArchivedDmThreads,
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
      onMarkMessagesRead,
      persistTempDeletedDmEvents,
      showToast,
    ],
  );

  const openActiveGroupInfo = useCallback(() => {
    if (!activeThread?.groupId) return;
    setGroupMembersSearch("");
    setRenameGroupDraft(activeGroupChat?.name || "");
    setGroupInfoTab("info");
    setChatView("group-info");
  }, [activeGroupChat?.name, activeThread?.groupId]);

  const handleToggleActiveGroupMute = useCallback(() => {
    if (!activeGroupChat) return;
    const nextMuted = !dmMutedGroupsRef.current.has(activeGroupChat.groupId.toLowerCase());
    setGroupMutedState(activeGroupChat.groupId, nextMuted);
    if (!nextMuted && activeThread?.groupId === activeGroupChat.groupId) {
      markThreadReadThrough(activeGroupChat.groupId, Math.floor(Date.now() / 1000));
    }
    showToast(nextMuted ? "Group muted" : "Group unmuted", 2000);
  }, [activeGroupChat, activeThread?.groupId, markThreadReadThrough, setGroupMutedState, showToast]);

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
  }, [activeGroupChat, setGroupLeftState, showToast]);

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
    [cancelDmLongPress, persistBlockedPeers, showToast],
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
  };
}
