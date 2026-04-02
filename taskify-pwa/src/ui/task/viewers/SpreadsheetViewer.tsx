import React from "react";

export function SpreadsheetViewer({ html }: { html: string }) {
  return (
    <div className="h-full overflow-auto rounded-[28px] bg-[#15161a] [touch-action:auto]">
      <div className="min-h-full min-w-full p-4">
        <style>{`
          .spreadsheet-viewer table { width: max-content !important; min-width: 100%; border-collapse: collapse; }
          .spreadsheet-viewer th, .spreadsheet-viewer td, .spreadsheet-viewer tr, .spreadsheet-viewer thead, .spreadsheet-viewer tbody {
            position: static !important;
          }
          .spreadsheet-viewer td, .spreadsheet-viewer th {
            white-space: nowrap;
          }
        `}</style>
        <div className="spreadsheet-viewer inline-block min-w-full rounded-[22px] bg-white p-4 text-[#111827] shadow-2xl" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
