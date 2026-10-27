/** Print and scan sheets for boards and the Bible tracker, loaded lazily by AppModalStack. */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../../context/ToastContext";
import type { BoardPrintJob } from "../../components/BoardPrintLayout";
import { BoardPrintPreview } from "../../components/BoardPrintSheet";
import { BoardScanPanel } from "../../components/BoardScanSheet";
import type { BiblePrintMeta } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerPrintPreview } from "../../components/BibleTrackerPrintSheet";
import { BibleTrackerScanPanel } from "../../components/BibleTrackerScanSheet";
import type { BibleTrackerProgress, BibleTrackerState } from "../../domains/scripture/bibleTrackerModel";
import type { PrintPaperSize } from "../../components/printPaper";
import { Modal } from "../Modal";
import { biblePrintCss, boardPrintCss, fileNamePart, openOrSharePdf, openPrintWindow, printInWindow } from "./printOutput";

export type PrintSheetsProps = {
  biblePrintMeta: BiblePrintMeta | null;
  biblePrintOpen: boolean;
  biblePrintPaperSize: PrintPaperSize;
  biblePrintPortal: HTMLDivElement | null;
  bibleScanOpen: boolean;
  bibleTracker: BibleTrackerState;
  boardPrintJob: BoardPrintJob | null;
  boardPrintOpen: boolean;
  boardPrintPortal: HTMLDivElement | null;
  boardScanOpen: boolean;
  handleApplyBibleScan: (scanProgress: BibleTrackerProgress) => void;
  handleApplyBoardScan: (taskIds: string[]) => void;
  handleBiblePaperSizeChange: (paperSize: PrintPaperSize) => void;
  handleBoardPaperSizeChange: (paperSize: PrintPaperSize) => void;
  setBiblePrintOpen: (open: boolean) => void;
  setBibleScanOpen: (open: boolean) => void;
  setBoardPrintOpen: (open: boolean) => void;
  setBoardScanOpen: (open: boolean) => void;
};

export function PrintSheets({
  biblePrintMeta,
  biblePrintOpen,
  biblePrintPaperSize,
  biblePrintPortal,
  bibleScanOpen,
  bibleTracker,
  boardPrintJob,
  boardPrintOpen,
  boardPrintPortal,
  boardScanOpen,
  handleApplyBibleScan,
  handleApplyBoardScan,
  handleBiblePaperSizeChange,
  handleBoardPaperSizeChange,
  setBiblePrintOpen,
  setBibleScanOpen,
  setBoardPrintOpen,
  setBoardScanOpen,
}: PrintSheetsProps) {
  const { show: showToast } = useToast();
  const [biblePrintPdfBusy, setBiblePrintPdfBusy] = useState(false);
  const [boardPrintPdfBusy, setBoardPrintPdfBusy] = useState(false);

  const handlePrintBibleWindow = async () => {
    if (!biblePrintMeta || !biblePrintPortal) return;
    const printWindow = openPrintWindow();
    if (!printWindow) {
      showToast("Popup blocked. Allow popups to print.", 3000);
      return;
    }
    const { buildBiblePrintLayout } = await import("../../components/BibleTrackerPrintLayout");
    const { page } = buildBiblePrintLayout(biblePrintPaperSize);
    printInWindow(printWindow, {
      title: "Bible tracker print",
      css: biblePrintCss(page.widthMm, page.heightMm),
      markup: biblePrintPortal.innerHTML,
    });
  };

  const handleExportBiblePdf = async () => {
    if (!biblePrintMeta || biblePrintPdfBusy) return;
    setBiblePrintPdfBusy(true);
    try {
      const { buildBibleTrackerPrintPdf } = await import("../../lib/printPdf");
      const blob = await buildBibleTrackerPrintPdf({ state: bibleTracker, meta: biblePrintMeta, paperSize: biblePrintPaperSize });
      const fileName = `taskify-bible-tracker-${fileNamePart(biblePrintPaperSize)}-${biblePrintMeta.id.slice(0, 8)}.pdf`;
      await openOrSharePdf(blob, fileName, "Bible tracker print");
    } catch (err) {
      console.warn("Failed to generate Bible tracker PDF", err);
      showToast("Failed to generate PDF. Try again.", 3000);
    } finally {
      setBiblePrintPdfBusy(false);
    }
  };

  const handlePrintBoardWindow = async () => {
    if (!boardPrintJob || !boardPrintPortal) return;
    const printWindow = openPrintWindow();
    if (!printWindow) {
      showToast("Popup blocked. Allow popups to print.", 3000);
      return;
    }
    const { buildBoardPrintLayout } = await import("../../components/BoardPrintLayout");
    const { page } = buildBoardPrintLayout(boardPrintJob.tasks, {
      layoutVersion: boardPrintJob.layoutVersion,
      paperSize: boardPrintJob.paperSize,
    });
    printInWindow(printWindow, {
      title: "Board print",
      css: boardPrintCss(page.widthMm, page.heightMm),
      markup: boardPrintPortal.innerHTML,
    });
  };

  const handleExportBoardPdf = async () => {
    if (!boardPrintJob || boardPrintPdfBusy) return;
    setBoardPrintPdfBusy(true);
    try {
      const { buildBoardPrintPdf } = await import("../../lib/printPdf");
      const blob = await buildBoardPrintPdf({ job: boardPrintJob, paperSize: boardPrintJob.paperSize });
      const boardName = fileNamePart(boardPrintJob.boardName || "board");
      const fileName = `taskify-board-${boardName}-${fileNamePart(boardPrintJob.paperSize)}-${boardPrintJob.id.slice(0, 8)}.pdf`;
      await openOrSharePdf(blob, fileName, `${boardPrintJob.boardName || "Board"} print`);
    } catch (err) {
      console.warn("Failed to generate board PDF", err);
      showToast("Failed to generate PDF. Try again.", 3000);
    } finally {
      setBoardPrintPdfBusy(false);
    }
  };

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
