import {
  getDecodedToken,
  getDecodedTokenBinary,
  getEncodedToken,
  getEncodedTokenBinary,
  type Token,
} from "@cashu/cashu-ts";

const BASE64_PAD = "=";
const DEFAULT_CHUNK_SIZE = 780; // tuned for QR capacity at high error correction
const DEFAULT_INTERVAL_MS = 450;
const NUT16_VERSION = 1;
const FRAME_PATTERN = /^cashuA:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{6,}):([A-Za-z0-9_-]+)$/;
const FRAME_GLOBAL_PATTERN = /cashuA:\d+:\d+:\d+:[A-Za-z0-9_-]{6,}:[A-Za-z0-9_-]+/g;

export type Nut16Frame = {
  version: number;
  index: number;
  total: number;
  digest: string;
  chunk: string;
  value: string;
};

export type Nut16Animation = {
  frames: Nut16Frame[];
  totalBytes: number;
  digest: string;
  version: number;
  intervalMs: number;
};

export type Nut16CollectorResult =
  | {
      status: "stored" | "duplicate";
      frame: Nut16Frame;
      received: number;
      total: number;
      missing: number;
      key: string;
    }
  | {
      status: "complete";
      frame: Nut16Frame;
      token: string;
      key: string;
    }
  | {
      status: "error";
      frame: Nut16Frame;
      error: Error;
      key: string;
    };

type FrameSet = {
  version: number;
  digest: string;
  total: number;
  chunks: Map<number, string>;
  lastUpdated: number;
};

function getGlobalScope(): typeof globalThis {
  return globalThis;
}

function encodeBase64(bytes: Uint8Array): string {
  const g = getGlobalScope() as typeof globalThis & { Buffer?: any };
  if (typeof g.btoa === "function") {
    let binary = "";
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return g.btoa(binary);
  }
  if (g.Buffer) {
    return g.Buffer.from(bytes).toString("base64");
  }
  throw new Error("Base64 encoder unavailable in this environment");
}

function decodeBase64(value: string): Uint8Array {
  const g = getGlobalScope() as typeof globalThis & { Buffer?: any };
  if (typeof g.atob === "function") {
    const padded = value;
    const binary = g.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (g.Buffer) {
    const buf = g.Buffer.from(value, "base64");
    return buf instanceof Uint8Array ? new Uint8Array(buf) : Uint8Array.from(buf as number[]);
  }
  throw new Error("Base64 decoder unavailable in this environment");
}

function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (base64.length % 4)) % 4;
  if (padLength) {
    base64 = base64 + BASE64_PAD.repeat(padLength);
  }
  return decodeBase64(base64);
}

function buildFrameValue(frame: Nut16Frame): string {
  return `cashuA:${frame.version}:${frame.index}:${frame.total}:${frame.digest}:${frame.chunk}`;
}

function ensureToken(token: string): Token {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Missing token value");
  }
  return getDecodedToken(trimmed);
}

export function createNut16Animation(
  token: string,
  opts?: { chunkSize?: number; intervalMs?: number },
): Nut16Animation | null {
  try {
    const decoded = ensureToken(token);
    const binary = getEncodedTokenBinary(decoded);
    const base64 = toBase64Url(binary);
    const chunkSize = Math.max(1, opts?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    if (base64.length <= chunkSize) {
      return null;
    }
    const total = Math.ceil(base64.length / chunkSize);
    const digest = base64.slice(0, 16);
    const frames: Nut16Frame[] = [];
    for (let index = 0; index < total; index++) {
      const chunk = base64.slice(index * chunkSize, (index + 1) * chunkSize);
      const frame: Nut16Frame = {
        version: NUT16_VERSION,
        index: index + 1,
        total,
        digest,
        chunk,
        value: "",
      };
      frame.value = buildFrameValue(frame);
      frames.push(frame);
    }
    return {
      frames,
      totalBytes: binary.length,
      digest,
      version: NUT16_VERSION,
      intervalMs: opts?.intervalMs ?? DEFAULT_INTERVAL_MS,
    };
  } catch (error) {
    console.warn("createNut16Animation failed", error);
    return null;
  }
}

export function parseNut16FrameString(value: string): Nut16Frame | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = FRAME_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, versionStr, indexStr, totalStr, digest, chunk] = match;
  const version = Number(versionStr);
  const index = Number(indexStr);
  const total = Number(totalStr);
  if (!Number.isFinite(version) || !Number.isFinite(index) || !Number.isFinite(total)) return null;
  if (version <= 0 || index <= 0 || total <= 0) return null;
  if (index > total) return null;
  if (!chunk) return null;
  return {
    version,
    index,
    total,
    digest,
    chunk,
    value: trimmed,
  };
}

export function combineNut16Frames(frames: Nut16Frame[]): string {
  if (!frames.length) {
    throw new Error("No frames provided");
  }
  const [first] = frames;
  const total = first.total;
  const sorted = [...frames].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    const frame = sorted[i];
    if (frame.version !== first.version || frame.digest !== first.digest || frame.total !== first.total) {
      throw new Error("Animated token frames mismatch");
    }
    if (frame.index !== i + 1) {
      throw new Error("Animated token missing frames");
    }
  }
  if (sorted.length !== total) {
    throw new Error("Animated token incomplete");
  }
  const payload = sorted.map((f) => f.chunk).join("");
  const bytes = fromBase64Url(payload);
  if (!bytes.length) {
    throw new Error("Animated token payload empty");
  }
  const token = getDecodedTokenBinary(bytes);
  const encoded = getEncodedToken(token, { version: 4 });
  if (!encoded) {
    throw new Error("Failed to re-encode animated token");
  }
  return encoded;
}

export function findNut16FrameStrings(text: string): string[] {
  if (!text) return [];
  const matches = text.match(FRAME_GLOBAL_PATTERN);
  return matches ? matches.map((m) => m.trim()).filter(Boolean) : [];
}

export function assembleNut16FromText(text: string): { token: string; frames: Nut16Frame[] } {
  const matches = findNut16FrameStrings(text);
  if (!matches.length) {
    throw new Error("No animated Cashu frames detected");
  }
  const grouped = new Map<string, Map<number, Nut16Frame>>();
  for (const match of matches) {
    const frame = parseNut16FrameString(match);
    if (!frame) continue;
    const key = `${frame.version}:${frame.digest}`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = new Map();
      grouped.set(key, bucket);
    }
    if (!bucket.has(frame.index)) {
      bucket.set(frame.index, frame);
    }
  }
  if (!grouped.size) {
    throw new Error("No animated Cashu frames detected");
  }
  if (grouped.size > 1) {
    throw new Error("Multiple animated Cashu tokens detected. Provide frames for one token at a time.");
  }
  const [, framesMap] = [...grouped.entries()][0];
  const frames = [...framesMap.values()].sort((a, b) => a.index - b.index);
  if (!frames.length) {
    throw new Error("Animated Cashu token is empty");
  }
  const expectedTotal = frames[0].total;
  if (frames.length !== expectedTotal) {
    const missing = expectedTotal - frames.length;
    throw new Error(`Animated Cashu token incomplete. ${missing} frame${missing === 1 ? "" : "s"} missing.`);
  }
  const token = combineNut16Frames(frames);
  return { token, frames };
}

export function containsNut16Frame(text: string): boolean {
  if (!text) return false;
  if (FRAME_PATTERN.test(text.trim())) return true;
  FRAME_GLOBAL_PATTERN.lastIndex = 0;
  return FRAME_GLOBAL_PATTERN.test(text);
}

export class Nut16Collector {
  private readonly sets = new Map<string, FrameSet>();
  private readonly expiryMs: number;

  constructor(opts?: { expiryMs?: number }) {
    this.expiryMs = opts?.expiryMs ?? 2 * 60 * 1000;
  }

  reset(): void {
    this.sets.clear();
  }

  addFrame(frame: Nut16Frame): Nut16CollectorResult {
    this.cleanup();
    const key = `${frame.version}:${frame.digest}`;
    let state = this.sets.get(key);
    if (!state || state.version !== frame.version || state.total !== frame.total) {
      state = {
        version: frame.version,
        digest: frame.digest,
        total: frame.total,
        chunks: new Map(),
        lastUpdated: Date.now(),
      };
      this.sets.set(key, state);
    }
    const alreadyHad = state.chunks.has(frame.index);
    state.chunks.set(frame.index, frame.chunk);
    state.lastUpdated = Date.now();

    if (state.chunks.size === state.total) {
      const frames = [...state.chunks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, chunk]) => ({ ...frame, index, chunk, value: buildFrameValue({ ...frame, index, chunk }) }));
      try {
        const token = combineNut16Frames(frames);
        this.sets.delete(key);
        return { status: "complete", frame, token, key };
      } catch (error) {
        this.sets.delete(key);
        return { status: "error", frame, error: error instanceof Error ? error : new Error(String(error)), key };
      }
    }

    const received = state.chunks.size;
    const missing = Math.max(state.total - received, 0);
    return {
      status: alreadyHad ? "duplicate" : "stored",
      frame,
      received,
      total: state.total,
      missing,
      key,
    };
  }

  private cleanup(): void {
    if (!this.sets.size) return;
    const threshold = Date.now() - this.expiryMs;
    for (const [key, state] of this.sets.entries()) {
      if (state.lastUpdated < threshold) {
        this.sets.delete(key);
      }
    }
  }
}
