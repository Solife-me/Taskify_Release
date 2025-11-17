import JSZip from "jszip";
import { read, utils } from "xlsx";

export type TaskDocumentKind = "pdf" | "doc" | "docx" | "xls" | "xlsx";

export type TaskDocumentPreview =
  | { type: "image"; data: string }
  | { type: "html"; data: string }
  | { type: "text"; data: string };

export type TaskDocumentFull =
  | { type: "pdf"; data: string }
  | { type: "html"; data: string }
  | { type: "text"; data: string };

export type TaskDocument = {
  id: string;
  name: string;
  mimeType: string;
  kind: TaskDocumentKind;
  size?: number;
  dataUrl: string;
  createdAt: string;
  preview?: TaskDocumentPreview;
  full?: TaskDocumentFull;
};

const EXTENSION_TO_KIND: Record<string, TaskDocumentKind> = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "docx",
  ".xls": "xls",
  ".xlsx": "xlsx",
};

const MIME_TO_KIND: Record<string, TaskDocumentKind> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.ms-word": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

const KIND_MIME_FALLBACK: Record<TaskDocumentKind, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

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

type DocxBlock = { html: string; pageBreakAfter?: boolean };

function inferKind(name: string, mimeType: string): TaskDocumentKind | null {
  const normalizedMime = (mimeType || "").toLowerCase();
  if (normalizedMime && MIME_TO_KIND[normalizedMime]) {
    return MIME_TO_KIND[normalizedMime];
  }
  const lowered = name.toLowerCase().trim();
  const extMatch = lowered.match(/\.[0-9a-z]+$/i);
  if (extMatch) {
    const kind = EXTENSION_TO_KIND[extMatch[0]];
    if (kind) return kind;
  }
  return null;
}

function guessMime(kind: TaskDocumentKind, sourceMime: string): string {
  if (sourceMime && sourceMime.trim()) return sourceMime;
  return KIND_MIME_FALLBACK[kind];
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

export function isSupportedDocumentFile(file: File): boolean {
  return inferKind(file.name, file.type) !== null;
}

export function normalizeDocumentList(raw: unknown): TaskDocument[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: TaskDocument[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof (entry as any).name === "string" ? (entry as any).name : "";
    const dataUrl = typeof (entry as any).dataUrl === "string" ? (entry as any).dataUrl : "";
    if (!name || !dataUrl) continue;
    const kindInput = typeof (entry as any).kind === "string" ? (entry as any).kind.toLowerCase() : "";
    const mime = typeof (entry as any).mimeType === "string" ? (entry as any).mimeType : "";
    const kind = (["pdf", "doc", "docx", "xls", "xlsx"] as const).includes(kindInput as TaskDocumentKind)
      ? (kindInput as TaskDocumentKind)
      : inferKind(name, mime);
    if (!kind) continue;
    const previewRaw = (entry as any).preview;
    const fullRaw = (entry as any).full;

    const preview = normalizePreview(previewRaw);
    const full = normalizeFull(fullRaw, kind);
    const createdAtRaw = typeof (entry as any).createdAt === "string" ? (entry as any).createdAt : null;

    normalized.push({
      id: typeof (entry as any).id === "string" ? (entry as any).id : generateId(),
      name,
      mimeType: guessMime(kind, mime),
      kind,
      size: typeof (entry as any).size === "number" && (entry as any).size >= 0 ? (entry as any).size : undefined,
      dataUrl,
      createdAt: createdAtRaw && !Number.isNaN(Date.parse(createdAtRaw)) ? createdAtRaw : new Date().toISOString(),
      preview: preview || undefined,
      full: full || undefined,
    });
  }
  return normalized.length ? normalized : undefined;
}

function normalizePreview(raw: unknown): TaskDocumentPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const type = typeof (raw as any).type === "string" ? (raw as any).type : "";
  const data = typeof (raw as any).data === "string" ? (raw as any).data : "";
  if (!data) return null;
  if (type === "image" || type === "html" || type === "text") {
    return { type, data } as TaskDocumentPreview;
  }
  return null;
}

function normalizeFull(raw: unknown, fallbackKind: TaskDocumentKind): TaskDocumentFull | null {
  if (fallbackKind === "pdf") {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const type = typeof (raw as any).type === "string" ? (raw as any).type : "";
    const data = typeof (raw as any).data === "string" ? (raw as any).data : "";
    if (!data) return null;
    if (type === "html" || type === "text") {
      return { type, data } as TaskDocumentFull;
    }
    return null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const type = typeof (raw as any).type === "string" ? (raw as any).type : "";
  const data = typeof (raw as any).data === "string" ? (raw as any).data : "";
  if (!data) return null;
  if (type === "pdf" || type === "html" || type === "text") {
    return { type, data } as TaskDocumentFull;
  }
  return null;
}

async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

function arrayBufferFromDataUrl(dataUrl: string): ArrayBuffer {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return new ArrayBuffer(0);
  const base64 = dataUrl.slice(commaIndex + 1);
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function ensurePdfjs() {
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
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    return canvas.toDataURL("image/png");
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

function generateSpreadsheetMarkup(buffer: ArrayBuffer): { previewHtml?: string; fullHtml?: string } {
  try {
    const workbook = read(buffer, { type: "array", blankrows: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return {};
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return {};
    const rows = utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[];
    const rowsArray = Array.isArray(rows) ? (rows as Array<Array<unknown>>) : [];
    if (!rowsArray.length) return {};
    const fullHtml = wrapSheetHtml(rowsArray, 100, 20);
    const previewHtml = wrapSheetHtml(rowsArray, 20, 8);
    return { previewHtml, fullHtml };
  } catch {
    return {};
  }
}

function wrapSheetHtml(rows: Array<Array<unknown>>, maxRows: number, maxCols: number): string {
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
  return `<div class="doc-sheet"><table><tbody>${body}</tbody></table></div>`;
}

export async function createDocumentAttachment(file: File): Promise<TaskDocument> {
  const kind = inferKind(file.name, file.type);
  if (!kind) throw new Error("Unsupported file type");
  const dataUrl = await readFileAsDataURL(file);
  const buffer = await file.arrayBuffer();
  const base: TaskDocument = {
    id: generateId(),
    name: file.name,
    mimeType: guessMime(kind, file.type),
    kind,
    size: typeof file.size === "number" ? file.size : undefined,
    dataUrl,
    createdAt: new Date().toISOString(),
  };

  if (kind === "pdf") {
    const previewImage = await generatePdfPreview(buffer);
    if (previewImage) {
      base.preview = { type: "image", data: previewImage };
    }
  } else if (kind === "docx") {
    const { previewHtml, fullHtml } = await generateDocxMarkup(buffer);
    if (previewHtml) base.preview = { type: "html", data: previewHtml };
    if (fullHtml) base.full = { type: "html", data: fullHtml };
  } else if (kind === "doc") {
    const { previewText, fullText } = generateDocBinary(buffer);
    if (previewText) base.preview = { type: "text", data: previewText };
    if (fullText) base.full = { type: "text", data: fullText };
  } else {
    const { previewHtml, fullHtml } = generateSpreadsheetMarkup(buffer);
    if (previewHtml) base.preview = { type: "html", data: previewHtml };
    if (fullHtml) base.full = { type: "html", data: fullHtml };
  }

  return base;
}

export function ensureDocumentPreview(doc: TaskDocument): TaskDocument {
  let next = doc;
  if (doc.kind === "pdf" && doc.full?.type === "pdf") {
    next = { ...doc };
    delete (next as any).full;
  }
  if (next.preview) return next;
  if (next.kind === "pdf") {
    return next;
  }
  if (next.full?.type === "html") {
    return {
      ...next,
      preview: { type: "html", data: next.full.data },
    };
  }
  if (next.full?.type === "text") {
    return {
      ...next,
      preview: { type: "text", data: next.full.data },
    };
  }
  return next;
}

export function getDocumentBuffer(doc: TaskDocument): ArrayBuffer {
  return arrayBufferFromDataUrl(doc.dataUrl);
}

const previewPromiseCache = new Map<string, Promise<TaskDocumentPreview | null>>();

async function buildPreviewFromDocument(doc: TaskDocument): Promise<TaskDocumentPreview | null> {
  const ensured = ensureDocumentPreview(doc);
  if (ensured.preview) return ensured.preview;
  if (ensured.kind === "pdf") return null;

  const buffer = getDocumentBuffer(ensured);
  if (!buffer.byteLength) return null;

  if (ensured.kind === "docx") {
    const { previewHtml } = await generateDocxMarkup(buffer);
    if (previewHtml) return { type: "html", data: previewHtml };
    return null;
  }

  if (ensured.kind === "doc") {
    const { previewText } = generateDocBinary(buffer);
    if (previewText) return { type: "text", data: previewText };
    return null;
  }

  const { previewHtml } = generateSpreadsheetMarkup(buffer);
  if (previewHtml) return { type: "html", data: previewHtml };
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
