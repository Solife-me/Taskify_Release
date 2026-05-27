import { TOTAL_BIBLE_CHAPTERS, type BibleTrackerState } from "../components/BibleTracker";
import { buildBiblePrintLayout } from "../components/BibleTrackerPrintLayout";
import { buildBoardPrintLayout, type BoardPrintJob } from "../components/BoardPrintLayout";
import type { BiblePrintMeta } from "../components/BibleTrackerPrintSheet";
import type { PrintPaperSize } from "../components/printPaper";
import { toBlobPart } from "./binary";

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const PDF_RENDER_DPI = 240;
const JPEG_QUALITY = 0.92;

const PRINT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const ASCII_ENCODER = new TextEncoder();

type PdfImagePage = {
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
};

function formatPrintDate(iso: string): string {
  try {
    return PRINT_DATE_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

function countChapters(progress: Record<string, number[]>): number {
  let total = 0;
  for (const chapters of Object.values(progress || {})) {
    if (!Array.isArray(chapters)) continue;
    total += chapters.length;
  }
  return total;
}

function mmToPx(mm: number): number {
  return (mm / MM_PER_INCH) * PDF_RENDER_DPI;
}

function ptToPx(pt: number): number {
  return (pt / POINTS_PER_INCH) * PDF_RENDER_DPI;
}

function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * POINTS_PER_INCH;
}

function encodeAscii(value: string): Uint8Array {
  return ASCII_ENCODER.encode(value);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function buildPdfStreamObject(dict: string, stream: Uint8Array): Uint8Array {
  return concatBytes([
    encodeAscii(`${dict}\nstream\n`),
    stream,
    encodeAscii("\nendstream"),
  ]);
}

function buildImagePdf(pages: PdfImagePage[]): Uint8Array {
  if (!pages.length) {
    throw new Error("No pages to render.");
  }
  const objectCount = 2 + pages.length * 3;
  const objects: Uint8Array[] = new Array(objectCount);

  const pageObjectIds: number[] = [];
  pages.forEach((_, index) => {
    const pageObjectId = 3 + index * 3 + 2;
    pageObjectIds.push(pageObjectId);
  });

  objects[0] = encodeAscii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = encodeAscii(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const imageObjectId = 3 + index * 3;
    const contentObjectId = imageObjectId + 1;
    const pageObjectId = imageObjectId + 2;
    const imageStream = page.jpeg;
    const imageDict =
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx}` +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode" +
      ` /Length ${imageStream.length} >>`;
    objects[imageObjectId - 1] = buildPdfStreamObject(imageDict, imageStream);

    const content = `q\n${page.widthPt.toFixed(3)} 0 0 ${page.heightPt.toFixed(3)} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encodeAscii(content);
    const contentDict = `<< /Length ${contentBytes.length} >>`;
    objects[contentObjectId - 1] = buildPdfStreamObject(contentDict, contentBytes);

    const pageBody =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.widthPt.toFixed(3)} ${page.heightPt.toFixed(3)}]` +
      ` /Resources << /XObject << /Im0 ${imageObjectId} 0 R >> >>` +
      ` /Contents ${contentObjectId} 0 R >>`;
    objects[pageObjectId - 1] = encodeAscii(pageBody);
  });

  const header = encodeAscii("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const chunks: Uint8Array[] = [header];
  const offsets: number[] = [0];
  let offset = header.length;

  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(offset);
    const objectId = i + 1;
    const objectHeader = encodeAscii(`${objectId} 0 obj\n`);
    const objectFooter = encodeAscii("\nendobj\n");
    const body = objects[i] ?? encodeAscii("<< >>");
    chunks.push(objectHeader, body, objectFooter);
    offset += objectHeader.length + body.length + objectFooter.length;
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const xrefBytes = encodeAscii(xref);
  chunks.push(xrefBytes);
  offset += xrefBytes.length;

  const trailer = encodeAscii(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  chunks.push(trailer);

  return concatBytes(chunks);
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => {
        if (value) resolve(value);
        else reject(new Error("Failed to encode PDF page image."));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

function ellipsize(ctx: CanvasRenderingContext2D, value: string, maxWidthPx: number): string {
  if (!value) return "";
  if (ctx.measureText(value).width <= maxWidthPx) return value;
  const ellipsis = "\u2026";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth >= maxWidthPx) return "";

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, mid);
    if (ctx.measureText(candidate).width + ellipsisWidth <= maxWidthPx) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${ellipsis}`;
}

function renderBiblePrintPageImage(options: {
  state: BibleTrackerState;
  meta: BiblePrintMeta;
  paperSize: PrintPaperSize;
  layout: ReturnType<typeof buildBiblePrintLayout>;
  pageIndex: number;
}): { canvas: HTMLCanvasElement; widthPt: number; heightPt: number } {
  const layout = options.layout;
  const page = layout.pages[options.pageIndex];
  if (!page) {
    throw new Error("Bible print page not found.");
  }

  const widthPx = Math.max(1, Math.round(mmToPx(layout.page.widthMm)));
  const heightPx = Math.max(1, Math.round(mmToPx(layout.page.heightMm)));
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to render PDF page.");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  const totalRead = countChapters(options.state.progress || {});
  const printedDate = formatPrintDate(options.meta.printedAtISO);
  const readLookup = new Map<string, Set<number>>();
  for (const [bookId, chapters] of Object.entries(options.state.progress || {})) {
    if (!Array.isArray(chapters)) continue;
    readLookup.set(bookId, new Set(chapters));
  }

  const pageWidthMm = layout.page.widthMm;
  const markerSizeMm = layout.markers.sizeMm;

  Object.entries(layout.markers.positionsMm).forEach(([key, pos]) => {
    const x = mmToPx(pos.x);
    const y = mmToPx(pos.y);
    const size = mmToPx(markerSizeMm);
    ctx.fillStyle = "#101828";
    ctx.fillRect(x, y, size, size);
    if (layout.markers.styles[key as keyof typeof layout.markers.styles] === "finder") {
      const inner = size * 0.45;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x + (size - inner) / 2, y + (size - inner) / 2, inner, inner);
    }
  });

  layout.pageId.positionsMm.forEach((pos, bitIndex) => {
    const bit = layout.pageId.patterns[page.index]?.[bitIndex] ?? 0;
    const x = mmToPx(pos.x);
    const y = mmToPx(pos.y);
    const size = mmToPx(layout.pageId.sizeMm);
    const border = mmToPx(0.2);
    ctx.lineWidth = border;
    if (bit) {
      ctx.fillStyle = "#101828";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "#101828";
      ctx.strokeRect(x + border / 2, y + border / 2, size - border, size - border);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "rgba(16, 24, 40, 0.2)";
      ctx.strokeRect(x + border / 2, y + border / 2, size - border, size - border);
    }
  });

  const pageIdRowWidthMm =
    layout.pageId.count * layout.pageId.sizeMm + (layout.pageId.count - 1) * layout.pageId.gapMm;
  const headerRightPadMm = pageIdRowWidthMm + 1.5;
  const headerLeftPx = mmToPx(layout.header.leftMm);
  const headerTopPx = mmToPx(layout.header.topMm);
  const headerWidthPx = mmToPx(layout.header.widthMm);
  const headerRightEdgePx = headerLeftPx + headerWidthPx - mmToPx(headerRightPadMm);

  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#101828";
  ctx.font = `600 ${ptToPx(8.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText("Bible tracker print", headerLeftPx, headerTopPx);
  const titleHeightPx = ptToPx(8.5);
  const headerGapPx = ptToPx(1.6);
  ctx.fillStyle = "rgba(16, 24, 40, 0.72)";
  ctx.font = `400 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(
    `${totalRead}/${TOTAL_BIBLE_CHAPTERS} chapters | Printed ${printedDate} | Layout ${layout.version}`,
    headerLeftPx,
    headerTopPx + titleHeightPx + headerGapPx,
  );

  ctx.textAlign = "right";
  ctx.fillStyle = "#101828";
  ctx.font = `600 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(`Page ${page.index + 1} of ${layout.page.count}`, headerRightEdgePx, headerTopPx);
  ctx.fillStyle = "rgba(16, 24, 40, 0.72)";
  ctx.font = `400 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(`ID ${options.meta.id.slice(0, 8).toUpperCase()}`, headerRightEdgePx, headerTopPx + ptToPx(7) + headerGapPx);

  const bookFontPt = options.paperSize === "a6" ? 6.5 : 7;
  const bookFontPx = ptToPx(bookFontPt);
  const boxBorderPx = mmToPx(0.3);
  const boxNumberFontPt = options.paperSize === "a6" ? 4.6 : 5;
  const boxNumberFontPx = ptToPx(boxNumberFontPt);

  page.blocks.forEach((block) => {
    const bookX = mmToPx(block.x);
    const bookY = mmToPx(block.y);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#101828";
    ctx.font = `600 ${bookFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const maxBookWidthPx = mmToPx(layout.columns.widthMm);
    const bookLabel = ellipsize(ctx, block.name, maxBookWidthPx);
    ctx.fillText(bookLabel, bookX, bookY);

    block.boxes.forEach((box) => {
      const readSet = readLookup.get(box.bookId);
      const filled = readSet ? readSet.has(box.chapter) : false;
      const x = mmToPx(box.x);
      const y = mmToPx(box.y);
      const size = mmToPx(layout.boxes.sizeMm);
      ctx.lineWidth = boxBorderPx;
      if (filled) {
        ctx.fillStyle = "#101828";
        ctx.fillRect(x, y, size, size);
        ctx.strokeStyle = "#101828";
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, size, size);
        ctx.strokeStyle = "#1f2937";
      }
      ctx.strokeRect(x + boxBorderPx / 2, y + boxBorderPx / 2, size - boxBorderPx, size - boxBorderPx);

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = `400 ${boxNumberFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.fillStyle = filled ? "rgba(255, 255, 255, 0.8)" : "rgba(16, 24, 40, 0.7)";
      ctx.fillText(String(box.chapter), x + mmToPx(0.2), y + mmToPx(0.1));
    });
  });

  const widthPt = mmToPt(pageWidthMm);
  const heightPt = mmToPt(layout.page.heightMm);
  return { canvas, widthPt, heightPt };
}

function renderBoardPrintPageImage(options: {
  job: BoardPrintJob;
  paperSize: PrintPaperSize;
  layout: ReturnType<typeof buildBoardPrintLayout>;
  pageIndex: number;
}): { canvas: HTMLCanvasElement; widthPt: number; heightPt: number } {
  const layout = options.layout;
  const page = layout.pages[options.pageIndex];
  if (!page) {
    throw new Error("Board print page not found.");
  }

  const hasGroupHeaders = layout.pages.some((entry) => entry.rows.some((row) => row.kind === "header"));
  const widthPx = Math.max(1, Math.round(mmToPx(layout.page.widthMm)));
  const heightPx = Math.max(1, Math.round(mmToPx(layout.page.heightMm)));
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to render PDF page.");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  Object.entries(layout.markers.positionsMm).forEach(([key, pos]) => {
    const x = mmToPx(pos.x);
    const y = mmToPx(pos.y);
    const size = mmToPx(layout.markers.sizeMm);
    ctx.fillStyle = "#101828";
    ctx.fillRect(x, y, size, size);
    if (layout.markers.styles[key as keyof typeof layout.markers.styles] === "finder") {
      const inner = size * 0.45;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x + (size - inner) / 2, y + (size - inner) / 2, inner, inner);
    }
  });

  layout.pageId.positionsMm.forEach((pos, bitIndex) => {
    const bit = layout.pageId.patterns[page.index]?.[bitIndex] ?? 0;
    const x = mmToPx(pos.x);
    const y = mmToPx(pos.y);
    const size = mmToPx(layout.pageId.sizeMm);
    const border = mmToPx(0.2);
    ctx.lineWidth = border;
    if (bit) {
      ctx.fillStyle = "#101828";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "#101828";
      ctx.strokeRect(x + border / 2, y + border / 2, size - border, size - border);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "rgba(16, 24, 40, 0.2)";
      ctx.strokeRect(x + border / 2, y + border / 2, size - border, size - border);
    }
  });

  const pageIdRowWidthMm =
    layout.pageId.count * layout.pageId.sizeMm + (layout.pageId.count - 1) * layout.pageId.gapMm;
  const headerRightPadMm = pageIdRowWidthMm + 1.5;
  const headerLeftPx = mmToPx(layout.header.leftMm);
  const headerTopPx = mmToPx(layout.header.topMm);
  const headerWidthPx = mmToPx(layout.header.widthMm);
  const headerRightEdgePx = headerLeftPx + headerWidthPx - mmToPx(headerRightPadMm);

  const printedDate = formatPrintDate(options.job.printedAtISO);

  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#101828";
  ctx.font = `600 ${ptToPx(9)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(`${options.job.boardName || "Board"} print`, headerLeftPx, headerTopPx);
  const titleHeightPx = ptToPx(9);
  const headerGapPx = ptToPx(1.6);
  ctx.fillStyle = "rgba(16, 24, 40, 0.72)";
  ctx.font = `400 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(
    `${options.job.tasks.length} task${options.job.tasks.length === 1 ? "" : "s"} | Printed ${printedDate} | Layout ${layout.version}`,
    headerLeftPx,
    headerTopPx + titleHeightPx + headerGapPx,
  );

  ctx.textAlign = "right";
  ctx.fillStyle = "#101828";
  ctx.font = `600 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(`Page ${page.index + 1} of ${layout.page.count}`, headerRightEdgePx, headerTopPx);
  ctx.fillStyle = "rgba(16, 24, 40, 0.72)";
  ctx.font = `400 ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(`ID ${options.job.id.slice(0, 8).toUpperCase()}`, headerRightEdgePx, headerTopPx + ptToPx(7) + headerGapPx);

  const circleBorderPx = mmToPx(0.3);
  const circleSizePx = mmToPx(layout.circle.sizeMm);
  const titleFontPx = ptToPx(8);
  const labelFontPx = ptToPx(7);

  page.rows.forEach((row) => {
    if (row.kind === "header") {
      const x = mmToPx(row.x);
      const y = mmToPx(row.y);
      const w = mmToPx(row.widthMm);
      const maxLabelWidthPx = w * 0.6;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(16, 24, 40, 0.6)";
      ctx.font = `700 ${labelFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const label = ellipsize(ctx, row.label.toUpperCase(), maxLabelWidthPx);
      const midY = y + mmToPx(layout.rows.heightMm) / 2;
      ctx.fillText(label, x, midY);
      const labelWidth = ctx.measureText(label).width;
      const ruleX = x + labelWidth + mmToPx(2);
      const ruleY = midY - circleBorderPx / 2;
      ctx.fillStyle = "rgba(16, 24, 40, 0.18)";
      ctx.fillRect(ruleX, ruleY, Math.max(0, x + w - ruleX), circleBorderPx);
      return;
    }

    const circleX = mmToPx(row.circleX);
    const circleY = mmToPx(row.circleY);
    ctx.lineWidth = circleBorderPx;
    ctx.strokeStyle = "#1f2937";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(
      circleX + circleSizePx / 2,
      circleY + circleSizePx / 2,
      circleSizePx / 2,
      circleSizePx / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.stroke();

    const textX = mmToPx(row.textX);
    const maxWidthPx = mmToPx(row.textWidthMm);
    const midY = mmToPx(row.y) + mmToPx(layout.rows.heightMm) / 2;

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    let cursorX = textX;
    let remainingWidth = maxWidthPx;
    if (!hasGroupHeaders && row.label) {
      ctx.fillStyle = "rgba(16, 24, 40, 0.55)";
      ctx.font = `600 ${labelFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const labelText = `${row.label.toUpperCase()} `;
      const fittedLabel = ellipsize(ctx, labelText, Math.max(0, remainingWidth * 0.35));
      ctx.fillText(fittedLabel, cursorX, midY);
      const labelWidth = ctx.measureText(fittedLabel).width;
      cursorX += labelWidth;
      remainingWidth = Math.max(0, maxWidthPx - (cursorX - textX));
    }

    ctx.fillStyle = "#101828";
    ctx.font = `500 ${titleFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const fittedTitle = ellipsize(ctx, row.title, remainingWidth);
    ctx.fillText(fittedTitle, cursorX, midY);
  });

  const widthPt = mmToPt(layout.page.widthMm);
  const heightPt = mmToPt(layout.page.heightMm);
  return { canvas, widthPt, heightPt };
}

export async function buildBibleTrackerPrintPdf(options: {
  state: BibleTrackerState;
  meta: BiblePrintMeta;
  paperSize: PrintPaperSize;
}): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("PDF export is only available in the browser.");
  }
  const layout = buildBiblePrintLayout(options.paperSize);
  const pages: PdfImagePage[] = [];

  for (let pageIndex = 0; pageIndex < layout.page.count; pageIndex += 1) {
    const { canvas, widthPt, heightPt } = renderBiblePrintPageImage({
      state: options.state,
      meta: options.meta,
      paperSize: options.paperSize,
      layout,
      pageIndex,
    });
    const widthPx = canvas.width;
    const heightPx = canvas.height;
    const jpeg = await canvasToJpegBytes(canvas);
    canvas.width = 0;
    canvas.height = 0;
    pages.push({
      jpeg,
      widthPx,
      heightPx,
      widthPt,
      heightPt,
    });
  }

  const pdfBytes = buildImagePdf(pages);
  return new Blob([toBlobPart(pdfBytes)], { type: "application/pdf" });
}

export async function buildBoardPrintPdf(options: {
  job: BoardPrintJob;
  paperSize: PrintPaperSize;
}): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("PDF export is only available in the browser.");
  }

  const layout = buildBoardPrintLayout(options.job.tasks, {
    layoutVersion: options.job.layoutVersion,
    paperSize: options.paperSize,
  });
  const pages: PdfImagePage[] = [];

  for (let pageIndex = 0; pageIndex < layout.page.count; pageIndex += 1) {
    const { canvas, widthPt, heightPt } = renderBoardPrintPageImage({
      job: options.job,
      paperSize: options.paperSize,
      layout,
      pageIndex,
    });
    const widthPx = canvas.width;
    const heightPx = canvas.height;
    const jpeg = await canvasToJpegBytes(canvas);
    canvas.width = 0;
    canvas.height = 0;
    pages.push({
      jpeg,
      widthPx,
      heightPx,
      widthPt,
      heightPt,
    });
  }

  const pdfBytes = buildImagePdf(pages);
  return new Blob([toBlobPart(pdfBytes)], { type: "application/pdf" });
}
