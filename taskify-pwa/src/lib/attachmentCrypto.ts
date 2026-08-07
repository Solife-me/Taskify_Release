import { uploadFile } from "../nostr/Nip96Client";
import type { FileServerEntry } from "./fileStorage";
import { toBufferSource } from "./binary";

const ATTACHMENT_KEY_LABEL = new TextEncoder().encode("taskify-board-attachment-v2");
const ATTACHMENT_V2_MAGIC = new Uint8Array([0x54, 0x46, 0x41, 0x32]); // TFA2
const aesKeyCache = new Map<string, Promise<CryptoKey>>();
const legacyAesKeyCache = new Map<string, Promise<CryptoKey>>();
const decryptDataUrlCache = new Map<string, Promise<string>>();

function attachmentDebug(event: string, detail?: Record<string, unknown>) {
  console.info("[attachment-debug]", event, detail || {});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBufferSource(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sampleHex(bytes: Uint8Array, count = 16): string {
  return Array.from(bytes.slice(0, count)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveBoardAesKey(boardId: string): Promise<CryptoKey> {
  const cached = aesKeyCache.get(boardId);
  if (cached) return cached;
  const promise = (async () => {
    const boardBytes = new TextEncoder().encode(boardId);
    const material = new Uint8Array(ATTACHMENT_KEY_LABEL.length + boardBytes.length);
    material.set(ATTACHMENT_KEY_LABEL, 0);
    material.set(boardBytes, ATTACHMENT_KEY_LABEL.length);
    const hash = await crypto.subtle.digest("SHA-256", toBufferSource(material));
    return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  aesKeyCache.set(boardId, promise);
  return promise;
}

async function deriveLegacyBoardAesKey(boardId: string): Promise<CryptoKey> {
  const cached = legacyAesKeyCache.get(boardId);
  if (cached) return cached;
  const promise = (async () => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(boardId));
    return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
  })();
  legacyAesKeyCache.set(boardId, promise);
  return promise;
}

function hasV2Magic(bytes: Uint8Array): boolean {
  return bytes.length >= ATTACHMENT_V2_MAGIC.length
    && ATTACHMENT_V2_MAGIC.every((value, index) => bytes[index] === value);
}

export function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error("Invalid data URL");
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { mimeType, bytes };
  }
  return { mimeType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function encryptAndUploadAttachment(opts: {
  boardId: string;
  data: Uint8Array;
  mimeType: string;
  filename: string;
  serverEntry: FileServerEntry;
  nostrSkHex: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, loaded?: number, total?: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
}): Promise<string> {
  attachmentDebug("encrypt:start", {
    boardId: opts.boardId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    plaintextBytes: opts.data.byteLength,
    serverUrl: opts.serverEntry?.url,
    serverType: opts.serverEntry?.type,
  });
  const key = await deriveBoardAesKey(opts.boardId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(opts.data),
  );
  const combined = new Uint8Array(ATTACHMENT_V2_MAGIC.length + iv.length + ctBuf.byteLength);
  combined.set(ATTACHMENT_V2_MAGIC, 0);
  combined.set(iv, ATTACHMENT_V2_MAGIC.length);
  combined.set(new Uint8Array(ctBuf), ATTACHMENT_V2_MAGIC.length + iv.length);
  const ciphertextSha256 = await sha256Hex(combined);
  attachmentDebug("encrypt:complete", {
    filename: opts.filename,
    plaintextBytes: opts.data.byteLength,
    ciphertextBytes: combined.byteLength,
    ciphertextSha256,
    ciphertextSampleHex: sampleHex(combined),
    uploadContentType: "application/octet-stream",
    uploadFilename: opts.filename,
    plaintextUploaded: false,
  });
  const blob = new Blob([combined], { type: "application/octet-stream" });
  const upload = await uploadFile({
    debugMeta: {
      source: "encryptAndUploadAttachment",
      boardId: opts.boardId,
      originalFilename: opts.filename,
      originalMimeType: opts.mimeType,
      plaintextBytes: opts.data.byteLength,
      ciphertextBytes: combined.byteLength,
      ciphertextSha256,
      plaintextUploaded: false,
    },
    serverEntry: opts.serverEntry,
    file: blob,
    filename: opts.filename,
    contentType: "application/octet-stream",
    signer: opts.nostrSkHex,
    signal: opts.signal,
    onProgress: opts.onProgress
      ? (loaded, total) => opts.onProgress?.(total > 0 ? loaded / total : 0, loaded, total)
      : undefined,
    onPhaseChange: opts.onPhaseChange,
  });
  attachmentDebug("upload:complete", {
    filename: opts.filename,
    remoteUrl: upload.url,
    serverUrl: opts.serverEntry?.url,
    serverType: opts.serverEntry?.type,
  });
  return upload.url;
}

export async function decryptAttachment(opts: {
  boardId: string;
  url: string;
  mimeType: string;
}): Promise<string> {
  const cacheKey = `${opts.boardId}::${opts.url}::${opts.mimeType}`;
  const cached = decryptDataUrlCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    attachmentDebug("decrypt:start", { boardId: opts.boardId, url: opts.url, mimeType: opts.mimeType });
    const res = await fetch(opts.url);
    attachmentDebug("decrypt:fetch", {
      url: opts.url,
      finalUrl: res.url,
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      contentLength: res.headers.get("content-length"),
    });
    if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    attachmentDebug("decrypt:fetched-bytes", {
      url: opts.url,
      encryptedBytes: bytes.byteLength,
      ciphertextSha256: await sha256Hex(bytes),
      ciphertextSampleHex: sampleHex(bytes),
    });
    const isV2 = hasV2Magic(bytes);
    const offset = isV2 ? ATTACHMENT_V2_MAGIC.length : 0;
    if (bytes.length < offset + 13) throw new Error("Encrypted attachment too small");
    const iv = bytes.slice(offset, offset + 12);
    const ct = bytes.slice(offset + 12);
    // Unversioned attachments predate the domain-separated key. They remain
    // readable so existing user files are not destroyed; every new upload is v2.
    const key = isV2
      ? await deriveBoardAesKey(opts.boardId)
      : await deriveLegacyBoardAesKey(opts.boardId);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBufferSource(iv) }, key, toBufferSource(ct));
    attachmentDebug("decrypt:success", { url: opts.url, plaintextBytes: ptBuf.byteLength, mimeType: opts.mimeType });
    return bytesToDataUrl(new Uint8Array(ptBuf), opts.mimeType || "application/octet-stream");
  })();
  decryptDataUrlCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (err) {
    decryptDataUrlCache.delete(cacheKey);
    attachmentDebug("decrypt:error", { url: opts.url, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
