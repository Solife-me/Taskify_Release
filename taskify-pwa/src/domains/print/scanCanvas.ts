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
  if (scale === 1) return { full, reduced: full, scale };
  const reducedWidth = Math.max(1, Math.floor(width * scale));
  const reducedHeight = Math.max(1, Math.floor(height * scale));
  const reducedCanvas = document.createElement("canvas");
  reducedCanvas.width = reducedWidth;
  reducedCanvas.height = reducedHeight;
  const reducedCtx = reducedCanvas.getContext("2d");
  if (!reducedCtx) return { full, reduced: full, scale: 1 };
  reducedCtx.imageSmoothingQuality = "high";
  reducedCtx.drawImage(canvas, 0, 0, reducedWidth, reducedHeight);
  const reduced = lumaFromRgba(reducedCtx.getImageData(0, 0, reducedWidth, reducedHeight).data, reducedWidth, reducedHeight);
  return { full, reduced, scale };
}

const MAX_SCAN_DIMENSION = 3200;

export const SCAN_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 2560 },
  height: { ideal: 1920 },
};

function canvasFromScanImage(image: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  if (!width || !height) throw new Error("Camera is not ready yet.");
  const scale = Math.min(1, MAX_SCAN_DIMENSION / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to read the image.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function captureScanPhoto(video: HTMLVideoElement | null, stream: MediaStream | null): Promise<HTMLCanvasElement> {
  const ImageCapture = (globalThis as typeof globalThis & {
    ImageCapture?: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
  }).ImageCapture;
  const track = stream?.getVideoTracks()[0];
  if (track && ImageCapture) {
    try {
      return await loadScanPhoto(await new ImageCapture(track).takePhoto());
    } catch {
      // Some cameras provide a stream without supporting still capture.
    }
  }
  if (!video) throw new Error("Camera is not ready yet.");
  return canvasFromScanImage(video, video.videoWidth, video.videoHeight);
}

export async function loadScanPhoto(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return canvasFromScanImage(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}
