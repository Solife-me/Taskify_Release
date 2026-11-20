// @ts-nocheck
import React, { useState, useCallback, useMemo } from "react";
import type { Settings, PushPlatform } from "../../domains/tasks/settingsTypes";
import type { Board, Task } from "../../domains/tasks/taskTypes";
import { useToast } from "../../context/ToastContext";
import { Modal } from "../Modal";
import { BoardsSection } from "./BoardsSection";
import { ViewSection } from "./ViewSection";
import { BibleSection } from "./BibleSection";
import { PushSection } from "./PushSection";
import { NostrSection } from "./NostrSection";
import { BackupSection } from "./BackupSection";
import { ChatSection } from "./ChatSection";
import { SupportSection } from "./SupportSection";
import { StorageSection } from "./StorageSection";
import { SettingsAccordion } from "./SettingsAccordion";
import { ManageBoardModal } from "./ManageBoardModal";
import { requestLocalReset } from "../../storage/localReset";
import { InstallAppSettingsGroup } from "./InstallAppSettingsGroup";


export function SettingsModal({
  embedded,
  settings,
  boards,
  currentBoardId,
  setSettings,
  setBoards,
  setTasks,
  changeBoard,
  shouldReloadForNavigation,
  defaultRelays,
  setDefaultRelays,
  pubkeyHex,
  signerKey,
  tasks,
  onGenerateKey,
  onSetKey,
  onShareBoard,
  onShareBoardToChat,
  onJoinBoard,
  onRegenerateBoardId,
  onClearQueuedRepublish,
  onBoardChanged,
  onResyncBoardHistory,
  onClose,
  pushWorkState,
  pushError,
  onEnablePush,
  onDisablePush,
  chatPushBusy,
  onEnableChatPush,
  onDisableChatPush,
  workerBaseUrl,
  vapidPublicKey,
  onResetWalletTokenTracking,
}: {
  embedded?: boolean;
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Partial<Settings>) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  changeBoard: (id: string) => void;
  shouldReloadForNavigation: () => boolean;
  defaultRelays: string[];
  setDefaultRelays: (rls: string[]) => void;
  pubkeyHex: string;
  signerKey: string;
  tasks: Task[];
  onGenerateKey: () => Promise<void>;
  onSetKey: (hex: string) => Promise<void>;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onShareBoardToChat: (boardId: string) => void;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onRegenerateBoardId: (boardId: string) => void;
  onClearQueuedRepublish?: (boardId: string) => Promise<number>;
  onBoardChanged: (
    boardId: string,
    options?: { republishTasks?: boolean; board?: Board },
  ) => void;
  onResyncBoardHistory: () => void;
  onClose: () => void;
  pushWorkState: "idle" | "enabling" | "disabling";
  pushError: string | null;
  onEnablePush: (platform: PushPlatform) => Promise<void>;
  onDisablePush: () => Promise<void>;
  chatPushBusy: boolean;
  onEnableChatPush: () => Promise<void>;
  onDisableChatPush: () => Promise<void>;
  workerBaseUrl: string;
  vapidPublicKey: string;
  onResetWalletTokenTracking: () => void;
}) {
  const { show: showToast } = useToast();

  // ─── Cross-cutting state ────────────────────────────────────────────────────
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [manageBoardId, setManageBoardId] = useState<string | null>(null);
  const manageBoard = boards.find(b => b.id === manageBoardId);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const currentBoard = useMemo(
    () => boards.find((board) => board.id === currentBoardId) || null,
    [boards, currentBoardId],
  );
  const onReloadNeeded = useCallback(() => {
    setReloadNeeded(true);
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    if (reloadNeeded) {
      setTimeout(() => window.location.reload(), 150);
    }
  }, [onClose, reloadNeeded]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  const settingsBody = (
    <div className="space-y-2">
      <SettingsAccordion
        title="Boards & Lists"
        summary="Create, join, reorder, archive, and share boards"
      >
        <BoardsSection
          embedded
          boards={boards}
          currentBoardId={currentBoardId}
          setBoards={setBoards}
          setTasks={setTasks}
          changeBoard={changeBoard}
          shouldReloadForNavigation={shouldReloadForNavigation}
          onJoinBoard={onJoinBoard}
          onBoardChanged={onBoardChanged}
          onManageBoard={(id) => setManageBoardId(id)}
          onClose={handleClose}
          defaultRelays={defaultRelays}
        />
      </SettingsAccordion>

      <SettingsAccordion
        title="View"
        summary="Task placement, theme, accent, startup view, and display options"
      >
        <ViewSection embedded settings={settings} setSettings={setSettings} boards={boards} />
      </SettingsAccordion>

      <SettingsAccordion
        title="Chat"
        summary="Message retention, local storage usage, and chat history"
      >
        <ChatSection embedded settings={settings} setSettings={setSettings} />
      </SettingsAccordion>

      <SettingsAccordion
        title="Bible"
        summary="Bible tracker, scripture memory, and fasting reminders"
      >
        <BibleSection
          embedded
          settings={settings}
          setSettings={setSettings}
          boards={boards}
          currentBoard={currentBoard}
        />
      </SettingsAccordion>

      <SettingsAccordion
        title="Push notifications"
        summary="Device alerts and private chat notification preferences"
      >
        <PushSection
          embedded
          pushPrefs={settings.pushNotifications}
          pushWorkState={pushWorkState}
          pushError={pushError}
          onEnablePush={onEnablePush}
          onDisablePush={onDisablePush}
          chatPushBusy={chatPushBusy}
          onEnableChatPush={onEnableChatPush}
          onDisableChatPush={onDisableChatPush}
          workerBaseUrl={workerBaseUrl}
          vapidPublicKey={vapidPublicKey}
        />
      </SettingsAccordion>

      <SettingsAccordion
        title="Nostr & Sync"
        summary="Identity, relays, encrypted sync, and board history recovery"
      >
        <NostrSection
          embedded
          settings={settings}
          setSettings={setSettings}
          defaultRelays={defaultRelays}
          setDefaultRelays={setDefaultRelays}
          pubkeyHex={pubkeyHex}
          onGenerateKey={onGenerateKey}
          onSetKey={onSetKey}
          showAdvanced={showAdvanced}
          setShowAdvanced={setShowAdvanced}
          onResyncBoardHistory={onResyncBoardHistory}
          sharedBoardCount={boards.filter((board) => !!board.nostr?.boardId).length}
        />
      </SettingsAccordion>

      <SettingsAccordion
        title="Storage"
        summary="Usage, purchases, inventory, and attachment hosts"
      >
        <StorageSection
          settings={settings}
          setSettings={setSettings}
          pubkeyHex={pubkeyHex}
          signerKey={signerKey}
          tasks={tasks}
        />
      </SettingsAccordion>

      <SettingsAccordion
        title="Backup & Restore"
        summary="Download or restore a complete offline backup"
      >
        <BackupSection embedded onReloadNeeded={onReloadNeeded} />
      </SettingsAccordion>

      <SettingsAccordion
        title="Reset local data"
        summary="Return Taskify to first-run setup in this browser"
      >
        <p className="text-xs text-secondary">
          This removes your saved key, local tasks, messages, settings, and wallet data from this browser.
          Save your key and back up any data you need before resetting.
        </p>
        <button
          type="button"
          className="ghost-button button-sm pressable text-rose-400 mt-2"
          onClick={async () => {
            if (!window.confirm("Erase local Taskify data and return to first-run setup?")) return;
            try {
              await requestLocalReset();
            } catch {
              showToast("Taskify could not start the local reset in this browser.");
            }
          }}
        >
          Reset local data…
        </button>
      </SettingsAccordion>

      <InstallAppSettingsGroup />

      <SettingsAccordion
        title="Support development"
        summary="Send a Lightning tip or copy the support address"
      >
        <SupportSection embedded />
      </SettingsAccordion>

      <SettingsAccordion
        title="Feedback & feature requests"
        summary="Contact the developer or share the support board ID"
      >
        <div className="text-xs text-secondary">
          Please submit feedback or feature requests to{' '}
          <button
            className="link-accent"
            onClick={async () => { try { await navigator.clipboard?.writeText('dev@solife.me'); showToast('Copied dev@solife.me'); } catch {} }}
          >dev@solife.me</button>{' '}
          or share Board ID{' '}
          <button
            className="link-accent"
            onClick={async () => { try { await navigator.clipboard?.writeText('c3db0d84-ee89-43df-a31e-edb4c75be32b'); showToast('Copied Board ID'); } catch {} }}
          >c3db0d84-ee89-43df-a31e-edb4c75be32b</button>
        </div>
      </SettingsAccordion>

      {!embedded && (
        <div className="flex justify-end">
          <button className="ghost-button button-sm pressable" onClick={handleClose}>Close</button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {embedded ? (
        <div className="modal-panel modal-panel--embedded">
          <div className="modal-panel__body modal-panel__body--embedded">
            {settingsBody}
          </div>
        </div>
      ) : (
        <Modal onClose={handleClose} title="Settings">
          {settingsBody}
        </Modal>
      )}
      {manageBoard && (
        <ManageBoardModal
          board={manageBoard}
          boards={boards}
          setBoards={setBoards}
          setTasks={setTasks}
          defaultRelays={defaultRelays}
          showAdvanced={showAdvanced}
          setShowAdvanced={setShowAdvanced}
          onShareBoard={onShareBoard}
          onBoardChanged={onBoardChanged}
          onRegenerateBoardId={onRegenerateBoardId}
          onClearQueuedRepublish={onClearQueuedRepublish}
          shouldReloadForNavigation={shouldReloadForNavigation}
          changeBoard={changeBoard}
          currentBoardId={currentBoardId}
          onClose={() => setManageBoardId(null)}
          onOpenSharePicker={(board) => {
            setManageBoardId(null);
            onShareBoardToChat(board.id);
          }}
        />
      )}
    </>
  );
}
