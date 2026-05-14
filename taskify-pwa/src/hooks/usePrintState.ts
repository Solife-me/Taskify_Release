import { useEffect, useState } from "react";
import { isPrintPaperSize, type PrintPaperSize } from "../components/printPaper";
import { kvStorage } from "../storage/kvStorage";

const LS_BIBLE_PRINT_PAPER = "taskify_bible_print_paper_v1";

function loadBiblePrintPaperSize(): PrintPaperSize {
  try {
    const raw = kvStorage.getItem(LS_BIBLE_PRINT_PAPER);
    return isPrintPaperSize(raw) ? raw : "letter";
  } catch {
    return "letter";
  }
}

function persistBiblePrintPaperSize(paperSize: PrintPaperSize): void {
  try {
    kvStorage.setItem(LS_BIBLE_PRINT_PAPER, paperSize);
  } catch {}
}

export function useBiblePrintPaperSize() {
  const [biblePrintPaperSize, setBiblePrintPaperSize] = useState<PrintPaperSize>(() => loadBiblePrintPaperSize());
  useEffect(() => {
    persistBiblePrintPaperSize(biblePrintPaperSize);
  }, [biblePrintPaperSize]);
  return [biblePrintPaperSize, setBiblePrintPaperSize] as const;
}

export function usePrintPortal(className: string) {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = document.createElement("div");
    node.className = className;
    document.body.appendChild(node);
    setPortal(node);
    return () => {
      node.remove();
      setPortal(null);
    };
  }, [className]);
  return portal;
}
