import type { TaskDocument } from "../../lib/documents";
import { createDocumentFromDataUrl, documentAssetCacheKey } from "../../lib/documents";
import { decryptAttachment } from "../../lib/attachmentCrypto";
import type { DownloadProgressHandler } from "../../lib/binary";

/** Fetched (and, for encrypted boards, decrypted) attachments, shared by thumbnails and the viewer. */
const resolvedDocumentCache = new Map<string, Promise<TaskDocument>>();

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
  if (cached) return cached;
  const promise = (async () => {
    const dataUrl = doc.encrypted && decryptBoardId
      ? await decryptAttachment({ boardId: decryptBoardId, url: doc.remoteUrl!, mimeType: doc.mimeType, onProgress })
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
  resolvedDocumentCache.set(cacheKey, promise);
  return promise;
}
