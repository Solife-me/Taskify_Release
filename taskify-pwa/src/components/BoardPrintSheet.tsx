import React, { useMemo } from "react";

import { buildBoardPrintLayout, type BoardPrintJob } from "./BoardPrintLayout";
import { getPaperDefinition, PRINT_PAPER_OPTIONS, type PrintPaperSize } from "./printPaper";

const PRINT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatPrintDate(iso: string): string {
  try {
    return PRINT_DATE_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function BoardPrintPreview({
  job,
  paperSize,
  onPaperSizeChange,
}: {
  job: BoardPrintJob;
  paperSize: PrintPaperSize;
  onPaperSizeChange: (paperSize: PrintPaperSize) => void;
}) {
  const layout = useMemo(
    () => buildBoardPrintLayout(job.tasks, { layoutVersion: job.layoutVersion, paperSize, jobId: job.id }),
    [job.id, job.layoutVersion, job.tasks, paperSize],
  );
  const hasGroupHeaders = layout.pages.some((page) => page.rows.some((row) => row.kind === "header"));
  const printedDate = formatPrintDate(job.printedAtISO);
  const paperDefinition = getPaperDefinition(paperSize);
  const pageIdRowWidthMm =
    layout.pageId.count * layout.pageId.sizeMm + (layout.pageId.count - 1) * layout.pageId.gapMm;
  const jobCodeRowWidthMm = layout.jobCode
    ? layout.jobCode.count * layout.jobCode.sizeMm + (layout.jobCode.count - 1) * layout.jobCode.gapMm
    : 0;
  const headerRightStyle = { paddingRight: `${Math.max(pageIdRowWidthMm, jobCodeRowWidthMm) + 1.5}mm` } as React.CSSProperties;

  return (
    <div className="board-print-root">
      <div className="board-print-controls text-sm text-secondary">
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
          Fill the circles with a dark pen or marker, then scan from the share sheet to update this board.
          {" "}On iOS, use Export PDF for printing to avoid Safari headers/footers.
        </div>
      </div>
      <div className="board-print-pages">
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
              className="board-print-page"
              style={pageStyle}
            >
              {Object.entries(layout.markers.positionsMm).map(([key, pos]) => {
                const markerStyle = layout.markers.styles[key as keyof typeof layout.markers.styles];
                return (
                  <div
                    key={key}
                    className="board-print-marker"
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
                    className="board-print-page-id__bit"
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
              {layout.jobCode?.positionsMm.map((pos, bitIndex) => {
                const bit = layout.jobCode?.pattern[bitIndex] ?? 0;
                return (
                  <div
                    key={`job-code-${bitIndex}`}
                    className="board-print-job-code__bit"
                    data-filled={bit ? "true" : undefined}
                    style={{
                      width: `${layout.jobCode?.sizeMm ?? 0}mm`,
                      height: `${layout.jobCode?.sizeMm ?? 0}mm`,
                      left: `${pos.x}mm`,
                      top: `${pos.y}mm`,
                    }}
                  />
                );
              })}
              <div className="board-print-header" style={headerStyle}>
                <div className="board-print-header__left">
                  <div className="board-print-header__title">{job.boardName || "Board"} print</div>
                  <div className="board-print-header__meta">
                    {job.tasks.length} task{job.tasks.length === 1 ? "" : "s"} | Printed {printedDate} | Layout {layout.version} | Print {job.id.slice(0, 8).toUpperCase()}
                  </div>
                </div>
                <div className="board-print-header__right" style={headerRightStyle}>
                  <div className="board-print-header__page">
                    Page {pageNumber} of {layout.page.count}
                  </div>
                  <div className="board-print-header__id">ID {job.id.slice(0, 8).toUpperCase()}</div>
                </div>
              </div>
              {page.rows.map((row, rowIndex) => {
                if (row.kind === "header") {
                  return (
                    <div
                      key={`header-${page.index}-${rowIndex}`}
                      className="board-print-group"
                      style={{
                        left: `${row.x}mm`,
                        top: `${row.y}mm`,
                        width: `${row.widthMm}mm`,
                        height: `${layout.rows.heightMm}mm`,
                      }}
                    >
                      <div className="board-print-group__text">
                        {row.label}
                      </div>
                      <div className="board-print-group__rule" />
                    </div>
                  );
                }

                return (
                  <div
                    key={row.taskId}
                    className="board-print-row"
                    style={{
                      left: `${row.x}mm`,
                      top: `${row.y}mm`,
                      width: `${row.widthMm}mm`,
                      height: `${layout.rows.heightMm}mm`,
                    }}
                  >
                    <div
                      className="board-print-circle"
                      style={{
                        width: `${layout.circle.sizeMm}mm`,
                        height: `${layout.circle.sizeMm}mm`,
                      }}
                    />
                    <div className="board-print-title" style={{ width: `${row.textWidthMm}mm` }}>
                      {!hasGroupHeaders && row.label ? <span className="board-print-label">{row.label}</span> : null}
                      {row.title}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
