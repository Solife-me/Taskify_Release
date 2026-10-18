import { lazy, Suspense } from "react";
import type { PrintSheetsProps } from "../print/PrintSheets";
import { FirstRunOnboarding } from "../../onboarding/FirstRunOnboarding";
import { AddBoardModal } from "../board/AddBoardModal";
import { DocumentPreviewModal } from "../task/DocumentPreviewModal";
import { Modal } from "../Modal";
import type { Task, CalendarEvent } from "taskify-core";
import type { TaskDocument } from "../../lib/documents";

// Print and scan (with the QR tools) load only when one of their sheets opens.
const PrintSheets = lazy(() => import("../print/PrintSheets").then((m) => ({ default: m.PrintSheets })));

type AppModalStackProps = PrintSheetsProps & {
  addBoardOpen: boolean;
  closeAddBoard: () => void;
  createBoardFromName: (name: string, type: "lists" | "compound", shared?: boolean) => string | null;
  deleteCalendarEvent: (id: string, options?: any) => void;
  deleteTask: (id: string, options?: any) => void;
  handleDownloadDocument: (doc: TaskDocument) => void;
  handleOnboardingStart: () => boolean;
  handleOnboardingRestoreFromBackupFile: (file: File) => Promise<void>;
  handleOnboardingUseExistingKey: (value: string) => boolean;
  joinSharedBoard: (nostrId: string, name?: string, relayCsv?: string) => void;
  previewDocument: TaskDocument | null;
  previewDocumentBoardId: string | undefined;
  recurringDeleteEvent: CalendarEvent | null;
  recurringDeleteTask: Task | null;
  setPreviewDocument: (document: TaskDocument | null) => void;
  setPreviewDocumentBoardId: (boardId: string | undefined) => void;
  setRecurringDeleteEvent: (event: CalendarEvent | null) => void;
  setRecurringDeleteTask: (task: Task | null) => void;
  showFirstRunOnboarding: boolean;
  undoDelete: () => void;
  undoTask: Task | null;
};

export function AppModalStack({
  addBoardOpen,
  closeAddBoard,
  createBoardFromName,
  deleteCalendarEvent,
  deleteTask,
  handleDownloadDocument,
  handleOnboardingRestoreFromBackupFile,
  handleOnboardingStart,
  handleOnboardingUseExistingKey,
  joinSharedBoard,
  previewDocument,
  previewDocumentBoardId,
  recurringDeleteEvent,
  recurringDeleteTask,
  setPreviewDocument,
  setPreviewDocumentBoardId,
  setRecurringDeleteEvent,
  setRecurringDeleteTask,
  showFirstRunOnboarding,
  undoDelete,
  undoTask,
  ...print
}: AppModalStackProps) {
  return (
    <>
      {undoTask && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bg-surface-muted border border-surface text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3 z-[9999]"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--app-tab-pill-offset) + 0.75rem)" }}
        >
          Task deleted
          <button onClick={undoDelete} className="accent-button button-sm pressable">Undo</button>
        </div>
      )}

      {recurringDeleteTask && (
        <Modal onClose={() => setRecurringDeleteTask(null)} title="Delete recurring task">
          <RecurringDeleteBody
            description="This task repeats. Do you want to delete just this event or all future events in the series?"
            onDeleteOne={() => {
              deleteTask(recurringDeleteTask.id, { skipPrompt: true });
              setRecurringDeleteTask(null);
            }}
            onDeleteFuture={() => {
              deleteTask(recurringDeleteTask.id, { skipPrompt: true, scope: "future" });
              setRecurringDeleteTask(null);
            }}
          />
        </Modal>
      )}

      {recurringDeleteEvent && (
        <Modal onClose={() => setRecurringDeleteEvent(null)} title="Delete recurring event">
          <RecurringDeleteBody
            description="This event repeats. Do you want to delete just this event or all future events in the series?"
            onDeleteOne={() => {
              deleteCalendarEvent(recurringDeleteEvent.id, { skipPrompt: true });
              setRecurringDeleteEvent(null);
            }}
            onDeleteFuture={() => {
              deleteCalendarEvent(recurringDeleteEvent.id, { skipPrompt: true, scope: "future" });
              setRecurringDeleteEvent(null);
            }}
          />
        </Modal>
      )}

      {previewDocument && (
        <DocumentPreviewModal
          document={previewDocument}
          boardId={previewDocumentBoardId}
          onClose={() => {
            setPreviewDocument(null);
            setPreviewDocumentBoardId(undefined);
          }}
          onDownloadDocument={handleDownloadDocument}
        />
      )}

      {(print.biblePrintOpen || print.bibleScanOpen || print.boardPrintOpen || print.boardScanOpen) && (
        <Suspense fallback={null}>
          <PrintSheets {...print} />
        </Suspense>
      )}

      {showFirstRunOnboarding && (
        <Modal onClose={() => {}} title="Welcome to Taskify" showClose={false}>
          <FirstRunOnboarding
            onStart={handleOnboardingStart}
            onUseExistingKey={handleOnboardingUseExistingKey}
            onRestoreFromBackupFile={handleOnboardingRestoreFromBackupFile}
          />
        </Modal>
      )}

      {addBoardOpen && (
        <AddBoardModal
          onClose={closeAddBoard}
          onCreateBoard={createBoardFromName}
          onJoinBoard={joinSharedBoard}
        />
      )}
    </>
  );
}

function RecurringDeleteBody({
  description,
  onDeleteFuture,
  onDeleteOne,
}: {
  description: string;
  onDeleteFuture: () => void;
  onDeleteOne: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-secondary">{description}</div>
      <div className="flex flex-wrap gap-2">
        <button className="ghost-button button-sm pressable" onClick={onDeleteOne}>
          Delete this event
        </button>
        <button className="ghost-button button-sm pressable text-rose-400" onClick={onDeleteFuture}>
          Delete all future
        </button>
      </div>
    </div>
  );
}
