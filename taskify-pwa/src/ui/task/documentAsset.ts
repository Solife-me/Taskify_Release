import type { TaskDocument } from "../../lib/documents";
import { createDocumentFromDataUrl, documentAssetCacheKey } from "../../lib/documents";
import { decryptAttachment } from "../../lib/attachmentCrypto";
import type { DownloadProgress, DownloadProgressHandler } from "../../lib/binary";

/** Fetched (and, for encrypted boards, decrypted) attachments, shared by thumbnails and the viewer. */
type ResolvedDocumentEntry = {
  promise: Promise<TaskDocument>;
  listeners: Set<DownloadProgressHandler>;
  lastProgress?: DownloadProgress;
};

const resolvedDocumentCache = new Map<string, ResolvedDocumentEntry>();

function observe(entry: ResolvedDocumentEntry, listener?: DownloadProgressHandler): Promise<TaskDocument> {
  if (!listener) return entry.promise;
  entry.listeners.add(listener);
  if (entry.lastProgress) listener(entry.lastProgress);
  return entry.promise.finally(() => { entry.listeners.delete(listener); });
}

/** The attachment with its contents loaded, fetching and decrypting a remote one once. */
export async function resolveDocumentAsset(
  doc: TaskDocument,
  boardId?: string,
  onProgress?: DownloadProgressHandler,
): Promise<TaskDocument> {
  if (!doc.remoteUrl) return doc;
  const decryptBoardId = doc.encryptionBoardId || boardId;
  const cacheKey = documentAssetCacheKey(doc, boardId);
  const cached = resolvedDocumentCache.get(cacheKey);
  if (cached) return observe(cached, onProgress);
  const entry: ResolvedDocumentEntry = { promise: Promise.resolve(doc), listeners: new Set() };
  if (onProgress) entry.listeners.add(onProgress);
  const notifyProgress = (progress: DownloadProgress) => {
    entry.lastProgress = progress;
    for (const listener of entry.listeners) listener(progress);
  };
  const promise = (async () => {
    const dataUrl = doc.encrypted && decryptBoardId
      ? await decryptAttachment({ boardId: decryptBoardId, url: doc.remoteUrl!, mimeType: doc.mimeType, onProgress: notifyProgress })
      : doc.remoteUrl!;
    const resolved = await createDocumentFromDataUrl({
      id: doc.id, name: doc.name, mimeType: doc.mimeType, dataUrl,
      createdAt: doc.createdAt, size: doc.size, remoteUrl: doc.remoteUrl,
      encrypted: doc.encrypted, encryptionBoardId: doc.encryptionBoardId || decryptBoardId,
    });
    return {
      ...resolved,
      remoteUrl: doc.remoteUrl,
      encrypted: doc.encrypted,
      encryptionBoardId: doc.encryptionBoardId || decryptBoardId,
    };
  })().catch((err) => { resolvedDocumentCache.delete(cacheKey); throw err; });
  entry.promise = promise;
  resolvedDocumentCache.set(cacheKey, entry);
  return observe(entry, onProgress);
}
