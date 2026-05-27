import {
  arrayBufferFromDataUrl,
  ensureDocumentPreview,
  generateDocumentId,
  getDocumentBuffer,
  guessDocumentMime,
  inferDocumentKind,
  isAudioDocumentKind,
  isImageDocumentKind,
  isSupportedDocumentFile,
  isTextDocumentKind,
  isVideoDocumentKind,
  type TaskDocument,
  type TaskDocumentKind,
  type TaskDocumentPreview,
} from "./documents";

const SPREADSHEET_PREVIEW_ROWS = 12;
const SPREADSHEET_PREVIEW_COLS = 6;
const SPREADSHEET_FULL_ROWS = 500;
const SPREADSHEET_FULL_COLS = 50;
let markdownRendererPromise: Promise<{ render: (markdown: string) => string }> | null = null;

type DocxBlock = { html: string; pageBreakAfter?: boolean };

async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdownRendererPromise) {
    markdownRendererPromise = import("markdown-it").then((module) => {
      const MarkdownIt = module.default;
      return new MarkdownIt({ html: false, linkify: true, breaks: true });
    });
  }
  const renderer = await markdownRendererPromise;
  return renderer.render(markdown);
}

async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export async function ensurePdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then(async (module) => {
      try {
        const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        const workerSrc = (workerModule as any).default || workerModule;
        (module as any).GlobalWorkerOptions.workerSrc = workerSrc;
      } catch {
        // Ignore worker configuration failures; pdf.js will fall back to the default bundle.
      }
      return module;
    });
  }
  return pdfjsPromise;
}

async function generatePdfPreview(buffer: ArrayBuffer): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  try {
    const pdfjs = await ensurePdfjs();
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const targetWidth = 320;
    const scale = Math.min(targetWidth / viewport.width, 1.5);
    const scaledViewport = page.getViewport({ scale: scale > 0 ? scale : 1 });
    const canvas = document.createElement("canvas");
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    await page.render({ canvas, canvasContext: ctx, viewport: scaledViewport }).promise;
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

async function generateVideoPreview(dataUrl: string): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  try {
    const video = document.createElement("video");
    video.src = dataUrl;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("video preview failed")), { once: true });
    });
    video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 2 : 0.1);
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      setTimeout(resolve, 250);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 180;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPrintableTextChar(ch: string): boolean {
  const codePoint = ch.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    codePoint >= 0xa0
  );
}

function docxLocalName(el: Element): string {
  return el.localName || el.tagName.replace(/^w:/, "");
}

function convertDocxRun(run: Element): { html: string; pageBreakAfter: boolean } {
  let html = "";
  let pageBreakAfter = false;
  const isBold = run.getElementsByTagName("w:b").length > 0;
  const isItalic = run.getElementsByTagName("w:i").length > 0;
  const isUnderline = run.getElementsByTagName("w:u").length > 0;
  for (const node of Array.from(run.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      html += escapeHtml(node.textContent || "");
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const name = docxLocalName(child);
    if (name === "t") {
      html += escapeHtml(child.textContent || "");
    } else if (name === "tab") {
      html += "&nbsp;&nbsp;&nbsp;";
    } else if (name === "br") {
      const type = child.getAttribute("w:type") || child.getAttribute("type");
      if (type === "page") pageBreakAfter = true;
      else html += "<br/>";
    } else if (name === "lastRenderedPageBreak") {
      pageBreakAfter = true;
    }
  }
  if (!html) return { html: "", pageBreakAfter };
  if (isUnderline) html = `<u>${html}</u>`;
  if (isItalic) html = `<em>${html}</em>`;
  if (isBold) html = `<strong>${html}</strong>`;
  return { html, pageBreakAfter };
}

function convertDocxParagraph(para: Element): DocxBlock {
  const chunks: string[] = [];
  let pageBreakAfter = false;
  for (const child of Array.from(para.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const name = docxLocalName(el);
    if (name === "r") {
      const runFragment = convertDocxRun(el);
      if (runFragment.html) chunks.push(runFragment.html);
      if (runFragment.pageBreakAfter) pageBreakAfter = true;
    } else if (name === "hyperlink") {
      const linkRuns: string[] = [];
      let linkBreak = false;
      for (const linkChild of Array.from(el.childNodes)) {
        if (linkChild.nodeType !== Node.ELEMENT_NODE) continue;
        const lr = convertDocxRun(linkChild as Element);
        if (lr.html) linkRuns.push(lr.html);
        if (lr.pageBreakAfter) linkBreak = true;
      }
      const rel = el.getAttribute("r:id") || "";
      const linkLabel = linkRuns.join("") || rel;
      chunks.push(`<span class="docx-link">${linkLabel}</span>`);
      if (linkBreak) pageBreakAfter = true;
    } else if (name === "fldSimple") {
      const instruction = el.getAttribute("w:instr") || "";
      const normalized = instruction.replace(/["']/g, "").trim().toLowerCase();
      if (normalized.includes("page \\* mergeformat")) {
        continue;
      }
      for (const fldChild of Array.from(el.childNodes)) {
        if (fldChild.nodeType === Node.ELEMENT_NODE) {
          const runFragment = convertDocxRun(fldChild as Element);
          if (runFragment.html) chunks.push(runFragment.html);
          if (runFragment.pageBreakAfter) pageBreakAfter = true;
        }
      }
    }
  }
  const html = chunks.length ? `<p>${chunks.join("")}</p>` : "";
  return { html, pageBreakAfter };
}

function convertDocxTable(table: Element): DocxBlock {
  const rowsHtml: string[] = [];
  let pageBreakAfter = false;
  for (const rowNode of Array.from(table.childNodes)) {
    if (rowNode.nodeType !== Node.ELEMENT_NODE) continue;
    const rowEl = rowNode as Element;
    if (docxLocalName(rowEl) !== "tr") continue;
    const cellsHtml: string[] = [];
    for (const cellNode of Array.from(rowEl.childNodes)) {
      if (cellNode.nodeType !== Node.ELEMENT_NODE) continue;
      const cellEl = cellNode as Element;
      if (docxLocalName(cellEl) !== "tc") continue;
      const innerBlocks: DocxBlock[] = [];
      for (const cellChild of Array.from(cellEl.childNodes)) {
        if (cellChild.nodeType !== Node.ELEMENT_NODE) continue;
        const cellChildEl = cellChild as Element;
        const name = docxLocalName(cellChildEl);
        if (name === "p") innerBlocks.push(convertDocxParagraph(cellChildEl));
      }
      const innerHtml = innerBlocks.map((block) => block.html).join("") || "<p>&nbsp;</p>";
      if (innerBlocks.some((block) => block.pageBreakAfter)) {
        pageBreakAfter = true;
      }
      cellsHtml.push(`<td>${innerHtml}</td>`);
    }
    rowsHtml.push(`<tr>${cellsHtml.join("")}</tr>`);
  }
  const html = rowsHtml.length ? `<table class="docx-table"><tbody>${rowsHtml.join("")}</tbody></table>` : "";
  return { html, pageBreakAfter };
}

async function generateDocxMarkup(buffer: ArrayBuffer): Promise<{ previewHtml?: string; fullHtml?: string }> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const docFile = zip.file("word/document.xml");
    if (!docFile) return {};
    const xmlString = await docFile.async("string");
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) return {};
    const body = xml.getElementsByTagName("w:body")[0];
    if (!body) return {};

    const blocks: DocxBlock[] = [];
    for (const node of Array.from(body.childNodes)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      const name = docxLocalName(element);
      if (name === "p") {
        const block = convertDocxParagraph(element);
        if (block.html) blocks.push(block);
      } else if (name === "tbl") {
        const block = convertDocxTable(element);
        if (block.html) blocks.push(block);
      }
    }
    if (!blocks.length) return {};

    const fullHtml = wrapDocHtml(blocks.map((block) => block.html).join(""));
    const previewBlocks: string[] = [];
    let sawBreak = false;
    for (const block of blocks) {
      if (!sawBreak) previewBlocks.push(block.html);
      if (block.pageBreakAfter && !sawBreak) {
        sawBreak = true;
      }
    }
    const previewHtml = wrapDocHtml(previewBlocks.length ? previewBlocks.join("") : blocks[0].html);
    return { previewHtml, fullHtml };
  } catch {
    return {};
  }
}

function wrapDocHtml(html: string): string {
  return `<div class="doc-fragment">${html}</div>`;
}

async function generateTextDocument(buffer: ArrayBuffer): Promise<{ previewText?: string; fullText?: string }> {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const text = cleanDocText(decoder.decode(new Uint8Array(buffer)));
    if (!text) return {};
    return { previewText: text.slice(0, 2000), fullText: text };
  } catch {
    return {};
  }
}

function cleanDocText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !!line)
    .join("\n");
}

function generateDocBinary(buffer: ArrayBuffer): { previewText?: string; fullText?: string } {
  try {
    const decoder = new TextDecoder("windows-1252", { fatal: false });
    const raw = decoder.decode(new Uint8Array(buffer));
    if (!raw) return {};
    let text = "";
    for (const ch of raw) {
      if (isPrintableTextChar(ch)) {
        text += ch;
      } else if (ch === "\f") {
        text += "\f";
      } else if (ch === "\r" || ch === "\n") {
        text += "\n";
      } else {
        text += " ";
      }
    }
    const parts = text.split("\f");
    const firstPage = parts[0] || text.slice(0, 2000);
    const previewText = cleanDocText(firstPage).slice(0, 2000);
    const fullText = cleanDocText(parts.join("\n"));
    return { previewText, fullText };
  } catch {
    return {};
  }
}

async function generateSpreadsheetMarkup(
  buffer: ArrayBuffer,
  _kind: TaskDocumentKind
): Promise<{ previewHtml?: string; fullHtml?: string }> {
  try {
    if (_kind === "xls") return {};
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const blob = new Blob([buffer]);
    const sheets = await readXlsxFile(blob);
    const firstSheet = Array.isArray(sheets) ? sheets[0] : undefined;
    const sheetName = firstSheet?.sheet || "Sheet 1";
    const rowsArray = Array.isArray(firstSheet?.data) ? (firstSheet.data as Array<Array<unknown>>) : [];
    if (!rowsArray.length) return {};
    const fullColumnCount = Math.min(
      SPREADSHEET_FULL_COLS,
      Math.max(1, ...rowsArray.slice(0, SPREADSHEET_FULL_ROWS).map((row) => row.length)),
    );
    return {
      previewHtml: wrapSheetHtml(rowsArray, SPREADSHEET_PREVIEW_ROWS, SPREADSHEET_PREVIEW_COLS, sheetName),
      fullHtml: wrapSheetHtml(rowsArray, SPREADSHEET_FULL_ROWS, fullColumnCount, sheetName),
    };
  } catch {
    return {};
  }
}

async function generateDocxMarkupRich(buffer: ArrayBuffer): Promise<{ previewHtml?: string; fullHtml?: string }> {
  try {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      includeDefaultStyleMap: true,
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Title'] => h1.doc-title:fresh",
        "p[style-name='Subtitle'] => h2.doc-subtitle:fresh"
      ]
    });
    const html = (result.value || "").trim();
    if (!html) return {};
    return {
      previewHtml: `<div class="doc-rich doc-rich--preview">${html}</div>`,
      fullHtml: `<div class="doc-rich">${html}</div>`,
    };
  } catch {
    return {};
  }
}

function wrapSheetHtml(rows: Array<Array<unknown>>, maxRows: number, maxCols: number, sheetName = "Sheet 1"): string {
  const limitedRows = rows.slice(0, maxRows);
  const body = limitedRows
    .map((row) => {
      const cells = [];
      for (let i = 0; i < maxCols; i += 1) {
        const cell = row?.[i];
        const value = cell === null || cell === undefined ? "" : escapeHtml(String(cell));
        cells.push(`<td>${value || "&nbsp;"}</td>`);
      }
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<div class="doc-sheet"><div class="doc-sheet__tab">${escapeHtml(sheetName)}</div><table><tbody>${body}</tbody></table></div>`;
}

export async function createDocumentFromDataUrl(input: {
  id?: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  createdAt?: string;
  size?: number;
  remoteUrl?: string;
  encrypted?: boolean;
  encryptionBoardId?: string;
}): Promise<TaskDocument> {
  const kind = inferDocumentKind(input.name, input.mimeType);
  if (!kind || kind === "xls") throw new Error("Unsupported file type");
  const buffer = arrayBufferFromDataUrl(input.dataUrl);
  const base: TaskDocument = {
    id: input.id || generateDocumentId(),
    name: input.name,
    mimeType: guessDocumentMime(kind, input.mimeType),
    kind,
    size: typeof input.size === "number" ? input.size : undefined,
    dataUrl: input.dataUrl,
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
    ...(input.encrypted ? { encrypted: true } : {}),
    ...(input.encryptionBoardId ? { encryptionBoardId: input.encryptionBoardId } : {}),
  };

  if (kind === "pdf") {
    const previewImage = await generatePdfPreview(buffer);
    if (previewImage) {
      base.preview = { type: "image", data: previewImage };
    }
  } else if (kind === "docx") {
    const rich = await generateDocxMarkupRich(buffer);
    const fallback = !rich.fullHtml ? await generateDocxMarkup(buffer) : {};
    const previewHtml = rich.previewHtml || fallback.previewHtml;
    const fullHtml = rich.fullHtml || fallback.fullHtml;
    if (previewHtml) base.preview = { type: "html", data: previewHtml };
    if (fullHtml) base.full = { type: "html", data: fullHtml };
  } else if (kind === "doc") {
    const { previewText, fullText } = generateDocBinary(buffer);
    if (previewText) base.preview = { type: "text", data: previewText };
    if (fullText) base.full = { type: "text", data: fullText };
  } else if (kind === "xlsx") {
    const { previewHtml, fullHtml } = await generateSpreadsheetMarkup(buffer, kind);
    if (previewHtml) base.preview = { type: "html", data: previewHtml };
    if (fullHtml) base.full = { type: "html", data: fullHtml };
  } else if (kind === "md") {
    const { fullText } = await generateTextDocument(buffer);
    if (fullText) {
      const rendered = `<div class="doc-rich doc-markdown">${await renderMarkdown(fullText)}</div>`;
      base.preview = { type: "html", data: rendered };
      base.full = { type: "html", data: rendered };
    }
  } else if (isTextDocumentKind(kind)) {
    const { previewText, fullText } = await generateTextDocument(buffer);
    if (previewText) base.preview = { type: "text", data: previewText };
    if (fullText) base.full = { type: "text", data: fullText };
  } else if (isImageDocumentKind(kind)) {
    base.preview = { type: "image", data: input.dataUrl };
    base.full = { type: "image", data: input.dataUrl };
  } else if (isAudioDocumentKind(kind)) {
    base.full = { type: "audio", data: input.dataUrl };
  } else if (isVideoDocumentKind(kind)) {
    const previewImage = await generateVideoPreview(input.dataUrl);
    if (previewImage) base.preview = { type: "image", data: previewImage };
    base.full = { type: "video", data: input.dataUrl };
  }

  return base;
}

export async function createDocumentAttachment(file: File): Promise<TaskDocument> {
  const dataUrl = await readFileAsDataURL(file);
  return createDocumentFromDataUrl({
    name: file.name,
    mimeType: file.type,
    dataUrl,
    size: typeof file.size === "number" ? file.size : undefined,
  });
}

const previewPromiseCache = new Map<string, Promise<TaskDocumentPreview | null>>();

async function buildPreviewFromDocument(doc: TaskDocument): Promise<TaskDocumentPreview | null> {
  const ensured = ensureDocumentPreview(doc);
  if (ensured.preview) return ensured.preview;
  if (ensured.kind === "pdf") return null;

  const buffer = getDocumentBuffer(ensured);
  if (!buffer.byteLength) return null;

  if (ensured.kind === "docx") {
    const rich = await generateDocxMarkupRich(buffer);
    if (rich.previewHtml) return { type: "html", data: rich.previewHtml };
    const { previewHtml } = await generateDocxMarkup(buffer);
    if (previewHtml) return { type: "html", data: previewHtml };
    return null;
  }

  if (ensured.kind === "doc") {
    const { previewText } = generateDocBinary(buffer);
    if (previewText) return { type: "text", data: previewText };
    return null;
  }

  if (ensured.kind === "xls" || ensured.kind === "xlsx") {
    const { previewHtml } = await generateSpreadsheetMarkup(buffer, ensured.kind);
    if (previewHtml) return { type: "html", data: previewHtml };
    return null;
  }

  if (ensured.kind === "md") {
    const { fullText } = await generateTextDocument(buffer);
    if (fullText) return { type: "html", data: `<div class="doc-rich doc-markdown">${await renderMarkdown(fullText)}</div>` };
    return null;
  }

  if (isTextDocumentKind(ensured.kind)) {
    const { previewText } = await generateTextDocument(buffer);
    if (previewText) return { type: "text", data: previewText };
    return null;
  }

  if (isImageDocumentKind(ensured.kind)) return { type: "image", data: ensured.dataUrl };
  return null;
}

export function loadDocumentPreview(doc: TaskDocument): Promise<TaskDocumentPreview | null> {
  if (doc.preview) return Promise.resolve(doc.preview);
  const cached = previewPromiseCache.get(doc.id);
  if (cached) return cached;
  const promise = buildPreviewFromDocument(doc).catch(() => null);
  previewPromiseCache.set(doc.id, promise);
  return promise;
}

export async function readDocumentsFromFiles(list: FileList | File[]): Promise<TaskDocument[]> {
  const files = Array.from(list);
  const attachments: TaskDocument[] = [];
  for (const file of files) {
    if (!isSupportedDocumentFile(file)) {
      throw new Error("Unsupported file type");
    }
    const doc = await createDocumentAttachment(file);
    attachments.push(ensureDocumentPreview(doc));
  }
  return attachments;
}
