/**
 * Getting a print layout onto paper: printing it from a clean window, or sharing or saving it as
 * a PDF. Loaded with the print sheets, never at startup.
 */

/**
 * Opens the window to print into. Call it directly in the click handler, before any `await`, or
 * the browser treats it as an unrequested popup.
 */
export function openPrintWindow(): Window | null {
  if (typeof window === "undefined") return null;
  const printWindow = window.open("", "_blank");
  if (!printWindow) return null;
  try {
    printWindow.opener = null;
  } catch {
    // some browsers do not allow it; the window is still ours
  }
  return printWindow;
}

/** Writes the layout's markup into the window, prints it, and closes the window afterwards. */
export function printInWindow(printWindow: Window, { title, css, markup }: { title: string; css: string; markup: string }): void {
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${markup}</body></html>`);
  printWindow.document.close();
  const triggerPrint = () => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // the user can still print from the window
    }
  };
  if (printWindow.document.readyState === "complete") {
    setTimeout(triggerPrint, 80);
  } else {
    printWindow.addEventListener("load", () => setTimeout(triggerPrint, 80), { once: true });
  }
  printWindow.addEventListener("afterprint", () => printWindow.close(), { once: true });
}

/** Offers the PDF to the share sheet where files can be shared, otherwise downloads it. */
export async function openOrSharePdf(blob: Blob, fileName: string, title: string): Promise<void> {
  if (typeof window === "undefined") return;
  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>;
    canShare?: (data: ShareData) => boolean;
  };
  try {
    const file = new File([blob], fileName, { type: "application/pdf" });
    if (typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
      return;
    }
  } catch {
    // fall back to a download
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.target = "_blank";
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A piece of a file name: letters and digits, words joined by "-". */
export function fileNamePart(value: string): string {
  const cleaned = String(value || "").trim().replace(/[^a-z0-9]+/gi, "-");
  return cleaned.replace(/^-+|-+$/g, "") || "print";
}

/** The print window's styles for the Bible tracker sheets. */
export function biblePrintCss(pageWidthMm: number, pageHeightMm: number): string {
  return `
  * { box-sizing: border-box; }
  @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #101828; height: auto; overflow: visible; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bible-print-root { width: 100%; }
  .bible-print-controls { display: none; }
  .bible-print-pages { display: block; }
  .bible-print-page {
    position: relative;
    width: ${pageWidthMm}mm;
    height: ${pageHeightMm}mm;
    margin: 0;
    background: #ffffff;
    color: #101828;
    page-break-after: always;
    break-after: page;
  }
  .bible-print-marker {
    position: absolute;
    background: #101828;
    border-radius: 2px;
    overflow: hidden;
  }
  .bible-print-marker[data-marker-style="finder"]::after {
    content: "";
    position: absolute;
    width: 45%;
    height: 45%;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #ffffff;
    border-radius: 1px;
  }
  .bible-print-page-id__bit {
    position: absolute;
    border-radius: 0.4mm;
    border: 0.2mm solid rgba(16, 24, 40, 0.2);
    background: #ffffff;
  }
  .bible-print-page-id__bit[data-filled="true"] {
    background: #101828;
    border-color: #101828;
  }
  .bible-print-header {
    position: absolute;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .bible-print-header__left { display: flex; flex-direction: column; gap: 0.1rem; }
  .bible-print-header__title { font-size: 8.5pt; font-weight: 600; }
  .bible-print-header__meta { font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
  .bible-print-header__right { text-align: right; font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
  .bible-print-header__page { font-weight: 600; color: #101828; }
  .bible-print-book { position: absolute; font-size: 7pt; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bible-print-root[data-paper-size="a6"] .bible-print-book { font-size: 6.5pt; line-height: 1; }
  .bible-print-box {
    position: absolute;
    box-sizing: border-box;
    border: 0.3mm solid #1f2937;
    border-radius: 0.6mm;
    background: #ffffff;
  }
  .bible-print-box[data-filled="true"] {
    background: #101828;
    border-color: #101828;
  }
  .bible-print-box-number {
    position: absolute;
    top: 0.1mm;
    left: 0.2mm;
    font-size: 5pt;
    line-height: 1;
    color: rgba(16, 24, 40, 0.7);
  }
  .bible-print-root[data-paper-size="a6"] .bible-print-box-number { font-size: 4.6pt; }
  .bible-print-box[data-filled="true"] .bible-print-box-number {
    color: rgba(255, 255, 255, 0.8);
  }
  @media print {
    .bible-print-page:last-child { break-after: auto; page-break-after: auto; }
  }
    `;
}

/** The print window's styles for board sheets. */
export function boardPrintCss(pageWidthMm: number, pageHeightMm: number): string {
  return `
  * { box-sizing: border-box; }
  @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #101828; height: auto; overflow: visible; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .board-print-root { width: 100%; }
  .board-print-controls { display: none; }
  .board-print-pages { display: block; }
  .board-print-page {
    position: relative;
    width: ${pageWidthMm}mm;
    height: ${pageHeightMm}mm;
    margin: 0;
    background: #ffffff;
    color: #101828;
    page-break-after: always;
    break-after: page;
  }
  .board-print-marker {
    position: absolute;
    background: #101828;
    border-radius: 2px;
    overflow: hidden;
  }
  .board-print-marker[data-marker-style="finder"]::after {
    content: "";
    position: absolute;
    width: 45%;
    height: 45%;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #ffffff;
    border-radius: 1px;
  }
  .board-print-page-id__bit,
  .board-print-job-code__bit {
    position: absolute;
    border-radius: 0.4mm;
    border: 0.2mm solid rgba(16, 24, 40, 0.2);
    background: #ffffff;
  }
  .board-print-page-id__bit[data-filled="true"],
  .board-print-job-code__bit[data-filled="true"] {
    background: #101828;
    border-color: #101828;
  }
  .board-print-header {
    position: absolute;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .board-print-header__left { display: flex; flex-direction: column; gap: 0.1rem; }
  .board-print-header__title { font-size: 9pt; font-weight: 600; }
  .board-print-header__meta { font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
  .board-print-header__right { text-align: right; font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
  .board-print-header__page { font-weight: 600; color: #101828; }
  .board-print-row {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 2.4mm;
  }
  .board-print-circle {
    box-sizing: border-box;
    border: 0.3mm solid #1f2937;
    border-radius: 999px;
    background: #ffffff;
    flex-shrink: 0;
  }
  .board-print-title {
    font-size: 8pt;
    font-weight: 500;
    color: #101828;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .board-print-label {
    font-size: 7pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(16, 24, 40, 0.55);
    margin-right: 0.3rem;
  }
  .board-print-group {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .board-print-group__text {
    font-size: 7pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(16, 24, 40, 0.6);
    white-space: nowrap;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .board-print-group__rule {
    flex: 1;
    height: 0.3mm;
    background: rgba(16, 24, 40, 0.18);
    border-radius: 999px;
  }
  @media print {
    .board-print-page:last-child { break-after: auto; page-break-after: auto; }
  }
    `;
}
