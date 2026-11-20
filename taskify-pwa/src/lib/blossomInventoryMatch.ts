import type { Task, TaskDocument } from "taskify-core";
import { lookupAttachmentCiphertextHash } from "./blossomAttachmentIndex";

export type LocalBlobMatchKind = "document" | "image";

export type LocalBlobReference = {
  key: string;
  sha256: string;
  serverUrl: string;
  taskId: string;
  taskTitle: string;
  boardId: string;
  kind: LocalBlobMatchKind;
  filename: string;
  mimeType?: string;
  size?: number;
  document?: TaskDocument;
  imageUrl?: string;
};

export type BlobTaskReference = Pick<LocalBlobReference, "taskId" | "taskTitle" | "boardId" | "kind" | "filename">;

const SHA256_PATH = /(?:^|[/_-])([0-9a-f]{64})(?:\.bin)?(?:$|[?#])/i;

export function sha256FromAttachmentURL(url: string | null | undefined): string | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const direct = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
    const exact = direct.match(/^([0-9a-f]{64})(?:\.bin)?$/i);
    if (exact) return exact[1].toLowerCase();
  } catch {
    // fall through to a conservative string match
  }
  const match = raw.match(SHA256_PATH);
  return match ? match[1].toLowerCase() : null;
}

export function blossomServerKey(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host.toLowerCase()}${path === "/" ? "" : path}`;
  } catch {
    return serverUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function attachmentBelongsToServer(attachmentURL: string, serverUrl: string): boolean {
  try {
    const attachment = new URL(attachmentURL);
    const server = new URL(serverUrl);
    const bothWeb = ["http:", "https:"].includes(attachment.protocol) && ["http:", "https:"].includes(server.protocol);
    if (!bothWeb || attachment.host.toLowerCase() !== server.host.toLowerCase()) {
      return false;
    }
    const basePath = server.pathname.replace(/\/+$/, "");
    return !basePath || basePath === "/" || attachment.pathname === basePath || attachment.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

export function localBlobReferences(tasks: Task[]): LocalBlobReference[] {
  const refs: LocalBlobReference[] = [];
  for (const task of tasks) {
    (task.documents ?? []).forEach((doc, index) => {
      const remoteUrl = doc.remoteUrl?.trim();
      if (!remoteUrl) return;
      const indexed = lookupAttachmentCiphertextHash(remoteUrl);
      const sha256 = (doc.ciphertextSha256 || indexed?.sha256 || sha256FromAttachmentURL(remoteUrl) || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) return;
      const serverUrl = doc.storageServer?.trim() || indexed?.serverUrl || (() => {
        try { return new URL(remoteUrl).origin; } catch { return ""; }
      })();
      if (!serverUrl) return;
      refs.push({
        key: `${blossomServerKey(serverUrl)}::${sha256}`,
        sha256,
        serverUrl,
        taskId: task.id,
        taskTitle: task.title || "Untitled task",
        boardId: task.boardId,
        kind: "document",
        filename: doc.name || `Attachment ${index + 1}`,
        mimeType: doc.mimeType,
        size: doc.size,
        document: doc,
      });
    });
    (task.images ?? []).forEach((imageUrl, index) => {
      if (!imageUrl?.startsWith("http")) return;
      const indexed = lookupAttachmentCiphertextHash(imageUrl);
      const sha256 = indexed?.sha256 || sha256FromAttachmentURL(imageUrl);
      if (!sha256) return;
      const serverUrl = indexed?.serverUrl || (() => {
        try { return new URL(imageUrl).origin; } catch { return ""; }
      })();
      if (!serverUrl) return;
      refs.push({
        key: `${blossomServerKey(serverUrl)}::${sha256}`,
        sha256,
        serverUrl,
        taskId: task.id,
        taskTitle: task.title || "Untitled task",
        boardId: task.boardId,
        kind: "image",
        filename: task.images?.length === 1 ? "Task image" : `Task image ${index + 1}`,
        imageUrl,
      });
    });
  }
  return refs;
}

export function matchBlobToLocalReferences(
  blob: Pick<{ url: string; sha256: string }, "url" | "sha256">,
  serverUrl: string,
  references: LocalBlobReference[],
): LocalBlobReference[] {
  const sha256 = blob.sha256.trim().toLowerCase();
  const serverKey = blossomServerKey(serverUrl);
  return references.filter((ref) =>
    ref.sha256 === sha256 &&
    ref.key.startsWith(`${serverKey}::`) &&
    attachmentBelongsToServer(ref.document?.remoteUrl || ref.imageUrl || blob.url, serverUrl),
  );
}
