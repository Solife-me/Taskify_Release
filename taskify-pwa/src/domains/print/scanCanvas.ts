/** Turns a camera frame or uploaded photo (a canvas) into the brightness images the scan engine reads. */
import type { LumaImage, ScanPhoto } from "./scanEngine";

/** Markers are looked for on a copy no larger than this, which is fast and plenty sharp. */
const MAX_MARKER_SEARCH_DIMENSION = 1800;

export function lumaFromRgba(data: Uint8ClampedArray, width: number, height: number): LumaImage {
  const luma = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    luma[p] = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
  }
  return { luma, width, height };
}

export function scanPhotoFromCanvas(canvas: HTMLCanvasElement): ScanPhoto {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to read the camera frame.");
  const { width, height } = canvas;
  if (!width || !height) throw new Error("Scan image is empty.");
  const full = lumaFromRgba(ctx.getImageData(0, 0, width, height).data, width, height);

  const scale = Math.min(1, MAX_MARKER_SEARCH_DIMENSION / Math.max(width, height));
  const reducedWidth = Math.max(1, Math.floor(width * scale));
  const reducedHeight = Math.max(1, Math.floor(height * scale));
  const reducedCanvas = document.createElement("canvas");
  reducedCanvas.width = reducedWidth;
  reducedCanvas.height = reducedHeight;
  const reducedCtx = reducedCanvas.getContext("2d");
  if (!reducedCtx) return { full, reduced: { luma: new Uint8ClampedArray(0), width: 0, height: 0 }, scale };
  reducedCtx.drawImage(canvas, 0, 0, reducedWidth, reducedHeight);
  const reduced = lumaFromRgba(reducedCtx.getImageData(0, 0, reducedWidth, reducedHeight).data, reducedWidth, reducedHeight);
  return { full, reduced, scale };
}
