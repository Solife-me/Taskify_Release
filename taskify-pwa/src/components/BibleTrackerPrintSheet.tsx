import React, { useMemo } from "react";

import { TOTAL_BIBLE_CHAPTERS, type BibleTrackerState } from "../domains/scripture/bibleTrackerModel";
import { buildBiblePrintLayout } from "./BibleTrackerPrintLayout";
import { getPaperDefinition, PRINT_PAPER_OPTIONS, type PrintPaperSize } from "./printPaper";

export type BiblePrintMeta = {
  id: string;
  printedAtISO: string;
};

const PRINT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function countChapters(progress: Record<string, number[]>): number {
  let total = 0;
  for (const chapters of Object.values(progress || {})) {
    if (!Array.isArray(chapters)) continue;
    total += chapters.length;
  }
  return total;
}

function formatPrintDate(iso: string): string {
  try {
    return PRINT_DATE_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function BibleTrackerPrintPreview({
  state,
  meta,
  paperSize,
  onPaperSizeChange,
}: {
  state: BibleTrackerState;
  meta: BiblePrintMeta;
  paperSize: PrintPaperSize;
  onPaperSizeChange: (paperSize: PrintPaperSize) => void;
}) {
  const layout = useMemo(() => buildBiblePrintLayout(paperSize), [paperSize]);
  const totalRead = countChapters(state.progress || {});
  const printedDate = formatPrintDate(meta.printedAtISO);
  const paperDefinition = getPaperDefinition(paperSize);
  const readLookup = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const [bookId, chapters] of Object.entries(state.progress || {})) {
      if (!Array.isArray(chapters)) continue;
      map.set(bookId, new Set(chapters));
    }
    return map;
  }, [state.progress]);
  const pageIdRowWidthMm =
    layout.pageId.count * layout.pageId.sizeMm + (layout.pageId.count - 1) * layout.pageId.gapMm;
  const headerRightStyle = { paddingRight: `${pageIdRowWidthMm + 1.5}mm` } as React.CSSProperties;

  return (
    <div className="bible-print-root" data-paper-size={paperSize}>
      <div className="bible-print-controls text-sm text-secondary">
        <div className="flex flex-wrap items-center gap-2">
          <span>Paper size</span>
          <select
            className="print-paper-select"
            value={paperSize}
            onChange={(event) => onPaperSizeChange(event.target.value as PrintPaperSize)}
            aria-label="Paper size"
          >
            {PRINT_PAPER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-tertiary">
            {layout.page.count} page{layout.page.count === 1 ? "" : "s"} on {paperDefinition.shortLabel} paper
          </span>
        </div>
        <div className="text-xs text-secondary">
          {paperSize === "a6" ? "A6 layout leaves a left margin for ring holes. " : ""}
          Fill the boxes with a dark pen or marker, then scan from the tracker board to update your progress.
          {" "}On iOS, use Export PDF for printing to avoid Safari headers/footers.
        </div>
      </div>
      <div className="bible-print-pages">
        {layout.pages.map((page) => {
          const headerStyle = {
            left: `${layout.header.leftMm}mm`,
            top: `${layout.header.topMm}mm`,
            width: `${layout.header.widthMm}mm`,
            height: `${layout.header.heightMm}mm`,
          } as React.CSSProperties;
          const isLastPage = page.index === layout.pages.length - 1;
          const pageStyle: React.CSSProperties = {
            width: `${layout.page.widthMm}mm`,
            height: `${layout.page.heightMm}mm`,
            pageBreakAfter: isLastPage ? "auto" : "always",
            breakAfter: isLastPage ? "auto" : "page",
          };
          const pageNumber = page.index + 1;
          return (
            <div
              key={page.index}
              className="bible-print-page"
              style={pageStyle}
            >
              {Object.entries(layout.markers.positionsMm).map(([key, pos]) => {
                const markerStyle = layout.markers.styles[key as keyof typeof layout.markers.styles];
                return (
                  <div
                    key={key}
                    className="bible-print-marker"
                    data-marker-style={markerStyle}
                    style={{
                      width: `${layout.markers.sizeMm}mm`,
                      height: `${layout.markers.sizeMm}mm`,
                      left: `${pos.x}mm`,
                      top: `${pos.y}mm`,
                    }}
                  />
                );
              })}
              {layout.pageId.positionsMm.map((pos, bitIndex) => {
                const bit = layout.pageId.patterns[page.index]?.[bitIndex] ?? 0;
                return (
                  <div
                    key={`page-id-${bitIndex}`}
                    className="bible-print-page-id__bit"
                    data-filled={bit ? "true" : undefined}
                    style={{
                      width: `${layout.pageId.sizeMm}mm`,
                      height: `${layout.pageId.sizeMm}mm`,
                      left: `${pos.x}mm`,
                      top: `${pos.y}mm`,
                    }}
                  />
                );
              })}
              <div className="bible-print-header" style={headerStyle}>
                <div className="bible-print-header__left">
                  <div className="bible-print-header__title">Bible tracker print</div>
                  <div className="bible-print-header__meta">
                    {totalRead}/{TOTAL_BIBLE_CHAPTERS} chapters | Printed {printedDate} | Layout {layout.version}
                  </div>
                </div>
                <div className="bible-print-header__right" style={headerRightStyle}>
                  <div className="bible-print-header__page">
                    Page {pageNumber} of {layout.page.count}
                  </div>
                  <div className="bible-print-header__id">ID {meta.id.slice(0, 8).toUpperCase()}</div>
                </div>
              </div>
              {page.blocks.map((block) => (
                <React.Fragment key={block.bookId}>
                  <div
                    className="bible-print-book"
                    style={{ left: `${block.x}mm`, top: `${block.y}mm`, width: `${layout.columns.widthMm}mm` }}
                  >
                    {block.name}
                  </div>
                  {block.boxes.map((box) => {
                    const readSet = readLookup.get(box.bookId);
                    const isRead = readSet ? readSet.has(box.chapter) : false;
                    return (
                      <div
                        key={`${box.bookId}-${box.chapter}`}
                        className="bible-print-box"
                        data-filled={isRead ? "true" : undefined}
                        style={{
                          width: `${layout.boxes.sizeMm}mm`,
                          height: `${layout.boxes.sizeMm}mm`,
                          left: `${box.x}mm`,
                          top: `${box.y}mm`,
                        }}
                      >
                        <span className="bible-print-box-number">{box.chapter}</span>
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
