export type AccentPalette = {
  fill: string;
  hover: string;
  active: string;
  soft: string;
  border: string;
  borderActive: string;
  ring: string;
  on: string;
  glow: string;
  shadow: string;
  shadowActive: string;
};

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

type Sample = {
  r: number;
  g: number;
  b: number;
  lab: [number, number, number];
  saturation: number;
  lightness: number;
  hue: number;
  weight: number;
};

type Cluster = {
  r: number;
  g: number;
  b: number;
  lab: [number, number, number];
  saturation: number;
  lightness: number;
  weight: number;
};

const MAX_SAMPLED_PIXELS = 2200;
const TARGET_CLUSTER_COUNT = 6;
const MIN_CLUSTER_DISTANCE = 14; // ΔE threshold in Lab space

export const ACCENT_PALETTE_KEYS: Array<keyof AccentPalette> = [
  "fill",
  "hover",
  "active",
  "soft",
  "border",
  "borderActive",
  "ring",
  "on",
  "glow",
  "shadow",
  "shadowActive",
];

export function normalizeAccentPalette(raw: unknown): AccentPalette | null {
  if (!raw || typeof raw !== "object") return null;
  const result: Partial<AccentPalette> = {};
  for (const key of ACCENT_PALETTE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string" || !value.trim()) return null;
    result[key] = value;
  }
  return result as AccentPalette;
}

export async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unsupported file result"));
    };
    reader.readAsDataURL(file);
  });
}

const DEFAULT_BACKGROUND_MAX_DIMENSION = 1600;
const DEFAULT_BACKGROUND_MAX_BYTES = 760 * 1024; // keep payload well under Safari localStorage limits

const BACKGROUND_IMAGE_ERROR_MESSAGES = {
  decode_failed: "Could not read that photo. Try exporting it as JPEG and upload again.",
  processing_failed: "We hit a snag preparing that photo. Please try a different one.",
  too_large: "That photo is too large to store offline. Try cropping or resizing it first.",
} as const;

export class BackgroundImageError extends Error {
  readonly code: keyof typeof BACKGROUND_IMAGE_ERROR_MESSAGES;

  constructor(code: keyof typeof BACKGROUND_IMAGE_ERROR_MESSAGES, message?: string) {
    super(message ?? BACKGROUND_IMAGE_ERROR_MESSAGES[code]);
    this.name = "BackgroundImageError";
    this.code = code;
  }
}

type PreparedImageOptions = {
  maxDimension?: number;
  maxBytes?: number;
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup?: () => void;
  fallbackDataUrl?: string;
};

export async function prepareBackgroundImage(
  file: File,
  options?: PreparedImageOptions,
): Promise<{ dataUrl: string; palettes: AccentPalette[] }> {
  const maxDimension = options?.maxDimension ?? DEFAULT_BACKGROUND_MAX_DIMENSION;
  const maxBytes = options?.maxBytes ?? DEFAULT_BACKGROUND_MAX_BYTES;

  let decoded: DecodedImage;
  try {
    decoded = await decodeImageFile(file);
  } catch (err) {
    if (err instanceof BackgroundImageError) throw err;
    throw new BackgroundImageError("decode_failed", err instanceof Error ? err.message : String(err));
  }

  try {
    const dataUrl = renderCompressedDataUrl(decoded, { maxDimension, maxBytes });
    const palettes = await buildAccentPalettesFromImage(dataUrl);
    return { dataUrl, palettes };
  } finally {
    decoded.cleanup?.();
  }
}

async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch (err) {
      console.warn("createImageBitmap failed", err);
    }
  }

  let dataUrl: string;
  try {
    dataUrl = await readFileAsDataURL(file);
  } catch (err) {
    throw new BackgroundImageError("decode_failed", err instanceof Error ? err.message : String(err));
  }

  try {
    const image = await loadImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new BackgroundImageError("decode_failed");
    }
    return {
      source: image,
      width,
      height,
      fallbackDataUrl: dataUrl,
    };
  } catch (err) {
    if (err instanceof BackgroundImageError) throw err;
    throw new BackgroundImageError("decode_failed", err instanceof Error ? err.message : String(err));
  }
}

function renderCompressedDataUrl(
  decoded: DecodedImage,
  { maxDimension, maxBytes }: { maxDimension: number; maxBytes: number },
): string {
  const { source, width, height, fallbackDataUrl } = decoded;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    if (fallbackDataUrl) return fallbackDataUrl;
    throw new BackgroundImageError("processing_failed");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const mimeCandidates: Array<"image/webp" | "image/jpeg"> = ["image/webp", "image/jpeg"];
  const qualitySteps = [0.85, 0.75, 0.65, 0.55];
  const maxResizeAttempts = 5;

  const largestSide = Math.max(width, height);
  let scale = largestSide > 0 ? Math.min(1, maxDimension / largestSide) : 1;
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  let targetWidth = Math.max(1, Math.round(width * scale));
  let targetHeight = Math.max(1, Math.round(height * scale));
  let bestCandidate: { dataUrl: string; bytes: number } | null = null;

  for (let resizeAttempt = 0; resizeAttempt < maxResizeAttempts; resizeAttempt += 1) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

    for (const mimeType of mimeCandidates) {
      for (const quality of qualitySteps) {
        const encoded = encodeCanvas(canvas, mimeType, quality);
        if (!encoded) continue;
        const bytes = estimateDataUrlBytes(encoded);
        if (!bestCandidate || bytes < bestCandidate.bytes) {
          bestCandidate = { dataUrl: encoded, bytes };
        }
        if (bytes <= maxBytes) {
          return encoded;
        }
      }
    }

    targetWidth = Math.max(1, Math.round(targetWidth * 0.82));
    targetHeight = Math.max(1, Math.round(targetHeight * 0.82));
  }

  if (bestCandidate && bestCandidate.bytes <= maxBytes) {
    return bestCandidate.dataUrl;
  }

  if (fallbackDataUrl) {
    const fallbackBytes = estimateDataUrlBytes(fallbackDataUrl);
    if (fallbackBytes <= maxBytes) {
      return fallbackDataUrl;
    }
  }

  throw new BackgroundImageError("too_large");
}

function encodeCanvas(canvas: HTMLCanvasElement, mimeType: "image/webp" | "image/jpeg", quality: number): string | null {
  try {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    if (mimeType === "image/jpeg" && dataUrl.startsWith("data:image/jpeg")) return dataUrl;
    if (mimeType === "image/webp" && dataUrl.startsWith("data:image/webp")) return dataUrl;
  } catch (err) {
    console.warn("Failed to encode canvas", err);
  }
  return null;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return 0;
  const base64 = dataUrl.slice(commaIndex + 1);
  return Math.floor((base64.length * 3) / 4);
}

export async function buildAccentPalettesFromImage(dataUrl: string): Promise<AccentPalette[]> {
  const image = await loadImage(dataUrl);
  const samples = sampleImage(image);
  if (!samples.length) {
    return [createPalette({ r: 52, g: 199, b: 89 })];
  }

  const clusterCount = Math.min(TARGET_CLUSTER_COUNT, Math.max(3, Math.floor(samples.length / 80)));
  const clusters = clusterSamples(samples, clusterCount).sort((a, b) => b.weight - a.weight);
  const accents = selectAccents(clusters, 3);

  return accents.map((cluster) => createPalette({ r: cluster.r, g: cluster.g, b: cluster.b }));
}

export function normalizeAccentPaletteList(raw: unknown): AccentPalette[] | null {
  if (!Array.isArray(raw)) return null;
  const list: AccentPalette[] = [];
  for (const item of raw) {
    const palette = normalizeAccentPalette(item);
    if (!palette) return null;
    list.push(palette);
  }
  return list;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function sampleImage(image: HTMLImageElement): Sample[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const scale = Math.min(1, Math.sqrt(MAX_SAMPLED_PIXELS / Math.max(1, image.width * image.height)));
  const width = Math.max(16, Math.round(image.width * scale));
  const height = Math.max(16, Math.round(image.height * scale));
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, 0, 0, width, height);

  const data = ctx.getImageData(0, 0, width, height).data;
  const samples: Sample[] = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 180) continue;

    const { h, s, l } = rgbToHsl(r, g, b);
    const lab = rgbToLab(r, g, b);
    const saturationWeight = Math.pow(s, 1.2);
    const balanceWeight = 1 - Math.abs(l - 0.45);
    const weight = 0.12 + saturationWeight * 0.6 + balanceWeight * 0.28;

    samples.push({
      r,
      g,
      b,
      lab,
      saturation: s,
      lightness: l,
      hue: h,
      weight,
    });
  }

  return samples;
}

function clusterSamples(samples: Sample[], k: number): Cluster[] {
  if (samples.length <= k) {
    return samples.map((s) => ({
      r: s.r,
      g: s.g,
      b: s.b,
      lab: s.lab,
      saturation: s.saturation,
      lightness: s.lightness,
      weight: s.weight,
    }));
  }

  const centroids = initializeCentroids(samples, k);
  const assignments = new Array(samples.length).fill(0);

  for (let iteration = 0; iteration < 7; iteration++) {
    const totals = Array.from({ length: k }, () => ({
      weight: 0,
      r: 0,
      g: 0,
      b: 0,
      lab: [0, 0, 0] as [number, number, number],
      saturation: 0,
      lightness: 0,
    }));

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const distance = labDistance(sample.lab, centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      assignments[i] = best;
      const total = totals[best];
      total.weight += sample.weight;
      total.r += sample.r * sample.weight;
      total.g += sample.g * sample.weight;
      total.b += sample.b * sample.weight;
      total.lab[0] += sample.lab[0] * sample.weight;
      total.lab[1] += sample.lab[1] * sample.weight;
      total.lab[2] += sample.lab[2] * sample.weight;
      total.saturation += sample.saturation * sample.weight;
      total.lightness += sample.lightness * sample.weight;
    }

    for (let c = 0; c < k; c++) {
      const total = totals[c];
      if (total.weight === 0) {
        const random = samples[Math.floor(Math.random() * samples.length)].lab;
        centroids[c] = [...random];
        continue;
      }
      centroids[c] = [
        total.lab[0] / total.weight,
        total.lab[1] / total.weight,
        total.lab[2] / total.weight,
      ];
    }
  }

  const clusters: Cluster[] = Array.from({ length: k }, () => ({
    r: 0,
    g: 0,
    b: 0,
    lab: [0, 0, 0] as [number, number, number],
    saturation: 0,
    lightness: 0,
    weight: 0,
  }));

  for (let i = 0; i < samples.length; i++) {
    const idx = assignments[i];
    const sample = samples[i];
    const cluster = clusters[idx];
    cluster.weight += sample.weight;
    cluster.r += sample.r * sample.weight;
    cluster.g += sample.g * sample.weight;
    cluster.b += sample.b * sample.weight;
    cluster.lab[0] += sample.lab[0] * sample.weight;
    cluster.lab[1] += sample.lab[1] * sample.weight;
    cluster.lab[2] += sample.lab[2] * sample.weight;
    cluster.saturation += sample.saturation * sample.weight;
    cluster.lightness += sample.lightness * sample.weight;
  }

  return clusters
    .filter((cluster) => cluster.weight > 0)
    .map((cluster) => ({
      r: cluster.r / cluster.weight,
      g: cluster.g / cluster.weight,
      b: cluster.b / cluster.weight,
      lab: [
        cluster.lab[0] / cluster.weight,
        cluster.lab[1] / cluster.weight,
        cluster.lab[2] / cluster.weight,
      ] as [number, number, number],
      saturation: cluster.saturation / cluster.weight,
      lightness: cluster.lightness / cluster.weight,
      weight: cluster.weight,
    }));
}

function initializeCentroids(samples: Sample[], k: number): Array<[number, number, number]> {
  const sorted = [...samples].sort((a, b) => b.weight - a.weight);
  const centroids: Array<[number, number, number]> = [];

  if (sorted.length) {
    centroids.push(sorted[0].lab);
  }

  while (centroids.length < k && centroids.length < sorted.length) {
    let bestSample: Sample | null = null;
    let bestScore = -Infinity;
    for (const sample of sorted) {
      const minDistance = centroids.reduce((min, centroid) => Math.min(min, labDistance(sample.lab, centroid)), Infinity);
      const score = minDistance * sample.weight * (0.6 + sample.saturation) * (0.6 + (1 - Math.abs(sample.lightness - 0.5)));
      if (score > bestScore) {
        bestScore = score;
        bestSample = sample;
      }
    }
    if (!bestSample) break;
    centroids.push(bestSample.lab);
  }

  while (centroids.length < k) {
    const random = samples[Math.floor(Math.random() * samples.length)].lab;
    centroids.push([...random]);
  }

  return centroids;
}

function selectAccents(clusters: Cluster[], count: number): Cluster[] {
  if (!clusters.length) return [];

  const scored = clusters.map((cluster) => {
    const vibrancy = 0.5 + cluster.saturation;
    const balance = 0.6 + (1 - Math.abs(cluster.lightness - 0.5));
    const score = cluster.weight * vibrancy * balance;
    return { cluster, score };
  }).sort((a, b) => b.score - a.score);

  const chosen: Cluster[] = [];
  const minDistanceSq = MIN_CLUSTER_DISTANCE * MIN_CLUSTER_DISTANCE;

  for (const { cluster } of scored) {
    if (chosen.length >= count) break;
    const farEnough = chosen.every((other) => labDistanceSq(cluster.lab, other.lab) > minDistanceSq);
    if (farEnough) {
      chosen.push(cluster);
    }
  }

  if (chosen.length < count) {
    for (const { cluster } of scored) {
      if (chosen.length >= count) break;
      const duplicate = chosen.some((other) => labDistanceSq(cluster.lab, other.lab) < (MIN_CLUSTER_DISTANCE / 2) ** 2);
      if (!duplicate) {
        chosen.push(cluster);
      }
    }
  }

  while (chosen.length < count) {
    const candidate = scored[chosen.length % scored.length].cluster;
    chosen.push(candidate);
  }

  return chosen.slice(0, count);
}

function createPalette(color: RGB): AccentPalette {
  const baseHsl = rgbToHsl(color.r, color.g, color.b);
  const targetSat = clamp01(Math.max(baseHsl.s, 0.4) * 1.15 + 0.08);
  const targetLight = (() => {
    if (baseHsl.l < 0.28) return 0.6;
    if (baseHsl.l > 0.78) return 0.48;
    return clamp01(baseHsl.l * 0.62 + 0.2);
  })();
  const accentRgb = roundColor(hslToRgb(baseHsl.h, targetSat, targetLight));
  const hover = adjustLightness(accentRgb, 0.12);
  const active = adjustLightness(accentRgb, -0.14);
  const soft = rgba(accentRgb, 0.24);
  const border = rgba(accentRgb, 0.46);
  const borderActive = rgba(accentRgb, 0.72);
  const ring = rgba(accentRgb, 0.34);
  const lum = relativeLuminance(accentRgb);
  const on = lum > 0.62 ? "#061428" : "#f5f9ff";
  const glow = `0 20px 36px ${rgba(accentRgb, 0.3)}`;
  const shadow = `0 14px 30px ${rgba(accentRgb, 0.32)}`;
  const shadowActive = `0 20px 40px ${rgba(accentRgb, 0.44)}`;

  return {
    fill: rgbToHex(accentRgb),
    hover,
    active,
    soft,
    border,
    borderActive,
    ring,
    on,
    glow,
    shadow,
    shadowActive,
  };
}

function adjustLightness(color: RGB, delta: number): string {
  const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
  const adjusted = hslToRgb(h, clamp01(s * 1.05), clamp01(l + delta));
  return rgbToHex(adjusted);
}

function rgba(color: RGB, alpha: number): string {
  const c = roundColor(color);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${clamp01(alpha).toFixed(2)})`;
}

function roundColor(color: RGB): RGB {
  return {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
  };
}

function labDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt(labDistanceSq(a, b));
}

function labDistanceSq(a: [number, number, number], b: [number, number, number]): number {
  const dL = a[0] - b[0];
  const dA = a[1] - b[1];
  const dB = a[2] - b[2];
  return dL * dL + dA * dA + dB * dB;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rgbToHex({ r, g, b }: RGB): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

function channelToHex(value: number): string {
  const v = clampChannel(value);
  const hex = v.toString(16).padStart(2, "0");
  return hex;
}

function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  let r: number;
  let g: number;
  let b: number;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: r * 255,
    g: g * 255,
    b: b * 255,
  };
}

function relativeLuminance(color: RGB): number {
  const transform = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = transform(color.r);
  const g = transform(color.g);
  const b = transform(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let sr = r / 255;
  let sg = g / 255;
  let sb = b / 255;

  sr = sr <= 0.04045 ? sr / 12.92 : Math.pow((sr + 0.055) / 1.055, 2.4);
  sg = sg <= 0.04045 ? sg / 12.92 : Math.pow((sg + 0.055) / 1.055, 2.4);
  sb = sb <= 0.04045 ? sb / 12.92 : Math.pow((sb + 0.055) / 1.055, 2.4);

  const x = sr * 0.4124 + sg * 0.3576 + sb * 0.1805;
  const y = sr * 0.2126 + sg * 0.7152 + sb * 0.0722;
  const z = sr * 0.0193 + sg * 0.1192 + sb * 0.9505;

  return xyzToLab(x, y, z);
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const Xn = 0.95047;
  const Yn = 1.0;
  const Zn = 1.08883;

  const fx = labF(x / Xn);
  const fy = labF(y / Yn);
  const fz = labF(z / Zn);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labF(t: number): number {
  const delta = 6 / 29;
  if (t > delta ** 3) return Math.cbrt(t);
  return t / (3 * delta * delta) + 4 / 29;
}
