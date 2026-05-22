import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "taskify-core";
import { LS_LIGHTNING_CONTACTS } from "../../localStorageKeys";
import {
  contactHasNpub,
  loadContactsFromStorage,
  type Contact,
} from "../../lib/contacts";

export type ShareBoardMode = "board" | "template";

export type ShareTemplateShare = {
  id: string;
  relays: string[];
  boardId: string;
};

export function useShareBoardState(boards: Board[]) {
  const [shareBoardModalOpen, setShareBoardModalOpen] = useState(false);
  const [shareBoardTargetId, setShareBoardTargetId] = useState<string | null>(null);
  const shareBoardTarget = useMemo(
    () => (shareBoardTargetId ? boards.find((board) => board.id === shareBoardTargetId) || null : null),
    [boards, shareBoardTargetId],
  );
  const [shareBoardMode, setShareBoardMode] = useState<ShareBoardMode>("board");
  const [shareModeInfoOpen, setShareModeInfoOpen] = useState(false);
  const shareModeInfoRef = useRef<HTMLDivElement | null>(null);
  const shareModeInfoButtonRef = useRef<HTMLButtonElement | null>(null);
  const [shareTemplateShare, setShareTemplateShare] = useState<ShareTemplateShare | null>(null);
  const [shareTemplateStatus, setShareTemplateStatus] = useState<string | null>(null);
  const [shareTemplateBusy, setShareTemplateBusy] = useState(false);
  const [shareContactPickerOpen, setShareContactPickerOpen] = useState(false);
  const [shareContactStatus, setShareContactStatus] = useState<string | null>(null);
  const [shareContactBusy, setShareContactBusy] = useState(false);
  const [shareContacts, setShareContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const shareableContacts = useMemo(
    () => shareContacts.filter((contact) => contactHasNpub(contact)),
    [shareContacts],
  );
  const shareBoardTargetIdRef = useRef<string | null>(null);
  const shareBoardModalOpenRef = useRef(false);

  const resetShareUi = useCallback(() => {
    setShareBoardMode("board");
    setShareModeInfoOpen(false);
    setShareTemplateShare(null);
    setShareTemplateStatus(null);
    setShareTemplateBusy(false);
    setShareContactStatus(null);
    setShareContactBusy(false);
    setShareContactPickerOpen(false);
  }, []);

  const openShareBoardForTarget = useCallback((boardId: string) => {
    setShareBoardTargetId(boardId);
    resetShareUi();
    setShareBoardModalOpen(true);
    shareBoardTargetIdRef.current = boardId;
    shareBoardModalOpenRef.current = true;
  }, [resetShareUi]);

  const closeShareBoard = useCallback(() => {
    setShareBoardModalOpen(false);
    setShareBoardTargetId(null);
    resetShareUi();
    shareBoardTargetIdRef.current = null;
    shareBoardModalOpenRef.current = false;
  }, [resetShareUi]);

  useEffect(() => {
    shareBoardTargetIdRef.current = shareBoardTargetId;
  }, [shareBoardTargetId]);

  useEffect(() => {
    shareBoardModalOpenRef.current = shareBoardModalOpen;
  }, [shareBoardModalOpen]);

  useEffect(() => {
    if (!shareModeInfoOpen || typeof document === "undefined") return;
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (shareModeInfoRef.current?.contains(target)) return;
      if (shareModeInfoButtonRef.current?.contains(target)) return;
      setShareModeInfoOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareModeInfoOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [shareModeInfoOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshContacts = () => setShareContacts(loadContactsFromStorage());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_LIGHTNING_CONTACTS) {
        refreshContacts();
      }
    };
    window.addEventListener("taskify:contacts-updated", refreshContacts);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("taskify:contacts-updated", refreshContacts);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return {
    closeShareBoard,
    openShareBoardForTarget,
    shareBoardModalOpen,
    shareBoardModalOpenRef,
    shareBoardMode,
    shareBoardTarget,
    shareBoardTargetId,
    shareBoardTargetIdRef,
    shareContactBusy,
    shareContactPickerOpen,
    shareContactStatus,
    shareModeInfoButtonRef,
    shareModeInfoOpen,
    shareModeInfoRef,
    shareTemplateBusy,
    shareTemplateShare,
    shareTemplateStatus,
    shareableContacts,
    setShareBoardMode,
    setShareContactBusy,
    setShareContactPickerOpen,
    setShareContactStatus,
    setShareModeInfoOpen,
    setShareTemplateBusy,
    setShareTemplateShare,
    setShareTemplateStatus,
  };
}
