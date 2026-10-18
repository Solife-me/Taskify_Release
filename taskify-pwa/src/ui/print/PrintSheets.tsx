/** Print and scan sheets for boards and the Bible tracker, loaded lazily by AppModalStack. */
import { createPortal } from "react-dom";
import type { BoardPrintJob } from "../../components/BoardPrintLayout";
import { BoardPrintPreview } from "../../components/BoardPrintSheet";
import { BoardScanPanel } from "../../components/BoardScanSheet";
import type { BiblePrintMeta } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerPrintPreview } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerScanPanel } from "../../components/BibleTrackerScanSheet";
import type { BibleTrackerProgress, BibleTrackerState } from "../../domains/scripture/bibleTrackerModel";
import type { PrintPaperSize } from "../../components/printPaper";
import { Modal } from "../Modal";

export type PrintSheetsProps = {
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
  handleApplyBibleScan: (scanProgress: BibleTrackerProgress) => void;
  handleApplyBoardScan: (taskIds: string[]) => void;
  handleBiblePaperSizeChange: (paperSize: PrintPaperSize) => void;
  handleBoardPaperSizeChange: (paperSize: PrintPaperSize) => void;
  handleExportBiblePdf: () => void;
  handleExportBoardPdf: () => void;
  handlePrintBibleWindow: () => void;
  handlePrintBoardWindow: () => void;
  setBiblePrintOpen: (open: boolean) => void;
  setBibleScanOpen: (open: boolean) => void;
  setBoardPrintOpen: (open: boolean) => void;
  setBoardScanOpen: (open: boolean) => void;
};

export function PrintSheets({
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
  handleApplyBibleScan,
  handleApplyBoardScan,
  handleBiblePaperSizeChange,
  handleBoardPaperSizeChange,
  handleExportBiblePdf,
  handleExportBoardPdf,
  handlePrintBibleWindow,
  handlePrintBoardWindow,
  setBiblePrintOpen,
  setBibleScanOpen,
  setBoardPrintOpen,
  setBoardScanOpen,
}: PrintSheetsProps) {
  return (
    <>
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
    </>
  );
}
