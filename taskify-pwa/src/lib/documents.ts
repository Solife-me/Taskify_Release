import type {
  TaskDocument,
  TaskDocumentFull,
  TaskDocumentKind,
  TaskDocumentPreview,
} from "taskify-core";

export type { TaskDocument, TaskDocumentFull, TaskDocumentKind, TaskDocumentPreview };

const EXTENSION_TO_KIND: Record<string, TaskDocumentKind> = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "docx",
  ".xls": "xls",
  ".xlsx": "xlsx",
  ".txt": "txt",
  ".md": "md",
  ".json": "json",
  ".csv": "csv",
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".gif": "gif",
  ".mp3": "mp3",
  ".aac": "aac",
  ".m4a": "m4a",
  ".wav": "wav",
  ".mp4": "mp4",
  ".mov": "mov",
  ".webm": "webm",
};

const SERIALIZED_DOCUMENT_KINDS = new Set<TaskDocumentKind>(["pdf", "doc", "docx", "xls", "xlsx"]);
const LEGACY_UPLOAD_ONLY_KINDS = new Set<TaskDocumentKind>(["xls"]);

const MIME_TO_KIND: Record<string, TaskDocumentKind> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.ms-word": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/json": "json",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const KIND_MIME_FALLBACK: Record<TaskDocumentKind, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function inferDocumentKind(name: string, mimeType: string): TaskDocumentKind | null {
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

export function guessDocumentMime(kind: TaskDocumentKind, sourceMime: string): string {
  if (sourceMime && sourceMime.trim()) return sourceMime;
  return KIND_MIME_FALLBACK[kind];
}

export function generateDocumentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

export function isTextDocumentKind(kind: TaskDocumentKind): boolean {
  return kind === "txt" || kind === "md" || kind === "json" || kind === "csv";
}

export function isImageDocumentKind(kind: TaskDocumentKind): boolean {
  return kind === "png" || kind === "jpg" || kind === "jpeg" || kind === "webp" || kind === "gif";
}

export function isAudioDocumentKind(kind: TaskDocumentKind): boolean {
  return kind === "mp3" || kind === "aac" || kind === "m4a" || kind === "wav";
}

export function isVideoDocumentKind(kind: TaskDocumentKind): boolean {
  return kind === "mp4" || kind === "mov" || kind === "webm";
}

export function isSupportedDocumentFile(file: File): boolean {
  const kind = inferDocumentKind(file.name, file.type);
  return kind !== null && !LEGACY_UPLOAD_ONLY_KINDS.has(kind);
}

export function normalizeDocumentList(raw: unknown): TaskDocument[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: TaskDocument[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof (entry as any).name === "string" ? (entry as any).name : "";
    const dataUrl = typeof (entry as any).dataUrl === "string" ? (entry as any).dataUrl : "";
    const remoteUrl = typeof (entry as any).remoteUrl === "string" ? (entry as any).remoteUrl.trim() : "";
    const encrypted = (entry as any).encrypted === true;
    const encryptionBoardId = typeof (entry as any).encryptionBoardId === "string" ? (entry as any).encryptionBoardId.trim() : "";
    // Accept legacy inline docs (dataUrl present) and remote-first docs (remoteUrl present)
    if (!name || (!dataUrl && !remoteUrl)) continue;
    const kindInput = typeof (entry as any).kind === "string" ? (entry as any).kind.toLowerCase() : "";
    const mime = typeof (entry as any).mimeType === "string" ? (entry as any).mimeType : "";
    const kind = SERIALIZED_DOCUMENT_KINDS.has(kindInput as TaskDocumentKind)
      ? (kindInput as TaskDocumentKind)
      : inferDocumentKind(name, mime);
    if (!kind) continue;
    const previewRaw = (entry as any).preview;
    const fullRaw = (entry as any).full;

    const preview = normalizePreview(previewRaw);
    const full = normalizeFull(fullRaw, kind);
    const createdAtRaw = typeof (entry as any).createdAt === "string" ? (entry as any).createdAt : null;

    normalized.push({
      id: typeof (entry as any).id === "string" ? (entry as any).id : generateDocumentId(),
      name,
      mimeType: guessDocumentMime(kind, mime),
      kind,
      size: typeof (entry as any).size === "number" && (entry as any).size >= 0 ? (entry as any).size : undefined,
      dataUrl,
      createdAt: createdAtRaw && !Number.isNaN(Date.parse(createdAtRaw)) ? createdAtRaw : new Date().toISOString(),
      preview: preview || undefined,
      full: full || undefined,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(encrypted ? { encrypted: true } : {}),
      ...(encryptionBoardId ? { encryptionBoardId } : {}),
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
  if (type === "pdf" || type === "html" || type === "text" || type === "image" || type === "audio" || type === "video") {
    return { type, data } as TaskDocumentFull;
  }
  return null;
}

export function arrayBufferFromDataUrl(dataUrl: string): ArrayBuffer {
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

export async function ensurePdfjs() {
  const preview = await import("./documentPreview");
  return preview.ensurePdfjs();
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
  const preview = await import("./documentPreview");
  return preview.createDocumentFromDataUrl(input);
}

export async function createDocumentAttachment(file: File): Promise<TaskDocument> {
  const preview = await import("./documentPreview");
  return preview.createDocumentAttachment(file);
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
  if (next.full?.type === "image") {
    return {
      ...next,
      preview: { type: "image", data: next.full.data },
    };
  }
  if (next.full?.type === "audio") {
    return next;
  }
  if (next.full?.type === "video") {
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

export function loadDocumentPreview(doc: TaskDocument): Promise<TaskDocumentPreview | null> {
  if (doc.preview) return Promise.resolve(doc.preview);
  return import("./documentPreview").then((preview) => preview.loadDocumentPreview(doc));
}

export async function readDocumentsFromFiles(list: FileList | File[]): Promise<TaskDocument[]> {
  const preview = await import("./documentPreview");
  return preview.readDocumentsFromFiles(list);
}

export function documentAssetCacheKey(doc: Pick<TaskDocument, "remoteUrl" | "encrypted" | "encryptionBoardId" | "id">, boardId?: string): string {
  if (doc.remoteUrl) {
    const keyBoardId = doc.encrypted ? (doc.encryptionBoardId || boardId || "") : "public";
    return `remote::${doc.remoteUrl}::${keyBoardId}`;
  }
  return `inline::${doc.id}`;
}
