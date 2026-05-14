import { createPortal } from "react-dom";
import type { BoardPrintJob } from "../../components/BoardPrintLayout";
import { BoardPrintPreview } from "../../components/BoardPrintSheet";
import { BoardScanPanel } from "../../components/BoardScanSheet";
import type { BiblePrintMeta } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerPrintPreview } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerScanPanel } from "../../components/BibleTrackerScanSheet";
import type { BibleTrackerProgress, BibleTrackerState } from "../../components/BibleTracker";
import type { PrintPaperSize } from "../../components/printPaper";
import { FirstRunOnboarding } from "../../onboarding/FirstRunOnboarding";
import { AddBoardModal } from "../board/AddBoardModal";
import { DocumentPreviewModal } from "../task/DocumentPreviewModal";
import { Modal } from "../Modal";
import type { Task, CalendarEvent } from "taskify-core";
import type { TaskDocument } from "../../lib/documents";

type AppModalStackProps = {
  addBoardOpen: boolean;
  biblePrintMeta: BiblePrintMeta | null;
  biblePrintOpen: boolean;
  biblePrintPaperSize: PrintPaperSize;
  biblePrintPdfBusy: boolean;
  biblePrintPortal: HTMLDivElement | null;
  bibleScanOpen: boolean;
  bibleTracker: BibleTrackerState;
  boardPrintJob: BoardPrintJob | null;
  boardPrintOpen: boolean;
  boardPrintPdfBusy: boolean;
  boardPrintPortal: HTMLDivElement | null;
  boardScanOpen: boolean;
  closeAddBoard: () => void;
  completeFirstRunOnboarding: () => void;
  createBoardFromName: (name: string, type: "lists" | "compound", shared?: boolean) => string | null;
  deleteCalendarEvent: (id: string, options?: any) => void;
  deleteTask: (id: string, options?: any) => void;
  handleApplyBibleScan: (scanProgress: BibleTrackerProgress) => void;
  handleApplyBoardScan: (taskIds: string[]) => void;
  handleBiblePaperSizeChange: (paperSize: PrintPaperSize) => void;
  handleBoardPaperSizeChange: (paperSize: PrintPaperSize) => void;
  handleDownloadDocument: (doc: TaskDocument) => void;
  handleExportBiblePdf: () => void;
  handleExportBoardPdf: () => void;
  handleOnboardingEnableNotifications: () => Promise<void>;
  handleOnboardingGenerateNewKey: () => { nsec: string } | null;
  handleOnboardingRestoreFromBackupFile: (file: File) => Promise<void>;
  handleOnboardingRestoreFromCloud: (value: string) => Promise<void>;
  handleOnboardingUseExistingKey: (value: string) => boolean;
  handlePrintBibleWindow: () => void;
  handlePrintBoardWindow: () => void;
  joinSharedBoard: (nostrId: string, name?: string, relayCsv?: string) => void;
  onboardingPushConfigured: boolean;
  onboardingPushSupported: boolean;
  previewDocument: TaskDocument | null;
  previewDocumentBoardId: string | undefined;
  recurringDeleteEvent: CalendarEvent | null;
  recurringDeleteTask: Task | null;
  setBiblePrintOpen: (open: boolean) => void;
  setBibleScanOpen: (open: boolean) => void;
  setBoardPrintOpen: (open: boolean) => void;
  setBoardScanOpen: (open: boolean) => void;
  setPreviewDocument: (document: TaskDocument | null) => void;
  setPreviewDocumentBoardId: (boardId: string | undefined) => void;
  setRecurringDeleteEvent: (event: CalendarEvent | null) => void;
  setRecurringDeleteTask: (task: Task | null) => void;
  showFirstRunOnboarding: boolean;
  undoDelete: () => void;
  undoTask: Task | null;
  workerBaseUrl: string;
};

export function AppModalStack({
  addBoardOpen,
  biblePrintMeta,
  biblePrintOpen,
  biblePrintPaperSize,
  biblePrintPdfBusy,
  biblePrintPortal,
  bibleScanOpen,
  bibleTracker,
  boardPrintJob,
  boardPrintOpen,
  boardPrintPdfBusy,
  boardPrintPortal,
  boardScanOpen,
  closeAddBoard,
  completeFirstRunOnboarding,
  createBoardFromName,
  deleteCalendarEvent,
  deleteTask,
  handleApplyBibleScan,
  handleApplyBoardScan,
  handleBiblePaperSizeChange,
  handleBoardPaperSizeChange,
  handleDownloadDocument,
  handleExportBiblePdf,
  handleExportBoardPdf,
  handleOnboardingEnableNotifications,
  handleOnboardingGenerateNewKey,
  handleOnboardingRestoreFromBackupFile,
  handleOnboardingRestoreFromCloud,
  handleOnboardingUseExistingKey,
  handlePrintBibleWindow,
  handlePrintBoardWindow,
  joinSharedBoard,
  onboardingPushConfigured,
  onboardingPushSupported,
  previewDocument,
  previewDocumentBoardId,
  recurringDeleteEvent,
  recurringDeleteTask,
  setBiblePrintOpen,
  setBibleScanOpen,
  setBoardPrintOpen,
  setBoardScanOpen,
  setPreviewDocument,
  setPreviewDocumentBoardId,
  setRecurringDeleteEvent,
  setRecurringDeleteTask,
  showFirstRunOnboarding,
  undoDelete,
  undoTask,
  workerBaseUrl,
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

      {biblePrintPortal && biblePrintOpen && biblePrintMeta &&
        createPortal(
          <BibleTrackerPrintPreview
            state={bibleTracker}
            meta={biblePrintMeta}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />,
          biblePrintPortal
        )}

      {biblePrintOpen && biblePrintMeta && (
        <Modal
          onClose={() => setBiblePrintOpen(false)}
          title="Print Bible tracker"
          actions={(
            <>
              <button
                className="accent-button button-sm pressable"
                onClick={handleExportBiblePdf}
                disabled={biblePrintPdfBusy}
              >
                {biblePrintPdfBusy ? "Preparing PDF..." : "Export PDF"}
              </button>
              <button className="ghost-button button-sm pressable" onClick={handlePrintBibleWindow}>
                Print
              </button>
            </>
          )}
        >
          <BibleTrackerPrintPreview
            state={bibleTracker}
            meta={biblePrintMeta}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />
        </Modal>
      )}

      {bibleScanOpen && (
        <Modal onClose={() => setBibleScanOpen(false)} title="Scan Bible tracker">
          <BibleTrackerScanPanel
            state={bibleTracker}
            onApply={handleApplyBibleScan}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />
        </Modal>
      )}

      {boardPrintPortal && boardPrintOpen && boardPrintJob &&
        createPortal(
          <BoardPrintPreview
            job={boardPrintJob}
            paperSize={boardPrintJob.paperSize}
            onPaperSizeChange={handleBoardPaperSizeChange}
          />,
          boardPrintPortal
        )}

      {boardPrintOpen && boardPrintJob && (
        <Modal
          onClose={() => setBoardPrintOpen(false)}
          title={`Print ${boardPrintJob.boardName || "board"}`}
          actions={(
            <>
              <button
                className="accent-button button-sm pressable"
                onClick={handleExportBoardPdf}
                disabled={boardPrintPdfBusy}
              >
                {boardPrintPdfBusy ? "Preparing PDF..." : "Export PDF"}
              </button>
              <button className="ghost-button button-sm pressable" onClick={handlePrintBoardWindow}>
                Print
              </button>
            </>
          )}
        >
          <BoardPrintPreview
            job={boardPrintJob}
            paperSize={boardPrintJob.paperSize}
            onPaperSizeChange={handleBoardPaperSizeChange}
          />
        </Modal>
      )}

      {boardScanOpen && boardPrintJob && (
        <Modal onClose={() => setBoardScanOpen(false)} title={`Scan ${boardPrintJob.boardName || "board"}`}>
          <BoardScanPanel job={boardPrintJob} onApply={handleApplyBoardScan} />
        </Modal>
      )}

      {showFirstRunOnboarding && (
        <Modal onClose={() => {}} title="Welcome to Taskify" showClose={false}>
          <FirstRunOnboarding
            pushSupported={onboardingPushSupported}
            pushConfigured={onboardingPushConfigured}
            cloudRestoreAvailable={!!workerBaseUrl}
            onUseExistingKey={handleOnboardingUseExistingKey}
            onGenerateNewKey={handleOnboardingGenerateNewKey}
            onRestoreFromBackupFile={handleOnboardingRestoreFromBackupFile}
            onRestoreFromCloud={handleOnboardingRestoreFromCloud}
            onEnableNotifications={handleOnboardingEnableNotifications}
            onComplete={completeFirstRunOnboarding}
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
