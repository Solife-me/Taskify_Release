/**
 * Reads a photographed Taskify print (a board sheet or the Bible tracker): finds the four corner
 * markers, aligns the page with a projective transform, measures the paper and marker brightness,
 * identifies the page from its page-id marks, and decides which marks were filled in.
 *
 * Shared by both scan sheets, which differ only in what they print as marks (task circles,
 * chapter boxes) and how widely around each mark the paper is sampled. Works on plain brightness
 * arrays, so it is tested without a canvas (`scanEngine.test.ts`); `scanCanvas.ts` turns a camera
 * frame into a `ScanPhoto`.
 */

export type ScanPoint = { x: number; y: number };
/** Brightness (0-255) per pixel, row by row. */
export type LumaImage = { luma: Uint8ClampedArray; width: number; height: number };
/** A photo, and a reduced copy (`scale` times its size) for finding the markers. */
export type ScanPhoto = { full: LumaImage; reduced: LumaImage; scale: number };

type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/** What every Taskify print layout has in common. */
export type ScanLayout = {
  page: { widthMm: number; heightMm: number };
  marginMm: number;
  markers: {
    sizeMm: number;
    centersMm: Record<Corner, ScanPoint>;
    styles?: Partial<Record<Corner, "solid" | "finder">>;
  };
  pageId?: { sizeMm: number; count: number; positionsMm: ScanPoint[]; patterns: number[][] };
  jobCode?: { sizeMm: number; count: number; positionsMm: ScanPoint[]; pattern: number[] };
};

/** A mark that can be filled in, at its center on the page. */
export type ScanMark<K> = { key: K; centerMm: ScanPoint };

export type ScanMarkGeometry = { shape: "circle" | "square"; sizeMm: number };

export type ScanResult<K> = {
  filled: K[];
  filledCount: number;
  markAlignment: number;
  threshold: number;
  backgroundMedian: number;
  pageIndex: number;
  /** The page was identified by its page-id marks (not chosen by the user or by elimination). */
  pageIdDetected: boolean;
  jobCodeDetected: boolean;
  jobCodeMatches: boolean;
};

type MarkerSet = Record<Corner, ScanPoint>;

type ScanContext = {
  luma: Uint8ClampedArray;
  matrix: number[];
  width: number;
  height: number;
};

const MAX_MARKER_LUMA = 210;
const MIN_MARKER_CONTRAST = 32;
const FINDER_CONTRAST_THRESHOLD = 32;

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

// Locate the four printed corner markers to align the page (on the reduced copy).
function detectMarkers(reduced: LumaImage, scale: number, layout: ScanLayout): MarkerSet | null {
  const { luma, width: targetWidth, height: targetHeight } = reduced;
  if (!targetWidth || !targetHeight) return null;
  const pixelCount = targetWidth * targetHeight;
  const threshold = Math.min(210, computeOtsuThreshold(luma) + 8);
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

  const minArea = Math.max(12, Math.floor(pixelCount * 0.00004));
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
      const finderInset = Math.min(width, height) * 0.15;
      const middleLuma = computeMedian([
        sampleLuma(cx - finderInset, cy, 0), sampleLuma(cx + finderInset, cy, 0),
        sampleLuma(cx, cy - finderInset, 0), sampleLuma(cx, cy + finderInset, 0),
      ]);
      const outer = Math.min(width, height) * 0.44;
      const outerLuma = computeMedian([
        sampleLuma(cx - outer, cy, 0), sampleLuma(cx + outer, cy, 0),
        sampleLuma(cx, cy - outer, 0), sampleLuma(cx, cy + outer, 0),
      ]);
      const hollowFinder = centerLuma - edgeLuma > FINDER_CONTRAST_THRESHOLD && centerLuma > threshold;
      const centeredFinder = middleLuma - Math.max(centerLuma, outerLuma) > FINDER_CONTRAST_THRESHOLD;
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
        isFinder: hollowFinder || centeredFinder,
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

function samplePageBackground(context: ScanContext, layout: ScanLayout): number {
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

function sampleMarkerMedian(context: ScanContext, layout: ScanLayout): number {
  const radiusMm = layout.markers.sizeMm * 0.35;
  const points = Object.values(layout.markers.centersMm);
  const samples = points.map((point) => samplePageBrightness(context, point, radiusMm));
  return computeMedian(samples);
}

function detectPageIdIndex(
  context: ScanContext,
  layout: ScanLayout,
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

function readJobCode(
  context: ScanContext,
  layout: ScanLayout,
  backgroundMedian: number,
  markerMedian: number,
): { detected: boolean; matches: boolean } {
  const jobCode = layout.jobCode;
  if (!jobCode?.positionsMm?.length || !jobCode.pattern.length) {
    return { detected: false, matches: true };
  }
  const threshold = markerMedian + Math.max(18, (backgroundMedian - markerMedian) * 0.35);
  const sampleOffset = jobCode.sizeMm * 0.4;
  const observed = jobCode.positionsMm.map((pos) => {
    const center = { x: pos.x + jobCode.sizeMm / 2, y: pos.y + jobCode.sizeMm / 2 };
    return samplePageBrightness(context, center, sampleOffset) < threshold ? 1 : 0;
  });
  const errors = jobCode.pattern.reduce(
    (total, bit, index) => total + (bit !== observed[index] ? 1 : 0),
    0,
  );
  return {
    detected: true,
    matches: observed.length === jobCode.pattern.length && errors <= Math.max(1, Math.floor(jobCode.count / 5)),
  };
}

function buildScanContext(photo: ScanPhoto, layout: ScanLayout): ScanContext {
  const { full } = photo;
  if (!full.width || !full.height) {
    throw new Error("Scan image is empty.");
  }
  const markers = detectMarkers(photo.reduced, photo.scale, layout);
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
  return { luma: full.luma, matrix, width: full.width, height: full.height };
}

type LocatedMark = { center: ScanPoint; radius: number; background: number; score: number };
const directions = Array.from({ length: 16 }, (_, index) => {
  const angle = index * Math.PI / 8;
  return { x: Math.cos(angle), y: Math.sin(angle) };
});

function samplePoint(context: ScanContext, point: ScanPoint): number {
  const { x, y } = applyHomography(point, context.matrix);
  return sampleLuma(context.luma, context.width, context.height, x, y);
}

function locateMark(
  context: ScanContext,
  expected: ScanPoint,
  geometry: ScanMarkGeometry,
  minimumContrast: number,
  searchSteps: number,
): LocatedMark | undefined {
  const perimeter = geometry.shape === "circle" ? directions : squareDirections;
  let best: LocatedMark | undefined;
  for (let dx = -searchSteps; dx <= searchSteps; dx += 1) {
    for (let dy = -searchSteps; dy <= searchSteps; dy += 1) {
      const center = { x: expected.x + dx * 0.5, y: expected.y + dy * 0.5 };
      for (const scale of geometry.shape === "circle" ? [0.9, 1, 1.1] : [1]) {
        const radius = geometry.sizeMm * scale / 2;
        const outside: number[] = [];
        const contrast = perimeter.map(({ x, y }) => {
          const sample = (factor: number) => samplePoint(context, {
            x: center.x + x * radius * factor,
            y: center.y + y * radius * factor,
          });
          const paper = sample(geometry.shape === "circle" ? 1.38 : 1.20);
          outside.push(paper);
          return paper - Math.min(sample(0.88), sample(1));
        });
        const supported = contrast.slice(0, 8)
          .map((edge, index) => Math.min(edge, contrast[index + 8]))
          .filter((edge) => edge >= minimumContrast);
        if (supported.length < 5) continue;
        // Count shared edges first. A single dark arc or adjacent text cannot establish a center.
        const score = supported.length + supported.reduce(
          (sum, edge) => sum + Math.min(edge / minimumContrast, 5) / 12, 0,
        ) - Math.hypot(dx, dy) * 0.06;
        if (!best || score > best.score) {
          best = { center, radius, background: computeMedian(outside), score };
        }
      }
    }
  }
  return best;
}

const squareDirections = directions.map(({ x, y }) => {
  const edge = Math.max(Math.abs(x), Math.abs(y));
  return { x: x / edge, y: y / edge };
});

function hasInteriorInk(context: ScanContext, mark: LocatedMark, markerMedian: number): boolean {
  const threshold = mark.background - Math.max(16, (mark.background - markerMedian) * 0.2);
  const radius = mark.radius * 0.62;
  let dark = 0;
  let darkCore = 0;
  let sampled = 0;
  for (let row = -5; row <= 5; row += 1) {
    for (let column = -5; column <= 5; column += 1) {
      const distanceSquared = row * row + column * column;
      if (distanceSquared > 25) continue;
      sampled += 1;
      const value = samplePoint(context, {
        x: mark.center.x + radius * column / 5,
        y: mark.center.y + radius * row / 5,
      });
      if (value >= threshold) continue;
      dark += 1;
      if (distanceSquared <= 9) darkCore += 1;
    }
  }
  return darkCore >= 4 && dark / sampled >= 0.15;
}

function analyzeMarks<K>(
  context: ScanContext,
  marks: ScanMark<K>[],
  geometry: ScanMarkGeometry,
  pageIndex: number,
  backgroundMedian: number,
  markerMedian: number,
): ScanResult<K> {
  const minimumContrast = Math.max(9, (backgroundMedian - markerMedian) * 0.085);
  const searchSteps = geometry.shape === "circle" ? 3 : 1;
  const filled: K[] = [];
  let alignedMarks = 0;
  for (const mark of marks) {
    const outline = locateMark(context, mark.centerMm, geometry, minimumContrast, searchSteps);
    if (!outline) continue;
    alignedMarks += 1;
    if (hasInteriorInk(context, outline, markerMedian)) filled.push(mark.key);
  }
  return {
    filled,
    filledCount: filled.length,
    markAlignment: marks.length ? alignedMarks / marks.length : 0,
    threshold: minimumContrast,
    backgroundMedian,
    pageIndex,
    pageIdDetected: false,
    jobCodeDetected: false,
    jobCodeMatches: true,
  };
}

export type ScanTextLine = { text: string; start: ScanPoint };

function pageMeasurement(photo: ScanPhoto, layout: ScanLayout) {
  const context = buildScanContext(photo, layout);
  const markerMedian = sampleMarkerMedian(context, layout);
  const backgroundMedian = samplePageBackground(context, layout);
  if (markerMedian > MAX_MARKER_LUMA || backgroundMedian - markerMedian < MIN_MARKER_CONTRAST) {
    throw new Error("Alignment markers not detected. Keep the full page visible and well lit.");
  }
  return { context, markerMedian, backgroundMedian };
}

/** Straighten and orient the page for OCR, retaining the transform to the original photo. */
export function rectifyScanForText(photo: ScanPhoto, layout: ScanLayout) {
  const { context } = pageMeasurement(photo, layout);
  const { widthMm, heightMm } = layout.page;
  const scale = Math.max(6, Math.min(10, Math.min(photo.full.width, photo.full.height) / widthMm));
  const width = Math.round(widthMm * scale);
  const height = Math.round(heightMm * scale);
  const luma = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luma[y * width + x] = samplePoint(context, { x: x / scale, y: y / scale });
    }
  }
  return {
    image: { luma, width, height },
    scale,
    toPhoto: ({ x, y }: ScanPoint) => applyHomography({ x: x / scale, y: y / scale }, context.matrix),
  };
}

/** Read marks at OCR line locations. Expected row order and spacing come from the photograph. */
export function scanTextAnchoredCircles<K>(
  photo: ScanPhoto,
  layout: ScanLayout,
  lines: ScanTextLine[],
  column: { leftMm: number; topMm: number; bottomMm: number; sizeMm: number; gapMm: number },
  identify: (lines: ScanTextLine[]) => ((text: string) => K | undefined) | undefined,
) {
  let measured: ReturnType<typeof pageMeasurement>;
  try {
    measured = pageMeasurement(photo, layout);
  } catch {
    return null;
  }
  const { context, markerMedian, backgroundMedian } = measured;
  const source = [{ x: 0, y: 0 }, { x: layout.page.widthMm, y: 0 },
    { x: layout.page.widthMm, y: layout.page.heightMm }, { x: 0, y: layout.page.heightMm }];
  const inverse = solveHomography(source.map((point) => applyHomography(point, context.matrix)), source);
  if (!inverse) return null;
  const pageLines = lines.map(({ text, start }) => ({ text, start: applyHomography(start, inverse) }));
  const resolve = identify(pageLines);
  if (!resolve) return null;

  const titleX = column.leftMm + column.sizeMm + column.gapMm;
  const minimumContrast = Math.max(9, (backgroundMedian - markerMedian) * 0.085);
  const found: Array<{ id: K; center: ScanPoint; marked: boolean }> = [];
  let quality = 0;
  for (const { text, start } of pageLines) {
    if (start.y < column.topMm || start.y >= column.bottomMm ||
      start.x < column.leftMm - 2 || start.x > titleX + 5) continue;
    const center = { x: column.leftMm + column.sizeMm / 2, y: start.y };
    const title = start.x < titleX - 2 ? text.replace(/^\s*[o0◯○•]\s+/iu, "") : text;
    const id = resolve(title);
    if (id === undefined) continue;
    const outline = locateMark(context, center, { shape: "circle", sizeMm: column.sizeMm }, minimumContrast, 4);
    if (!outline) continue;
    quality += outline.score;
    found.push({ id, center: outline.center, marked: hasInteriorInk(context, outline, markerMedian) });
  }
  if (!found.length) return null;
  const filled = found.filter((candidate) => candidate.marked && found.every((other) => {
    const sameCircle = Math.hypot(
      other.center.x - candidate.center.x, other.center.y - candidate.center.y,
    ) < column.sizeMm / 2;
    return (other.id === candidate.id) === sameCircle;
  })).map(({ id }) => id);
  return { filled: [...new Set(filled)], quality };
}

/**
 * Reads one photographed page. `pageSelection` "auto" identifies the page by its page-id marks,
 * or the user selects the printed page number. Throws when the page cannot be read.
 */
export function scanPage<K>(
  photo: ScanPhoto,
  layout: ScanLayout,
  options: {
    pageSelection: number | "auto";
    pageCount: number;
    marksOnPage: (pageIndex: number) => ScanMark<K>[];
    geometry: ScanMarkGeometry;
  },
): ScanResult<K> {
  const { context, markerMedian, backgroundMedian } = pageMeasurement(photo, layout);
  const jobCode = readJobCode(context, layout, backgroundMedian, markerMedian);
  if (layout.jobCode && !jobCode.detected) {
    throw new Error("Print code not detected. Make sure the full page is visible.");
  }
  if (layout.jobCode && !jobCode.matches) {
    throw new Error("This page belongs to a different print or board. Reprint the current checklist.");
  }
  const analyze = (pageIndex: number): ScanResult<K> => ({
    ...analyzeMarks(context, options.marksOnPage(pageIndex), options.geometry, pageIndex, backgroundMedian, markerMedian),
    jobCodeDetected: jobCode.detected,
    jobCodeMatches: jobCode.matches,
  });
  const pageIdIndex = detectPageIdIndex(context, layout, backgroundMedian, markerMedian);
  if (options.pageSelection !== "auto") {
    if (pageIdIndex != null && pageIdIndex !== options.pageSelection) {
      throw new Error(`This is page ${pageIdIndex + 1}. Select that page or use Auto.`);
    }
    return { ...analyze(options.pageSelection), pageIdDetected: pageIdIndex != null };
  }
  if (pageIdIndex != null) return { ...analyze(pageIdIndex), pageIdDetected: true };
  if (options.pageCount === 1) return analyze(0);
  throw new Error("Page number not detected. Select the printed page number and scan again.");
}

/** Exposed for tests: the projective transform between four point pairs. */
export { solveHomography, applyHomography };
