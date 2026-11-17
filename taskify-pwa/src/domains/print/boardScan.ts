import { BOARD_PRINT_MODERN_LAYOUT_VERSION, buildBoardPrintLayout, type BoardPrintJob, type BoardPrintLayout, type BoardPrintTask } from "../../components/BoardPrintLayout";
import { PRINT_PAPER_OPTIONS } from "../../components/printPaper";
import { scanPage, scanTextAnchoredCircles, type ScanMark, type ScanPhoto, type ScanTextLine } from "./scanEngine";

export function boardScanMarks(layout: BoardPrintLayout, pageIndex: number): ScanMark<string>[] {
  const size = layout.circle.sizeMm;
  return layout.pages[pageIndex].rows.flatMap((row) =>
    row.kind === "task" ? [{ key: row.taskId, centerMm: { x: row.circleX + size / 2, y: row.circleY + size / 2 } }] : [],
  );
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function matchingTitles(observed: string, catalog: Array<{ id: string; label: string; title: string }>): string[] {
  const title = normalize(observed);
  const tasks = catalog.map(({ id, label, title: expected }) => ({
    id, expected, text: label && title.startsWith(label + " ") ? title.slice(label.length + 1) : title,
  }));
  const exact = tasks.filter(({ expected, text }) => expected && (expected === title || expected === text));
  if (exact.length) return exact.map(({ id }) => id);
  const ranked = tasks.map(({ id, expected, text }) => {
    const words = new Set(text.split(" "));
    const expectedWords = new Set(expected.split(" "));
    const common = [...words].filter((word) => expectedWords.has(word)).length;
    return { id, score: common >= 3 ? 2 * common / (words.size + expectedWords.size) : 0 };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  return best && best.score >= 0.75 && best.score - (second?.score ?? 0) >= 0.12 ? [best.id] : [];
}

export function identifyBoardScan(
  photo: ScanPhoto,
  lines: ScanTextLine[],
  catalog: BoardPrintTask[],
  boardName: string,
  job: BoardPrintJob | null,
  savedLayout: BoardPrintLayout | null,
  pageSelection: number | "auto",
): { taskIds: string[]; pageIndex: number | null } {
  const liveIDs = new Set(catalog.map(({ id }) => id));
  const normalizedBoard = normalize(boardName);
  const printID = job?.id.slice(0, 8).toLowerCase() ?? "";
  let best: { taskIds: string[]; pageIndex: number | null; quality: number } | undefined;
  const layouts = PRINT_PAPER_OPTIONS.map(({ value: paperSize }) => ({
    paperSize, layoutVersion: BOARD_PRINT_MODERN_LAYOUT_VERSION,
  }));
  // Earlier A6 prints put the left-hand markers inside the extra binding margin.
  layouts.push({ paperSize: "a6", layoutVersion: "v4" });
  for (const geometry of layouts) {
    const layout = buildBoardPrintLayout([], geometry);
    let pageIndex: number | null = null;
    let verifiedGrid: { taskIds: string[]; pageIndex: number } | undefined;
    const result = scanTextAnchoredCircles(photo, layout, lines, {
      leftMm: layout.header.leftMm,
      topMm: layout.content.topMm - 2,
      bottomMm: layout.page.heightMm - layout.marginMm,
      sizeMm: layout.circle.sizeMm,
      gapMm: layout.circle.gapMm,
    }, (pageLines) => {
      const header = pageLines.filter(({ start }) =>
        start.y >= layout.header.topMm - 4 && start.y < layout.content.topMm - 2,
      );
      const knownPrint = /^[0-9a-f]{8}$/.test(printID) && header.some(({ text }) =>
        new RegExp(`\\b(?:print|id)\\s+${printID}\\b`, "i").test(text),
      );
      const correctBoard = header.some(({ start, text }) => {
        if (Math.min(Math.abs(start.x - layout.header.leftMm), Math.abs(start.x - layout.marginMm)) > 4) return false;
        const normalized = normalize(text);
        return [normalizedBoard, normalizedBoard + " print", normalizedBoard + " selected print"].includes(normalized);
      });
      if (!knownPrint && !correctBoard) return undefined;

      const pageNumber = header.map(({ text }) => /\bpage\s+(\d+)\s+of\s+(\d+)\b/i.exec(text))
        .find((match) => match && Number(match[1]) > 0 && Number(match[1]) <= Number(match[2]));
      pageIndex = pageNumber ? Number(pageNumber[1]) - 1 : null;

      const tasks = (knownPrint && job ? job.tasks : catalog).map((task) => ({
        id: task.id, title: normalize(task.title), label: task.label ? normalize(task.label) : "",
      }));
      const usesModernMarkers = layout.version === BOARD_PRINT_MODERN_LAYOUT_VERSION;
      const usesSavedModernMarkers = savedLayout?.version === BOARD_PRINT_MODERN_LAYOUT_VERSION;
      const sameMarkerGeometry = geometry.paperSize !== "a6" || usesModernMarkers === usesSavedModernMarkers;
      if (knownPrint && savedLayout && geometry.paperSize === job?.paperSize && sameMarkerGeometry) {
        try {
          const grid = scanPage(photo, savedLayout, {
            pageSelection,
            pageCount: savedLayout.page.count,
            marksOnPage: (index) => boardScanMarks(savedLayout, index),
            geometry: { shape: "circle", sizeMm: savedLayout.circle.sizeMm },
          });
          if (grid.markAlignment >= 0.9) verifiedGrid = { taskIds: grid.filled, pageIndex: grid.pageIndex };
        } catch {
          // Printed titles can still identify the rows when the page number or grid cannot be read.
        }
      }
      return (text) => {
        const matched = matchingTitles(text, tasks);
        return matched.length === 1 ? matched[0] : undefined;
      };
    });
    // The long printed ID and aligned outlines identify the original rows, including duplicate
    // titles. Prefer the title beside a mark if the reconstructed grid and the photo disagree.
    if (verifiedGrid && (!result || result.filled.every((id) => verifiedGrid?.taskIds.includes(id)))) {
      return { ...verifiedGrid, taskIds: verifiedGrid.taskIds.filter((id) => liveIDs.has(id)) };
    }
    if (result && (!best || result.quality > best.quality)) {
      best = { taskIds: result.filled, pageIndex, quality: result.quality };
    }
  }
  if (!best) {
    throw new Error("Couldn’t match this checklist to the board. Keep the board title and all four corners visible, or take a sharper photo.");
  }
  return { taskIds: best.taskIds.filter((id) => liveIDs.has(id)), pageIndex: best.pageIndex };
}
