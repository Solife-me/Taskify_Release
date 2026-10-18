import { useMemo, type RefObject } from "react";
import type { WalletMessageItem } from "../../types/walletMessages";
import type { PendingCalendarInvite } from "../chatHelpers";
import type { WalletDmThread } from "./useDmState";

export interface UseThreadUnreadCountsOptions {
  dmThreads: WalletDmThread[];
  messageItemsByEventId: Map<string, WalletMessageItem>;
  pendingMessageItemsByEventId: Map<string, WalletMessageItem>;
  pendingCalendarInvitesByEventId: Map<string, PendingCalendarInvite>;
  isUnreadThreadStatus: (status: string | null | undefined) => boolean;
  dmMutedGroupsRef: RefObject<Map<string, number>>;
  dmLeftGroupsRef: RefObject<Set<string>>;
  dmThreadReadAtRef: RefObject<Map<string, number>>;
  dmMutedGroupsVersion: number;
  dmLeftGroupsVersion: number;
  dmThreadReadAtVersion: number;
  strangerThreads: WalletDmThread[];
  visibleDmThreads: WalletDmThread[];
}

export function useThreadUnreadCounts({
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
}: UseThreadUnreadCountsOptions) {
  const threadUnreadMap = useMemo(() => {
    // Ref contents change in place; their companion versions deliberately invalidate this memo.
    void dmLeftGroupsVersion;
    void dmMutedGroupsVersion;
    void dmThreadReadAtVersion;
    const map = new Map<string, number>();
    dmThreads.forEach((thread) => {
      const unreadIds = new Set<string>();
      const threadKey = thread.peerPubkey.toLowerCase();
      const mutedSinceMs = thread.groupId ? dmMutedGroupsRef.current.get(thread.groupId.toLowerCase()) ?? null : null;
      const isLeftGroup = thread.groupId ? dmLeftGroupsRef.current.has(thread.groupId.toLowerCase()) : false;
      const readAtSeconds = dmThreadReadAtRef.current.get(threadKey) ?? 0;
      thread.messages.forEach((msg) => {
        if (!msg.isIncoming) return;
        if (msg.eventId.startsWith("draft-")) return;
        if (isLeftGroup) return;
        if (msg.createdAt <= readAtSeconds) return;
        if (mutedSinceMs != null && msg.createdAt * 1000 >= mutedSinceMs) return;
        unreadIds.add(msg.eventId);
        const item = messageItemsByEventId.get(msg.eventId) || pendingMessageItemsByEventId.get(msg.eventId);
        const invite = pendingCalendarInvitesByEventId.get(msg.eventId);
        const status = item?.status || invite?.status;
        if (status && !isUnreadThreadStatus(status)) {
          unreadIds.delete(msg.eventId);
        }
      });
      map.set(thread.peerPubkey, unreadIds.size);
    });
    return map;
  }, [
    dmLeftGroupsVersion,
    dmLeftGroupsRef,
    dmMutedGroupsVersion,
    dmMutedGroupsRef,
    dmThreadReadAtVersion,
    dmThreadReadAtRef,
    dmThreads,
    isUnreadThreadStatus,
    messageItemsByEventId,
    pendingCalendarInvitesByEventId,
    pendingMessageItemsByEventId,
  ]);

  const strangerUnreadCount = useMemo(
    () =>
      strangerThreads.reduce((acc, thread) => acc + (threadUnreadMap.get(thread.peerPubkey) || 0), 0),
    [strangerThreads, threadUnreadMap],
  );

  const mainUnreadCount = useMemo(
    () =>
      visibleDmThreads.reduce((acc, thread) => {
        return acc + (threadUnreadMap.get(thread.peerPubkey) || 0);
      }, 0),
    [threadUnreadMap, visibleDmThreads],
  );

  return { threadUnreadMap, strangerUnreadCount, mainUnreadCount };
}
