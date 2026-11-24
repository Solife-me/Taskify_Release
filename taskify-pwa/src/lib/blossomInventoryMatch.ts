import type { CalendarEvent, Task, TaskDocument } from "taskify-core";
import { readAttachmentCiphertextIndex } from "./blossomAttachmentIndex";
import type { WalletDmMessage, WalletDmAttachment } from "../chat/hooks/useDmState";

type ChatFile = Extract<WalletDmAttachment, { type: "file" }>;

export type LocalBlobReference = {
  sha256: string;
  serverUrl?: string;
  url: string;
  referenceId: string;
  referenceLabel: string;
  source: "task" | "event" | "chat";
  boardId: string;
  filename: string;
  document?: TaskDocument;
  imageUrl?: string;
  chatFile?: ChatFile;
};

export function sha256FromAttachmentURL(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(url || "");
    const name = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return name.match(/^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
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

export function localBlobReferences(
  tasks: readonly Task[],
  events: readonly CalendarEvent[] = [],
  messages: readonly WalletDmMessage[] = [],
): LocalBlobReference[] {
  const refs: LocalBlobReference[] = [];
  const index = readAttachmentCiphertextIndex();
  function add(reference: Omit<LocalBlobReference, "sha256">, declaredHash?: string | null) {
    const indexed = index[reference.url.trim()];
    const sha256 = [declaredHash, indexed?.sha256, sha256FromAttachmentURL(reference.url)]
      .find((hash) => hash && /^[0-9a-f]{64}$/i.test(hash))?.toLowerCase();
    if (!sha256) return;
    refs.push({ ...reference, sha256, serverUrl: reference.serverUrl || (indexed?.retention ? indexed.serverUrl : undefined) });
  }

  function addBoardAttachments(
    item: Pick<Task, "id" | "title" | "boardId" | "documents">,
    source: "task" | "event",
    images: readonly string[],
  ) {
    const reference = {
      referenceId: item.id,
      referenceLabel: item.title || (source === "task" ? "Untitled task" : "Untitled event"),
      boardId: item.boardId,
      source,
    };
    item.documents?.forEach((document, index) => {
      const url = document.remoteUrl?.trim();
      if (!url) return;
      add({
        ...reference, url, document, serverUrl: document.storageServer,
        filename: document.name || `Attachment ${index + 1}`,
      }, document.ciphertextSha256);
    });
    images.forEach((imageUrl, index) => {
      if (!/^https?:\/\//i.test(imageUrl)) return;
      add({
        ...reference, url: imageUrl, imageUrl,
        filename: images.length === 1 ? "Image" : `Image ${index + 1}`,
      });
    });
  }

  for (const task of tasks) addBoardAttachments(task, "task", task.images ?? []);
  for (const event of events) addBoardAttachments(event, "event", event.image ? [event.image] : []);
  for (const message of messages) {
    const chatFile = message.attachment;
    if (chatFile?.type !== "file" || !chatFile.url) continue;
    add({
      source: "chat", referenceId: message.id, referenceLabel: "Chat attachment",
      boardId: "", url: chatFile.url, filename: chatFile.filename || "Chat attachment", chatFile,
    }, chatFile.sha256);
  }
  return refs;
}

export function matchBlobToLocalReferences(
  blob: { sha256: string; url?: string },
  serverUrl: string,
  references: readonly LocalBlobReference[],
): LocalBlobReference[] {
  const sha256 = blob.sha256.trim().toLowerCase();
  const serverKey = blossomServerKey(serverUrl);
  return references.filter((ref) => ref.sha256 === sha256 && (
    ref.serverUrl
      ? blossomServerKey(ref.serverUrl) === serverKey
      : attachmentBelongsToServer(ref.url, serverUrl)
  ));
}
