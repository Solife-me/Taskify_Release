import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BIBLE_BOOKS, type BibleTrackerProgress, type BibleTrackerState } from "../domains/scripture/bibleTrackerModel";
import { buildBiblePrintLayout, type BiblePrintLayout, type BiblePrintLayoutVersion } from "./BibleTrackerPrintLayout";
import { PRINT_PAPER_OPTIONS, type PrintPaperSize } from "./printPaper";

type ScanPoint = { x: number; y: number };
type MarkerSet = {
  topLeft: ScanPoint;
  topRight: ScanPoint;
  bottomLeft: ScanPoint;
  bottomRight: ScanPoint;
};

type ScanAnalysis = {
  progress: BibleTrackerProgress;
  filledCount: number;
  threshold: number;
  backgroundMedian: number;
  pageIndex: number;
  layoutVersion: BiblePrintLayoutVersion;
  pageIdDetected: boolean;
};

type ScanContext = {
  imageData: ImageData;
  luma: Uint8ClampedArray;
  matrix: number[];
  width: number;
  height: number;
};

const MAX_SCAN_DIMENSION = 1800;
const MIN_PAGE_BACKGROUND_LUMA = 130;
const MAX_MARKER_LUMA = 110;
const MIN_MARKER_CONTRAST = 40;
const FINDER_CONTRAST_THRESHOLD = 40;
const MIN_FILL_CONTRAST = 28;
const MIN_DARK_SAMPLES = 2;

function computeOtsuThreshold(values: Uint8ClampedArray): number {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    histogram[values[i]] += 1;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += i * histogram[i];
  }
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVariance = 0;
  let threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    wB += histogram[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

function computeMedian(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function formatChapterRanges(chapters: number[]): string {
  if (!chapters.length) return "";
  const sorted = Array.from(new Set(chapters)).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const value = sorted[i];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    ranges.push([start, prev]);
    start = value;
    prev = value;
  }
  ranges.push([start, prev]);
  return ranges.map(([rangeStart, rangeEnd]) => (
    rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`
  )).join(", ");
}

// Locate the four printed corner markers to align the page.
function detectMarkers(canvas: HTMLCanvasElement, layout: BiblePrintLayout): MarkerSet | null {
  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, MAX_SCAN_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  const ctx = tempCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const pixelCount = targetWidth * targetHeight;
  const luma = new Uint8ClampedArray(pixelCount);
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    luma[p] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const threshold = computeOtsuThreshold(luma);
  const sampleLuma = (x: number, y: number, radius = 1) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    let total = 0;
    let count = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = ix + dx;
        const sy = iy + dy;
        if (sx < 0 || sy < 0 || sx >= targetWidth || sy >= targetHeight) continue;
        total += luma[sy * targetWidth + sx];
        count += 1;
      }
    }
    if (!count) return 255;
    return total / count;
  };
  const mask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    if (luma[i] < threshold) mask[i] = 1;
  }

  const minArea = Math.max(12, Math.floor(pixelCount * 0.00015));
  const maxArea = Math.floor(pixelCount * 0.02);
  const visited = new Uint8Array(pixelCount);
  const components: Array<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    area: number;
  }> = [];
  const stack: number[] = [];

  for (let idx = 0; idx < pixelCount; idx += 1) {
    if (!mask[idx] || visited[idx]) continue;
    visited[idx] = 1;
    stack.length = 0;
    stack.push(idx);
    let minX = targetWidth;
    let minY = targetHeight;
    let maxX = 0;
    let maxY = 0;
    let area = 0;

    while (stack.length) {
      const current = stack.pop();
      if (current == null) continue;
      if (visited[current] === 2) continue;
      visited[current] = 2;
      const x = current % targetWidth;
      const y = (current / targetWidth) | 0;
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const left = current - 1;
      const right = current + 1;
      const up = current - targetWidth;
      const down = current + targetWidth;

      if (x > 0 && mask[left] && !visited[left]) {
        visited[left] = 1;
        stack.push(left);
      }
      if (x < targetWidth - 1 && mask[right] && !visited[right]) {
        visited[right] = 1;
        stack.push(right);
      }
      if (y > 0 && mask[up] && !visited[up]) {
        visited[up] = 1;
        stack.push(up);
      }
      if (y < targetHeight - 1 && mask[down] && !visited[down]) {
        visited[down] = 1;
        stack.push(down);
      }
    }

    if (area < minArea || area > maxArea) continue;
    components.push({ minX, minY, maxX, maxY, area });
  }

  const candidates = components
    .map((component) => {
      const width = component.maxX - component.minX + 1;
      const height = component.maxY - component.minY + 1;
      const aspect = width / Math.max(1, height);
      const fill = component.area / (width * height);
      const cx = component.minX + width / 2;
      const cy = component.minY + height / 2;
      const centerRadius = Math.max(1, Math.round(Math.min(width, height) * 0.12));
      const edgeInset = Math.max(1, Math.round(Math.min(width, height) * 0.2));
      const leftX = Math.min(component.maxX, Math.max(component.minX, component.minX + edgeInset));
      const rightX = Math.max(component.minX, Math.min(component.maxX, component.maxX - edgeInset));
      const topY = Math.min(component.maxY, Math.max(component.minY, component.minY + edgeInset));
      const bottomY = Math.max(component.minY, Math.min(component.maxY, component.maxY - edgeInset));
      const centerLuma = sampleLuma(cx, cy, centerRadius);
      const edgeLuma = computeMedian([
        sampleLuma(leftX, cy, 1),
        sampleLuma(rightX, cy, 1),
        sampleLuma(cx, topY, 1),
        sampleLuma(cx, bottomY, 1),
      ]);
      const finderScore = centerLuma - edgeLuma;
      return {
        ...component,
        width,
        height,
        aspect,
        fill,
        cx,
        cy,
        centerLuma,
        edgeLuma,
        finderScore,
        isFinder: finderScore > FINDER_CONTRAST_THRESHOLD && centerLuma > threshold,
      };
    })
    .filter((component) => component.aspect > 0.6 && component.aspect < 1.4 && component.fill > 0.5)
    .sort((a, b) => b.area - a.area)
    .slice(0, 12);

  if (candidates.length < 4) return null;

  const centerX = targetWidth / 2;
  const centerY = targetHeight / 2;
  const quadrants = {
    tl: [] as (typeof candidates)[number][],
    tr: [] as (typeof candidates)[number][],
    bl: [] as (typeof candidates)[number][],
    br: [] as (typeof candidates)[number][],
  };

  for (const candidate of candidates) {
    const isLeft = candidate.cx < centerX;
    const isTop = candidate.cy < centerY;
    if (isLeft && isTop) {
      quadrants.tl.push(candidate);
    } else if (!isLeft && isTop) {
      quadrants.tr.push(candidate);
    } else if (isLeft && !isTop) {
      quadrants.bl.push(candidate);
    } else {
      quadrants.br.push(candidate);
    }
  }

  const maxDist = Math.hypot(targetWidth, targetHeight);
  const pickCorner = (
    list: (typeof candidates)[number][],
    cornerX: number,
    cornerY: number,
  ) => {
    if (!list.length) return null;
    let best = list[0];
    let bestScore = -Infinity;
    for (const candidate of list) {
      const dist = Math.hypot(candidate.cx - cornerX, candidate.cy - cornerY);
      const score = candidate.area * (1 - dist / maxDist);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  };

  let topLeft = pickCorner(quadrants.tl, 0, 0);
  let topRight = pickCorner(quadrants.tr, targetWidth, 0);
  let bottomLeft = pickCorner(quadrants.bl, 0, targetHeight);
  let bottomRight = pickCorner(quadrants.br, targetWidth, targetHeight);

  if (!topLeft || !topRight || !bottomLeft || !bottomRight) {
    const used = new Set<number>();
    const pick = (
      score: (candidate: (typeof candidates)[number]) => number,
      direction: "min" | "max",
    ) => {
      let bestIndex = -1;
      let bestScore = direction === "min" ? Infinity : -Infinity;
      candidates.forEach((candidate, index) => {
        if (used.has(index)) return;
        const value = score(candidate);
        if (direction === "min" ? value < bestScore : value > bestScore) {
          bestScore = value;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        used.add(bestIndex);
        return candidates[bestIndex];
      }
      return null;
    };

    topLeft = pick((c) => c.cx + c.cy, "min");
    topRight = pick((c) => c.cx - c.cy, "max");
    bottomLeft = pick((c) => c.cy - c.cx, "max");
    bottomRight = pick((c) => c.cx + c.cy, "max");
  }

  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return null;

  const rotateMarkers = (
    rotation: 0 | 90 | 180 | 270,
    markers: {
      topLeft: typeof topLeft;
      topRight: typeof topRight;
      bottomLeft: typeof bottomLeft;
      bottomRight: typeof bottomRight;
    },
  ) => {
    switch (rotation) {
      case 90:
        return {
          topLeft: markers.topRight,
          topRight: markers.bottomRight,
          bottomRight: markers.bottomLeft,
          bottomLeft: markers.topLeft,
        };
      case 180:
        return {
          topLeft: markers.bottomRight,
          topRight: markers.bottomLeft,
          bottomRight: markers.topLeft,
          bottomLeft: markers.topRight,
        };
      case 270:
        return {
          topLeft: markers.bottomLeft,
          topRight: markers.topLeft,
          bottomRight: markers.topRight,
          bottomLeft: markers.bottomRight,
        };
      default:
        return markers;
    }
  };

  let resolvedMarkers = { topLeft, topRight, bottomLeft, bottomRight };
  const markerStyles = layout.markers.styles;
  if (markerStyles?.topLeft === "finder" && markerStyles?.topRight === "finder") {
    const finderMap = {
      topLeft: topLeft.isFinder,
      topRight: topRight.isFinder,
      bottomLeft: bottomLeft.isFinder,
      bottomRight: bottomRight.isFinder,
    };
    const finderCount = Object.values(finderMap).filter(Boolean).length;
    if (finderCount === 2) {
      let rotation: 0 | 90 | 180 | 270 = 0;
      if (finderMap.bottomLeft && finderMap.bottomRight) rotation = 180;
      else if (finderMap.topLeft && finderMap.bottomLeft) rotation = 270;
      else if (finderMap.topRight && finderMap.bottomRight) rotation = 90;
      resolvedMarkers = rotateMarkers(rotation, resolvedMarkers);
    }
  }

  const resolvedTopLeft = resolvedMarkers.topLeft;
  const resolvedTopRight = resolvedMarkers.topRight;
  const resolvedBottomLeft = resolvedMarkers.bottomLeft;
  const resolvedBottomRight = resolvedMarkers.bottomRight;

  const minDistance = Math.min(targetWidth, targetHeight) * 0.25;
  const distances = [
    Math.hypot(resolvedTopLeft.cx - resolvedTopRight.cx, resolvedTopLeft.cy - resolvedTopRight.cy),
    Math.hypot(resolvedTopLeft.cx - resolvedBottomLeft.cx, resolvedTopLeft.cy - resolvedBottomLeft.cy),
    Math.hypot(resolvedBottomRight.cx - resolvedTopRight.cx, resolvedBottomRight.cy - resolvedTopRight.cy),
    Math.hypot(resolvedBottomRight.cx - resolvedBottomLeft.cx, resolvedBottomRight.cy - resolvedBottomLeft.cy),
  ];
  if (distances.some((dist) => dist < minDistance)) return null;
  const widthEstimate = (distances[0] + distances[3]) / 2;
  const heightEstimate = (distances[1] + distances[2]) / 2;
  const ratio = widthEstimate / Math.max(1, heightEstimate);
  const expectedRatio = layout.page.widthMm / layout.page.heightMm;
  if (Math.abs(ratio - expectedRatio) > 0.25) return null;

  const invScale = 1 / scale;
  return {
    topLeft: { x: resolvedTopLeft.cx * invScale, y: resolvedTopLeft.cy * invScale },
    topRight: { x: resolvedTopRight.cx * invScale, y: resolvedTopRight.cy * invScale },
    bottomLeft: { x: resolvedBottomLeft.cx * invScale, y: resolvedBottomLeft.cy * invScale },
    bottomRight: { x: resolvedBottomRight.cx * invScale, y: resolvedBottomRight.cy * invScale },
  };
}

// Compute a projective transform between page coordinates and the photo.
function solveHomography(source: ScanPoint[], target: ScanPoint[]): number[] | null {
  if (source.length !== 4 || target.length !== 4) return null;
  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = source[i];
    const { x: u, y: v } = target[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }

  const n = 8;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);

  for (let i = 0; i < n; i += 1) {
    let maxRow = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(augmented[r][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = r;
      }
    }
    if (Math.abs(augmented[maxRow][i]) < 1e-10) return null;
    if (maxRow !== i) {
      const temp = augmented[i];
      augmented[i] = augmented[maxRow];
      augmented[maxRow] = temp;
    }
    const pivot = augmented[i][i];
    for (let c = i; c <= n; c += 1) {
      augmented[i][c] /= pivot;
    }
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const factor = augmented[r][i];
      if (factor === 0) continue;
      for (let c = i; c <= n; c += 1) {
        augmented[r][c] -= factor * augmented[i][c];
      }
    }
  }

  return augmented.map((row) => row[n]);
}

function applyHomography(point: ScanPoint, matrix: number[]): ScanPoint {
  const denom = matrix[6] * point.x + matrix[7] * point.y + 1;
  if (denom === 0) return { x: 0, y: 0 };
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denom,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denom,
  };
}

function sampleLuma(luma: Uint8ClampedArray, width: number, height: number, x: number, y: number): number {
  if (!width || !height) return 255;
  const safeX = Math.min(Math.max(x, 0), width - 1);
  const safeY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(safeX);
  const y0 = Math.floor(safeY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const dx = safeX - x0;
  const dy = safeY - y0;
  const idx00 = y0 * width + x0;
  const idx10 = y0 * width + x1;
  const idx01 = y1 * width + x0;
  const idx11 = y1 * width + x1;
  const top = luma[idx00] * (1 - dx) + luma[idx10] * dx;
  const bottom = luma[idx01] * (1 - dx) + luma[idx11] * dx;
  return top * (1 - dy) + bottom * dy;
}

function sampleBrightness(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  const offsets = radius > 0 ? [-radius, 0, radius] : [0];
  let total = 0;
  let count = 0;
  for (const dx of offsets) {
    for (const dy of offsets) {
      const sx = x + dx;
      const sy = y + dy;
      total += sampleLuma(luma, width, height, sx, sy);
      count += 1;
    }
  }
  if (!count) return 255;
  return total / count;
}

function samplePageBrightness(context: ScanContext, point: ScanPoint, offsetMm: number): number {
  const { luma, matrix, width, height } = context;
  const centerImg = applyHomography(point, matrix);
  const rightImg = applyHomography({ x: point.x + offsetMm, y: point.y }, matrix);
  const downImg = applyHomography({ x: point.x, y: point.y + offsetMm }, matrix);
  const radius = Math.max(
    1,
    Math.round(
      Math.min(
        Math.hypot(rightImg.x - centerImg.x, rightImg.y - centerImg.y),
        Math.hypot(downImg.x - centerImg.x, downImg.y - centerImg.y),
      ),
    ),
  );
  return sampleBrightness(luma, width, height, centerImg.x, centerImg.y, radius);
}

function samplePageBackground(context: ScanContext, layout: BiblePrintLayout): number {
  const marginInset = Math.max(2, layout.marginMm * 0.5);
  const widthMm = layout.page.widthMm;
  const heightMm = layout.page.heightMm;
  const points: ScanPoint[] = [
    { x: widthMm * 0.25, y: marginInset },
    { x: widthMm * 0.5, y: marginInset },
    { x: widthMm * 0.75, y: marginInset },
    { x: widthMm * 0.25, y: heightMm - marginInset },
    { x: widthMm * 0.5, y: heightMm - marginInset },
    { x: widthMm * 0.75, y: heightMm - marginInset },
    { x: marginInset, y: heightMm * 0.35 },
    { x: marginInset, y: heightMm * 0.65 },
    { x: widthMm - marginInset, y: heightMm * 0.35 },
    { x: widthMm - marginInset, y: heightMm * 0.65 },
  ];
  const radiusMm = Math.max(1.5, layout.marginMm * 0.3);
  const samples = points.map((point) => samplePageBrightness(context, point, radiusMm));
  return computeMedian(samples);
}

function sampleMarkerMedian(context: ScanContext, layout: BiblePrintLayout): number {
  const radiusMm = layout.markers.sizeMm * 0.35;
  const points = Object.values(layout.markers.centersMm);
  const samples = points.map((point) => samplePageBrightness(context, point, radiusMm));
  return computeMedian(samples);
}

function detectPageIdIndex(
  context: ScanContext,
  layout: BiblePrintLayout,
  backgroundMedian: number,
  markerMedian: number,
): number | null {
  const { pageId } = layout;
  if (!pageId?.positionsMm?.length || !pageId?.patterns?.length) return null;
  const threshold = (backgroundMedian + markerMedian) / 2;
  const sampleOffset = pageId.sizeMm * 0.4;
  const observed = pageId.positionsMm.map((pos) => {
    const center = { x: pos.x + pageId.sizeMm / 2, y: pos.y + pageId.sizeMm / 2 };
    const brightness = samplePageBrightness(context, center, sampleOffset);
    return brightness < threshold ? 1 : 0;
  });

  let bestIndex = -1;
  let bestDistance = Infinity;
  let secondDistance = Infinity;
  pageId.patterns.forEach((pattern, index) => {
    if (pattern.length !== observed.length) return;
    const distance = pattern.reduce((acc, bit, bitIndex) => acc + (bit !== observed[bitIndex] ? 1 : 0), 0);
    if (distance < bestDistance) {
      secondDistance = bestDistance;
      bestDistance = distance;
      bestIndex = index;
    } else if (distance < secondDistance) {
      secondDistance = distance;
    }
  });

  if (bestIndex < 0) return null;
  const maxErrors = Math.max(1, Math.floor(pageId.count / 4));
  if (bestDistance > maxErrors) return null;
  if (bestDistance === secondDistance) return null;
  return bestIndex;
}

function buildScanContext(canvas: HTMLCanvasElement, layout: BiblePrintLayout): ScanContext {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to read the camera frame.");
  }
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) {
    throw new Error("Scan image is empty.");
  }
  const markers = detectMarkers(canvas, layout);
  if (!markers) {
    throw new Error("Alignment markers not found. Make sure the full page is visible.");
  }

  const source = [
    layout.markers.centersMm.topLeft,
    layout.markers.centersMm.topRight,
    layout.markers.centersMm.bottomRight,
    layout.markers.centersMm.bottomLeft,
  ];
  const target = [markers.topLeft, markers.topRight, markers.bottomRight, markers.bottomLeft];
  const matrix = solveHomography(source, target);
  if (!matrix) {
    throw new Error("Unable to align the page. Try another scan.");
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const luma = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    luma[p] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return { imageData, luma, matrix, width, height };
}

function analyzeScanPage(
  context: ScanContext,
  layout: BiblePrintLayout,
  pageIndex: number,
  backgroundMedian: number,
  markerMedian: number,
): ScanAnalysis {
  const boxSizeMm = layout.boxes.sizeMm;
  const progress: BibleTrackerProgress = {};
  let filledCount = 0;
  const gapMm = layout.boxes.gapMm;
  const sampleRadiusMm = Math.max(0.55, boxSizeMm * 0.14);
  const innerOffsetMm = boxSizeMm * 0.23;
  const innerOffsets = [-innerOffsetMm, 0, innerOffsetMm];
  const sampleOffsets: ScanPoint[] = [];
  for (const dx of innerOffsets) {
    for (const dy of innerOffsets) {
      sampleOffsets.push({ x: dx, y: dy });
    }
  }
  const backgroundOffsetMm = boxSizeMm * 0.5 + gapMm * 0.55;
  const backgroundOffsets: ScanPoint[] = [
    { x: backgroundOffsetMm, y: 0 },
    { x: -backgroundOffsetMm, y: 0 },
    { x: 0, y: backgroundOffsetMm },
    { x: 0, y: -backgroundOffsetMm },
    { x: backgroundOffsetMm, y: backgroundOffsetMm },
    { x: -backgroundOffsetMm, y: backgroundOffsetMm },
    { x: backgroundOffsetMm, y: -backgroundOffsetMm },
    { x: -backgroundOffsetMm, y: -backgroundOffsetMm },
  ];
  const backgroundRadiusMm = Math.max(0.7, gapMm * 0.55);

  const globalContrast = Math.max(1, backgroundMedian - markerMedian);
  const normalizedThreshold = 0.2 + Math.min(0.12, globalContrast / 900);
  const contrastThreshold = Math.max(12, Math.min(MIN_FILL_CONTRAST, globalContrast * 0.25));
  const requiredDarkSamples = Math.max(MIN_DARK_SAMPLES, Math.round(sampleOffsets.length * 0.35));
  const strongSampleCount = Math.max(2, Math.round(sampleOffsets.length * 0.2));
  const strongNormalizedThreshold = Math.min(0.65, normalizedThreshold + 0.12);
  const strongContrastThreshold = contrastThreshold + 6;

  for (const box of layout.pages[pageIndex].boxes) {
    const centerPage = { x: box.x + boxSizeMm / 2, y: box.y + boxSizeMm / 2 };
    const brightnessSamples = sampleOffsets.map((offset) =>
      samplePageBrightness(
        context,
        { x: centerPage.x + offset.x, y: centerPage.y + offset.y },
        sampleRadiusMm,
      ),
    );
    const localBackground = computeMedian(
      backgroundOffsets.map((offset) =>
        samplePageBrightness(
          context,
          { x: centerPage.x + offset.x, y: centerPage.y + offset.y },
          backgroundRadiusMm,
        ),
      ),
    );
    // Blend local and global background to smooth out shadows across the page.
    const blendedBackground = computeMedian([
      localBackground,
      backgroundMedian,
      (localBackground + backgroundMedian) / 2,
    ]);
    const contrastRange = Math.max(12, blendedBackground - markerMedian);

    const brightnessMedian = computeMedian(brightnessSamples);
    const contrastMedian = Math.max(0, blendedBackground - brightnessMedian);
    const normalizedMedian = contrastMedian / contrastRange;

    let darkSamples = 0;
    let strongSamples = 0;
    let maxNormalized = 0;
    let maxContrast = 0;
    for (const value of brightnessSamples) {
      const contrast = Math.max(0, blendedBackground - value);
      if (contrast > maxContrast) maxContrast = contrast;
      const normalized = contrast / contrastRange;
      if (normalized >= normalizedThreshold) darkSamples += 1;
      if (normalized >= strongNormalizedThreshold) strongSamples += 1;
      if (normalized > maxNormalized) maxNormalized = normalized;
    }

    const isFilled =
      (normalizedMedian >= normalizedThreshold &&
        contrastMedian >= contrastThreshold &&
        darkSamples >= requiredDarkSamples) ||
      (maxNormalized >= strongNormalizedThreshold &&
        maxContrast >= strongContrastThreshold &&
        strongSamples >= strongSampleCount);

    if (!isFilled) continue;
    filledCount += 1;
    if (!progress[box.bookId]) {
      progress[box.bookId] = [];
    }
    progress[box.bookId].push(box.chapter);
  }

  return {
    progress,
    filledCount,
    threshold: normalizedThreshold,
    backgroundMedian,
    pageIndex,
    layoutVersion: layout.version as BiblePrintLayoutVersion,
    pageIdDetected: false,
  };
}

function analyzeScanAuto(
  context: ScanContext,
  layout: BiblePrintLayout,
  backgroundMedian: number,
  markerMedian: number,
): ScanAnalysis {
  const pageIdIndex = detectPageIdIndex(context, layout, backgroundMedian, markerMedian);
  if (pageIdIndex != null) {
    const analysis = analyzeScanPage(context, layout, pageIdIndex, backgroundMedian, markerMedian);
    return { ...analysis, pageIdDetected: true };
  }
  const analyses = layout.pages.map((_, index) =>
    analyzeScanPage(context, layout, index, backgroundMedian, markerMedian),
  );
  let best = analyses[0];
  for (const analysis of analyses) {
    if (analysis.filledCount > best.filledCount) {
      best = analysis;
    }
  }
  return best;
}

function analyzeScanCanvas(
  canvas: HTMLCanvasElement,
  layout: BiblePrintLayout,
  pageSelection: number | "auto",
): ScanAnalysis {
  const context = buildScanContext(canvas, layout);
  const markerMedian = sampleMarkerMedian(context, layout);
  if (markerMedian > MAX_MARKER_LUMA) {
    throw new Error("Alignment markers not detected. Keep the four corner markers visible.");
  }
  const backgroundMedian = samplePageBackground(context, layout);
  const contrast = backgroundMedian - markerMedian;
  if (backgroundMedian < MIN_PAGE_BACKGROUND_LUMA && contrast < MIN_MARKER_CONTRAST) {
    throw new Error("Page background not detected. Keep the full page visible and well lit.");
  }
  if (pageSelection === "auto") {
    return analyzeScanAuto(context, layout, backgroundMedian, markerMedian);
  }
  return analyzeScanPage(context, layout, pageSelection, backgroundMedian, markerMedian);
}

function analyzeScanCanvasAcrossLayouts(
  canvas: HTMLCanvasElement,
  layouts: BiblePrintLayout[],
  pageSelection: number | "auto",
): ScanAnalysis {
  const analyses: ScanAnalysis[] = [];
  const errors: unknown[] = [];
  for (const layout of layouts) {
    if (pageSelection !== "auto" && pageSelection >= layout.page.count) continue;
    try {
      analyses.push(analyzeScanCanvas(canvas, layout, pageSelection));
    } catch (err) {
      errors.push(err);
    }
  }
  if (!analyses.length) {
    const firstError = errors[0];
    if (firstError instanceof Error) throw firstError;
    throw new Error("Scan failed.");
  }
  return analyses.reduce((best, next) => {
    if (next.pageIdDetected && !best.pageIdDetected) return next;
    if (!next.pageIdDetected && best.pageIdDetected) return best;
    if (next.filledCount > best.filledCount) return next;
    if (next.filledCount < best.filledCount) return best;
    if (next.layoutVersion === "v3" && best.layoutVersion !== "v3") return next;
    return best;
  });
}

export function BibleTrackerScanPanel({
  state,
  onApply,
  paperSize,
  onPaperSizeChange,
}: {
  state: BibleTrackerState;
  onApply: (progress: BibleTrackerProgress) => void;
  paperSize: PrintPaperSize;
  onPaperSizeChange: (paperSize: PrintPaperSize) => void;
}) {
  const layouts = useMemo(() => {
    const versions: BiblePrintLayoutVersion[] = ["v3", "v2"];
    return versions.map((layoutVersion) => buildBiblePrintLayout(paperSize, { layoutVersion }));
  }, [paperSize]);
  const maxPageCount = useMemo(() => Math.max(...layouts.map((layout) => layout.page.count)), [layouts]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [pageSelection, setPageSelection] = useState<"auto" | number>("auto");
  const [detectedPageIndex, setDetectedPageIndex] = useState<number | null>(null);
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<ScanAnalysis | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setPageSelection((prev) => (prev === "auto" || prev < maxPageCount ? prev : "auto"));
    setDetectedPageIndex((prev) => (prev != null && prev < maxPageCount ? prev : null));
  }, [maxPageCount]);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!cameraActive) {
      stopCamera();
      return;
    }
    let cancelled = false;
    async function startCamera() {
      setCameraError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Camera unavailable.";
        setCameraError(message);
        setCameraActive(false);
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera not supported on this device.");
      setCameraActive(false);
      return;
    }
    startCamera();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraActive, stopCamera]);

  useEffect(() => {
    setScanError(null);
    setScanResult(null);
    setPreviewUrl(null);
    setDetectedPageIndex(null);
    setCameraError(null);
    setCameraActive(true);
  }, [pageSelection]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const captureVideoFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas;
  }, []);

  const analyzeCanvas = useCallback(
    async (
      canvas: HTMLCanvasElement,
      options?: {
        reportErrors?: boolean;
        setPreview?: boolean;
      }
    ) => {
      const reportErrors = options?.reportErrors !== false;
      const shouldSetPreview = options?.setPreview !== false;
      try {
        setScanBusy(true);
        if (reportErrors) setScanError(null);
        const result = analyzeScanCanvasAcrossLayouts(canvas, layouts, pageSelection);
        if (pageSelection === "auto") {
          setDetectedPageIndex(result.pageIndex);
        } else {
          setDetectedPageIndex(null);
        }
        setScanResult(result);
        if (shouldSetPreview) {
          setPreviewUrl(canvas.toDataURL("image/jpeg", 0.85));
        }
        return result;
      } catch (err) {
        if (reportErrors) {
          const message = err instanceof Error ? err.message : "Scan failed.";
          setScanError(message);
          setScanResult(null);
        }
        return null;
      } finally {
        setScanBusy(false);
      }
    },
    [layouts, pageSelection]
  );

  const handleCapture = useCallback(async () => {
    const canvas = captureVideoFrame();
    if (!canvas) {
      setScanError("Camera is not ready yet.");
      return;
    }
    const result = await analyzeCanvas(canvas, { reportErrors: true, setPreview: true });
    if (result) {
      setCameraActive(false);
    }
  }, [analyzeCanvas, captureVideoFrame]);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Unable to read the image."));
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to read the image.");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        await analyzeCanvas(canvas, { reportErrors: true, setPreview: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to read the image.";
        setScanError(message);
        setScanResult(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [analyzeCanvas]
  );

  const newChaptersByBook = useMemo(() => {
    if (!scanResult) return [];
    const progress = state.progress || {};
    return BIBLE_BOOKS.map((book) => {
      const chapters = scanResult.progress[book.id] || [];
      if (!chapters.length) return null;
      const existing = new Set(progress[book.id] || []);
      const nextChapters = chapters.filter((chapter) => !existing.has(chapter)).sort((a, b) => a - b);
      if (!nextChapters.length) return null;
      return { bookId: book.id, name: book.name, chapters: nextChapters };
    }).filter(Boolean) as Array<{ bookId: string; name: string; chapters: number[] }>;
  }, [scanResult, state.progress]);

  const newChapters = useMemo(
    () => newChaptersByBook.reduce((total, entry) => total + entry.chapters.length, 0),
    [newChaptersByBook],
  );

  const handleApply = useCallback(() => {
    if (!scanResult) return;
    onApply(scanResult.progress);
  }, [onApply, scanResult]);

  const showGuides = cameraActive;

  return (
    <div className="bible-scan-panel">
      <div className="text-xs text-secondary">
        <div className="flex flex-wrap items-center gap-2">
          <span>Paper size</span>
          <select
            className="print-paper-select"
            value={paperSize}
            onChange={(event) => onPaperSizeChange(event.target.value as PrintPaperSize)}
            aria-label="Paper size"
          >
            {PRINT_PAPER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="bible-scan-detect">
        <div className="text-xs font-semibold text-primary">Page detection</div>
        <div className="bible-scan-toggle" role="group" aria-label="Page detection">
          <button
            type="button"
            className="bible-scan-toggle__option pressable"
            data-active={pageSelection === "auto"}
            aria-pressed={pageSelection === "auto"}
            onClick={() => setPageSelection("auto")}
          >
            Auto
          </button>
          {Array.from({ length: maxPageCount }, (_, index) => (
            <button
              key={index}
              type="button"
              className="bible-scan-toggle__option pressable"
              data-active={pageSelection === index}
              aria-pressed={pageSelection === index}
              onClick={() => setPageSelection(index)}
            >
              Page {index + 1}
            </button>
          ))}
        </div>
        {pageSelection === "auto" && (
          <div className="bible-scan-status text-xs text-secondary">
            {detectedPageIndex != null
              ? `Auto detected: Page ${detectedPageIndex + 1}.`
              : "Auto detect is ready. Hold the full page in view."}
          </div>
        )}
      </div>

      <div className="wallet-scanner">
        <div className={`wallet-scanner__viewport${cameraError ? " wallet-scanner__viewport--error" : ""}`}>
          {cameraError ? (
            <div className="wallet-scanner__fallback">{cameraError}</div>
          ) : cameraActive ? (
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
          ) : previewUrl ? (
            <img src={previewUrl} alt="Scan preview" className="bible-scan-preview__image" />
          ) : (
            <div className="wallet-scanner__fallback">Camera is off.</div>
          )}
          {showGuides && <div className="wallet-scanner__guide" aria-hidden="true" />}
        </div>
        <div className="wallet-scanner__hint text-xs text-secondary text-center">
          {cameraActive
            ? "Hold the full page in view and tap Capture."
            : "Use the camera or upload a photo with all four markers visible."}
        </div>
      </div>

      <div className="bible-scan-actions">
        {cameraActive && (
          <button
            type="button"
            className="accent-button button-sm pressable"
            onClick={handleCapture}
            disabled={scanBusy}
          >
            Capture
          </button>
        )}
        <label className="ghost-button button-sm pressable bible-scan-upload">
          Upload photo
          <input type="file" accept="image/*" onChange={handleFileChange} />
        </label>
        {cameraError && !cameraActive && (
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={() => {
              setCameraError(null);
              setCameraActive(true);
            }}
          >
            Retry camera
          </button>
        )}
      </div>

      {scanBusy && <div className="text-xs text-secondary">Analyzing scan...</div>}
      {scanError && <div className="text-sm text-rose-400">{scanError}</div>}

      {scanResult && (
        <div className="bible-scan-results">
          <div className="text-sm font-medium text-primary">
            Detected {scanResult.filledCount} filled chapters
          </div>
          <div className="text-xs text-secondary">
            Page {scanResult.pageIndex + 1} captured.
          </div>
          <div className="text-xs text-secondary">
            {newChapters > 0
              ? `${newChapters} new chapter${newChapters === 1 ? "" : "s"} to add.`
              : "No new chapters found."}
          </div>
          {newChapters > 0 && (
            <div className="bible-scan-chapters">
              <div className="text-xs font-semibold text-primary">Review new chapters</div>
              <div className="bible-scan-chapter-list">
                {newChaptersByBook.map((entry) => (
                  <div key={entry.bookId} className="bible-scan-chapter-row">
                    <span className="bible-scan-chapter-book text-xs text-primary">{entry.name}</span>
                    <span className="bible-scan-chapter-range text-xs text-secondary">
                      {formatChapterRanges(entry.chapters)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bible-scan-actions">
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={handleApply}
              disabled={scanBusy}
            >
              Add to tracker
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setScanResult(null);
                setPreviewUrl(null);
                setScanError(null);
                setDetectedPageIndex(null);
                setCameraActive(true);
              }}
              disabled={scanBusy}
            >
              Scan again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
