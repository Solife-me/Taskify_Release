import { useCallback } from "react";
import type { GroupChat } from "../../lib/groupChatState";

type ChatView = string;

/** Renaming a group chat: open the editor, then save locally and publish the new subject. */
export function useGroupRename({
  activeGroupChat,
  renameGroupDraft,
  setRenameGroupDraft,
  setRenameGroupBusy,
  setChatView,
  upsertGroupChat,
  publishGroupSubjectUpdate,
  showToast,
}: {
  activeGroupChat: GroupChat | null;
  renameGroupDraft: string;
  setRenameGroupDraft: (value: string) => void;
  setRenameGroupBusy: (busy: boolean) => void;
  setChatView: (view: ChatView) => void;
  upsertGroupChat: (group: GroupChat) => void;
  publishGroupSubjectUpdate: (group: GroupChat, name: string) => Promise<boolean>;
  showToast: (message: string, durationMs?: number) => void;
}) {
  const openGroupNameEditor = useCallback(() => {
    if (!activeGroupChat) return;
    setRenameGroupDraft(activeGroupChat.name || "");
    setChatView("group-name-edit");
  }, [activeGroupChat, setChatView, setRenameGroupDraft]);

  const handleRenameGroupSubmit = useCallback(() => {
    if (!activeGroupChat) return;
    const nextName = renameGroupDraft.trim();
    if (!nextName) {
      showToast("Enter a group name", 2500);
      return;
    }
    if (nextName === (activeGroupChat.name || "").trim()) {
      setChatView("group-info");
      return;
    }
    const updatedGroup = { ...activeGroupChat, name: nextName, nameUpdatedAt: Math.floor(Date.now() / 1000) };
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
  }, [activeGroupChat, publishGroupSubjectUpdate, renameGroupDraft, setChatView, setRenameGroupBusy, showToast, upsertGroupChat]);

  return { openGroupNameEditor, handleRenameGroupSubmit };
}
