import { BOARD_PRINT_PHOTO_MAX, type BoardPrintTask } from "../../components/BoardPrintLayout";
import { decryptAttachment, inferAttachmentMimeFromUrl } from "../../lib/attachmentCrypto";

const THUMBNAIL_MAX_PX = 240;
const THUMBNAIL_QUALITY = 0.72;
/** A data URL already this small needs no re-encoding. */
const THUMBNAIL_SMALL_ENOUGH = 24_000;

export type PrintPhotoResult = {
  tasks: BoardPrintTask[];
  /** Attachments that could not be downloaded, decrypted or decoded. */
  failed: number;
};

async function thumbnailFromDataUrl(dataUrl: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, THUMBNAIL_MAX_PX / Math.max(sourceWidth, sourceHeight));
  if (scale === 1 && dataUrl.length <= THUMBNAIL_SMALL_ENOUGH) return dataUrl;

  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // Photos with transparency print cleaner on white paper than on black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  try {
    return canvas.toDataURL("image/jpeg", THUMBNAIL_QUALITY);
  } catch {
    return null;
  }
}

async function resolvePhoto(src: string, boardId: string | undefined): Promise<string | null> {
  if (!src) return null;
  if (src.startsWith("data:")) return thumbnailFromDataUrl(src);
  if (!boardId) return null;
  try {
    const dataUrl = await decryptAttachment({
      boardId,
      url: src,
      mimeType: inferAttachmentMimeFromUrl(src),
    });
    return await thumbnailFromDataUrl(dataUrl);
  } catch {
    return null;
  }
}

/**
 * Replaces each task's attachment references with small data-URL thumbnails for printing. The
 * printable job keeps only these thumbnails, so nothing is written to local storage or relayed.
 */
export async function resolvePrintTaskPhotos(tasks: BoardPrintTask[]): Promise<PrintPhotoResult> {
  let failed = 0;
  const resolved = await Promise.all(
    tasks.map(async (task) => {
      const sources = task.photos?.slice(0, BOARD_PRINT_PHOTO_MAX) ?? [];
      if (!sources.length) return task;
      const photos = (await Promise.all(sources.map((src) => resolvePhoto(src, task.boardId)))).filter(
        (src): src is string => !!src,
      );
      failed += sources.length - photos.length;
      return { ...task, photos, photoCount: photos.length };
    }),
  );
  return { tasks: resolved, failed };
}
