import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { uploadImageToNip96 } from "./nip96Upload.js";
import type { TaskifyConfig } from "./config.js";

export type CliTaskDocument = {
  id: string;
  name: string;
  mimeType: string;
  kind: string;
  size?: number;
  dataUrl: string;
  createdAt: string;
  remoteUrl?: string;
  encrypted?: boolean;
  encryptionBoardId?: string;
};


function inferServerType(url: string): "nip96" | "originless" | "blossom" {
  const lower = (url || "").toLowerCase();
  if (lower.includes("originless")) return "originless";
  if (lower.includes("blossom")) return "blossom";
  return "nip96";
}

async function uploadBlobToOriginless(serverUrl: string, bytes: Uint8Array, filename: string, mimeType: string): Promise<string> {
  const base = serverUrl.replace(/\/+$/, "");
  const uploadUrl = `${base}/upload`;
  const attempts: RequestInit[] = [
    { method: "POST", body: (() => { const form = new FormData(); form.append("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), filename); return form; })() },
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([bytes], { type: "application/octet-stream" }) },
  ];
  let lastErr: unknown = null;
  for (const init of attempts) {
    try {
      const res = await fetch(uploadUrl, init);
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(data?.message || `Originless upload failed (${res.status})`);
      const direct = [data?.url, data?.cidUrl, data?.gatewayUrl, data?.fileUrl, data?.ipfs];
      for (const value of direct) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      const cid = typeof data?.cid === "string" ? data.cid.trim() : "";
      if (cid) return `${base}/ipfs/${cid}`;
      const path = typeof data?.path === "string" ? data.path.trim() : "";
      if (path) return path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
      throw new Error("Originless upload response did not include a url.");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Originless upload failed");
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function inferMime(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] || "application/octet-stream";
}
function inferKind(filePath: string, mimeType: string): string {
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  if (ext) return ext;
  const slash = mimeType.indexOf("/");
  return slash >= 0 ? mimeType.slice(slash + 1).toLowerCase() : "bin";
}
function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
function deriveBoardKey(boardId: string): Buffer {
  return createHash("sha256").update(boardId).digest();
}
function encryptAttachmentBytes(boardId: string, plaintext: Uint8Array): Uint8Array {
  const key = deriveBoardKey(boardId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, ciphertext, tag]));
}
export async function decryptAttachmentToDataUrl(boardId: string, url: string, mimeType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 28) throw new Error("Encrypted attachment too small");
  const iv = bytes.slice(0, 12);
  const tag = bytes.slice(bytes.length - 16);
  const ct = bytes.slice(12, bytes.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", deriveBoardKey(boardId), Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(tag));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]);
  return bytesToDataUrl(new Uint8Array(pt), mimeType || "application/octet-stream");
}
export async function buildAttachmentDocuments(opts: {
  files: string[];
  boardId: string;
  shared: boolean;
  config: TaskifyConfig;
  fileServer?: string;
}): Promise<CliTaskDocument[]> {
  const out: CliTaskDocument[] = [];
  for (const filePath of opts.files) {
    const bytes = await readFile(filePath);
    const mimeType = inferMime(filePath);
    const kind = inferKind(filePath, mimeType);
    const name = basename(filePath);
    const createdAt = new Date().toISOString();
    const base: CliTaskDocument = {
      id: crypto.randomUUID(),
      name,
      mimeType,
      kind,
      size: bytes.length,
      dataUrl: bytesToDataUrl(new Uint8Array(bytes), mimeType),
      createdAt,
    };
    if (!opts.shared) {
      out.push(base);
      continue;
    }
    const nsec = opts.config.nsec;
    if (!nsec) throw new Error("Shared attachment upload requires an nsec in CLI config.");
    const serverUrl = opts.fileServer || opts.config.encryptedFileStorageServer || "https://originless.solife.me";
    const encrypted = encryptAttachmentBytes(opts.boardId, new Uint8Array(bytes));
    const serverType = inferServerType(serverUrl);
    let remoteUrl = "";
    if (serverType === "originless" || serverType === "blossom") {
      remoteUrl = await uploadBlobToOriginless(serverUrl, encrypted, `${name}.bin`, "application/octet-stream");
    } else {
      const tmpPath = `/tmp/taskify-attachment-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
      await import('node:fs/promises').then(fs => fs.writeFile(tmpPath, Buffer.from(encrypted)));
      try {
        remoteUrl = await uploadImageToNip96({ serverUrl, filePath: tmpPath, nsec });
      } finally {
        await import('node:fs/promises').then(fs => fs.unlink(tmpPath).catch(() => {}));
      }
    }
    out.push({ ...base, remoteUrl, encrypted: true, encryptionBoardId: opts.boardId });
  }
  return out;
}
