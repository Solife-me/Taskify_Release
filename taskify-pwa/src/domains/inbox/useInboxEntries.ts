/**
 * The inbox: shared items that arrived by message live as tasks on a hidden per-device board.
 * These hooks list them and count what is unread.
 */
import { useMemo, useState } from "react";
import type { Task } from "taskify-core";
import { kvStorage } from "../../storage/kvStorage";
import type { InboxEntry } from "./inboxEntries";

const LS_MESSAGES_BOARD_ID = "taskify_messages_board_id_v1";

export function useInboxBoardId() {
  const [messagesBoardId] = useState<string>(() => {
    if (typeof window === "undefined") return crypto.randomUUID();
    try {
      const existing = kvStorage.getItem(LS_MESSAGES_BOARD_ID);
      if (existing && existing.trim()) return existing.trim();
    } catch {}
    const id = crypto.randomUUID();
    try {
      kvStorage.setItem(LS_MESSAGES_BOARD_ID, id);
    } catch {}
    return id;
  });
  return messagesBoardId;
}

type UseWalletMessagesParams = {
  messagesBoardId: string;
  tasks: Task[];
  unreadCalendarInviteCount: number;
};

export function useInboxEntries({
  messagesBoardId,
  tasks,
  unreadCalendarInviteCount,
}: UseWalletMessagesParams) {
  const messagesUnreadCount = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.boardId === messagesBoardId &&
          !task.completed &&
          task.inboxItem &&
          task.inboxItem.status !== "accepted" &&
          task.inboxItem.status !== "declined" &&
          task.inboxItem.status !== "tentative" &&
          task.inboxItem.status !== "deleted" &&
          task.inboxItem.status !== "read",
      ).length,
    [messagesBoardId, tasks],
  );
  const inboxEntries = useMemo<InboxEntry[]>(
    () =>
      tasks
        .filter((task) => task.boardId === messagesBoardId)
        .map((task) => ({
          id: task.id,
          title: task.title,
          note: task.note,
          completed: !!task.completed,
          type: task.inboxItem?.type,
          status: task.inboxItem?.status,
          dmEventId: task.inboxItem?.dmEventId,
          boardId: task.inboxItem?.type === "board" ? task.inboxItem.boardId : undefined,
          boardName: task.inboxItem?.type === "board" ? task.inboxItem.boardName : undefined,
          contact: task.inboxItem?.type === "contact" ? task.inboxItem.contact : undefined,
          task: task.inboxItem?.type === "task" ? task.inboxItem.task : undefined,
          sender: task.inboxItem?.sender,
          receivedAt: task.inboxItem?.receivedAt ?? task.dueISO,
        })),
    [messagesBoardId, tasks],
  );
  const inboxPendingItems = useMemo(
    () =>
      inboxEntries.filter(
        (item) =>
          !item.completed &&
          item.status !== "accepted" &&
          item.status !== "declined" &&
          item.status !== "tentative" &&
          item.status !== "deleted",
      ),
    [inboxEntries],
  );
  const [dmUnreadCount, setDmUnreadCount] = useState(0);
  const chatUnreadCount = messagesUnreadCount + unreadCalendarInviteCount + dmUnreadCount;

  return {
    chatUnreadCount,
    dmUnreadCount,
    inboxPendingItems,
    messagesUnreadCount,
    setDmUnreadCount,
    inboxEntries,
  };
}
