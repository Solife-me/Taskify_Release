// @ts-nocheck
import { useMemo } from "react";
import type { WalletMessageItem } from "../../types/walletMessages";
import {
  buildWalletMessageSyntheticEventId,
  buildCalendarInviteSyntheticEventId,
  PAYMENT_HISTORY_EVENT_ID_REGEX,
  type PendingCalendarInvite,
} from "../../wallet/walletModalHelpers";
import {
  normalizeDmPeerHex,
  type WalletDmMessage,
  type WalletDmAttachment,
} from "./useDmState";
import { parseDateLikeToUnixSeconds } from "../../ui/wallet/walletModalUi";

export interface UseDmMessageDerivedOptions {
  messageItems: WalletMessageItem[];
  inboxPendingItems: WalletMessageItem[] | undefined;
  pendingCalendarInvites: PendingCalendarInvite[] | undefined;
  dmDeletedEventsVersion: number;
  dmMessages: WalletDmMessage[];
  dmTempDeletedEventsVersion: number;
  formatCalendarInviteWhen: ((invite: any) => string) | undefined;
  history: any[];
  dmDeletedEventsRef: React.MutableRefObject<Set<string>>;
  dmTempDeletedEventsRef: React.MutableRefObject<Map<string, number>>;
}

export function useDmMessageDerived({
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
}: UseDmMessageDerivedOptions) {
  const messageItemsByEventId = useMemo(() => {
    const map = new Map<string, WalletMessageItem>();
    messageItems.forEach((item) => {
      const key = item.dmEventId?.trim();
      if (key) map.set(key, item);
    });
    return map;
  }, [messageItems]);

  const pendingMessageItemsByEventId = useMemo(() => {
    const map = new Map<string, WalletMessageItem>();
    (inboxPendingItems || []).forEach((item) => {
      map.set(buildWalletMessageSyntheticEventId(item), item);
    });
    return map;
  }, [inboxPendingItems]);

  const pendingCalendarInvitesByEventId = useMemo(() => {
    const map = new Map<string, PendingCalendarInvite>();
    (pendingCalendarInvites || []).forEach((invite) => {
      map.set(buildCalendarInviteSyntheticEventId(invite), invite);
    });
    return map;
  }, [pendingCalendarInvites]);

  const syntheticDmMessages = useMemo(() => {
    void dmDeletedEventsVersion;
    void dmTempDeletedEventsVersion;
    const isSuppressedEventId = (eventId: string) =>
      dmDeletedEventsRef.current.has(eventId) || (dmTempDeletedEventsRef.current.get(eventId) ?? 0) > Date.now();
    const existingEventIds = new Set(dmMessages.map((message) => message.eventId));
    const messages: WalletDmMessage[] = [];
    (inboxPendingItems || []).forEach((item) => {
      const eventId = buildWalletMessageSyntheticEventId(item);
      if (existingEventIds.has(eventId)) return;
      if (isSuppressedEventId(eventId)) return;
      const peerHex = normalizeDmPeerHex(item.sender?.pubkey || item.sender?.npub);
      if (!peerHex) return;
      const title = item.title?.trim() || item.task?.title?.trim() || item.boardName?.trim() || "Shared item";
      const createdAt = parseDateLikeToUnixSeconds(item.receivedAt);
      const preview =
        item.type === "board"
          ? `Shared board: ${item.boardName || title}`
          : item.type === "contact"
            ? `Shared contact: ${item.contact?.name || item.contact?.displayName || title}`
            : item.type === "task"
              ? `Shared task: ${title}`
              : title;
      const attachment: WalletDmAttachment =
        item.type === "board"
          ? {
              type: "board",
              boardName: item.boardName || title,
              boardId: item.boardId,
              taskId: item.id,
              status: item.status ?? null,
            }
          : item.type === "contact"
            ? {
                type: "contact",
                contactName: item.contact?.name || item.contact?.displayName || title,
                displayName: item.contact?.displayName,
                username: item.contact?.username,
                npub: item.contact?.npub,
                nip05: item.contact?.nip05,
                address: item.contact?.address,
                picture: item.contact?.picture,
                taskId: item.id,
                status: item.status ?? null,
              }
            : item.type === "task"
              ? {
                  type: "task",
                  task: item.task || null,
                  taskId: item.id,
                  status: item.status ?? null,
                }
              : { type: "text" };
      messages.push({
        id: eventId,
        eventId,
        peerPubkey: peerHex,
        isIncoming: true,
        createdAt,
        content: item.note?.trim() || title,
        preview,
        attachment,
      });
    });
    (pendingCalendarInvites || []).forEach((invite) => {
      const eventId = buildCalendarInviteSyntheticEventId(invite);
      if (existingEventIds.has(eventId)) return;
      if (isSuppressedEventId(eventId)) return;
      const peerHex = normalizeDmPeerHex(invite.sender?.pubkey || invite.sender?.npub);
      if (!peerHex) return;
      const whenLabel = formatCalendarInviteWhen ? formatCalendarInviteWhen(invite) : "";
      const title = invite.title?.trim() || "Event invite";
      messages.push({
        id: eventId,
        eventId,
        peerPubkey: peerHex,
        isIncoming: true,
        createdAt: parseDateLikeToUnixSeconds(invite.receivedAt || invite.start),
        content: invite.view?.trim() || invite.canonical?.trim() || title,
        preview: whenLabel ? `Event invite: ${title} · ${whenLabel}` : `Event invite: ${title}`,
        attachment: {
          type: "event",
          title,
          start: invite.start,
          end: invite.end,
          whenLabel,
          inviteId: invite.id,
          status: invite.status,
          canonical: invite.canonical,
          view: invite.view,
        },
      });
    });
    messages.sort((a, b) => a.createdAt - b.createdAt);
    return messages;
  }, [
    dmDeletedEventsVersion,
    dmMessages,
    dmTempDeletedEventsVersion,
    formatCalendarInviteWhen,
    inboxPendingItems,
    pendingCalendarInvites,
  ]);

  const displayDmMessages = useMemo(() => {
    void dmDeletedEventsVersion;
    void dmTempDeletedEventsVersion;
    const merged = new Map<string, WalletDmMessage>();
    syntheticDmMessages.forEach((message) => {
      merged.set(message.eventId, message);
    });
    dmMessages.forEach((message) => {
      if (dmDeletedEventsRef.current.has(message.eventId)) return;
      if ((dmTempDeletedEventsRef.current.get(message.eventId) ?? 0) > Date.now()) return;
      merged.set(message.eventId, message);
    });
    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }, [
    dmDeletedEventsVersion,
    dmMessages,
    dmTempDeletedEventsVersion,
    syntheticDmMessages,
  ]);

  const paymentHistoryByEventId = useMemo(() => {
    const map = new Map<string, any>();
    history.forEach((entry) => {
      const match = PAYMENT_HISTORY_EVENT_ID_REGEX.exec(entry.id);
      if (match?.[1]) {
        map.set(match[1].toLowerCase(), entry);
      }
    });
    return map;
  }, [history]);

  return {
    messageItemsByEventId,
    pendingMessageItemsByEventId,
    pendingCalendarInvitesByEventId,
    syntheticDmMessages,
    displayDmMessages,
    paymentHistoryByEventId,
  };
}
