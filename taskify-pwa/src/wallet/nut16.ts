import {
  getDecodedToken,
  getDecodedTokenBinary,
  getEncodedToken,
  getTokenMetadata,
} from "@cashu/cashu-ts";
import { Buffer } from "buffer";
import { UR, UREncoder, URDecoder } from "@gandlaf21/bc-ur";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE64_PAD = "=";
const DEFAULT_CHUNK_SIZE = 200; // max fragment length passed to UR encoder (bc-ur default)
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
function isUrString(value: string): boolean {
  return /^ur:/i.test(value?.trim?.() ?? "");
}

function parseUrSequence(value: string): { index: number; total: number } | null {
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (parts.length < 2) return null;
  const seq = parts[1];
  const match = /^(\d+)(?:-|of)(\d+)$/i.exec(seq);
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(index) || !Number.isFinite(total)) return null;
  return { index, total };
}

function extractUrType(value: string): string | null {
  if (!isUrString(value)) return null;
  const match = value.trim().match(/^ur:([^/]+)\//i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractUrDigest(value: string): string | null {
  if (!isUrString(value)) return null;
  const parts = value.split("/");
  if (!parts.length) return null;
  const sequencePattern = /^\d+(?:-\d+|of\d+)$/i;
  // Ignore explicit sequence markers (e.g., "1-10") to avoid changing keys per frame.
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (sequencePattern.test(part)) continue;
    return part;
  }
  // Fallback to UR type to keep a stable key for multi-part animations.
  return extractUrType(value);
}

function deriveUrKey(value: string, providedDigest?: string | null): string {
  const digest = providedDigest && !/^\d+(?:-\d+|of\d+)$/i.test(providedDigest) ? providedDigest : null;
  if (digest) return digest;
  const type = extractUrType(value);
  if (type) return type;
  return digestFromBytes(new TextEncoder().encode(value));
}

function canonicalizeUrFragment(value: string): string {
  if (!isUrString(value)) return value.trim();
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (parts.length <= 2) return trimmed;
  // Drop type and sequence so repeats with different sequence numbers dedupe.
  const payload = parts.slice(2).join("/");
  return payload || trimmed;
}

function digestFromBytes(bytes: Uint8Array): string {
  const hash = sha256(bytes);
  return toBase64Url(hash as Uint8Array).slice(0, 16);
}

function isValidToken(token: string): boolean {
  try {
    getTokenMetadata(token);
    return true;
  } catch {
    // fall back to a full decode for legacy tokens with full keyset ids
  }
  try {
    return !!getDecodedToken(token, []);
  } catch {
    return false;
  }
}

function ensureTokenString(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Missing token value");
  }
  if (!isValidToken(trimmed)) {
    throw new Error("Invalid Cashu token");
  }
  return trimmed;
}

function decodeTokenFromBytes(bytes: Uint8Array): string {
  // Prefer text tokens (UR "bytes" carrying the encoded token string)
  try {
    const text = new TextDecoder().decode(bytes).trim();
    if (text && isValidToken(text)) return text;
  } catch {
    // Fallback to binary encoding path
  }
  const token = getDecodedTokenBinary(bytes);
  const encoded = getEncodedToken(token);
  if (!encoded) {
    throw new Error("Failed to re-encode animated token");
  }
  return encoded;
}

export function createNut16Animation(
  token: string,
  opts?: { chunkSize?: number; intervalMs?: number },
): Nut16Animation | null {
  try {
    const canonical = ensureTokenString(token);
    const payloadBytes = new TextEncoder().encode(canonical);
    const digest = digestFromBytes(payloadBytes);
    const fragmentLength = Math.max(30, opts?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    try {
      const ur = UR.fromBuffer(Buffer.from(payloadBytes));
      const encoder = new UREncoder(ur, fragmentLength, 0);
      const frames: Nut16Frame[] = [];
      const seen = new Set<string>();
      const target = encoder.fragmentsLength ?? 0;
      const maxFrames = target > 0 ? target : 100;
      let guard = Math.max(maxFrames * 3, 200);
      while (frames.length < maxFrames && guard > 0) {
        guard -= 1;
        const part = encoder.nextPart();
        const fragmentId = canonicalizeUrFragment(part);
        if (seen.has(fragmentId)) {
          continue;
        }
        seen.add(fragmentId);
        frames.push({
          version: NUT16_VERSION,
          index: frames.length + 1,
          total: target,
          digest,
          chunk: part,
          value: part,
        });
        if (target > 0 && seen.size >= target) break;
      }
      if (frames.length > 1) {
        return {
          frames,
          totalBytes: payloadBytes.length,
          digest,
          version: NUT16_VERSION,
          intervalMs: opts?.intervalMs ?? DEFAULT_INTERVAL_MS,
        };
      }
    } catch (error) {
      console.warn("Unable to init UR encoder, falling back to legacy chunks", error);
    }

    const base64 = toBase64Url(payloadBytes);
    const chunkSize = Math.max(1, opts?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    if (base64.length <= chunkSize) {
      return null;
    }
    const total = Math.ceil(base64.length / chunkSize);
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
      totalBytes: payloadBytes.length,
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
  if (isUrString(trimmed)) {
    const digest = deriveUrKey(trimmed);
    const seq = parseUrSequence(trimmed);
    const index = seq?.index ?? 1;
    const total = seq?.total ?? 0;
    return {
      version: NUT16_VERSION,
      index,
      total,
      digest,
      chunk: trimmed,
      value: trimmed,
    };
  }
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
  const urFrames = frames.filter((f) => isUrString(f.value));
  if (urFrames.length) {
    const decoder = new URDecoder();
    for (const frame of urFrames) {
      decoder.receivePart(frame.value.trim());
    }
    if (!decoder.isSuccess()) {
      throw new Error("Animated Cashu token incomplete");
    }
    const ur = decoder.resultUR();
    const bytes = new Uint8Array(ur.decodeCBOR());
    if (!bytes.length) {
      throw new Error("Animated Cashu token payload empty");
    }
    return decodeTokenFromBytes(bytes);
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
  return decodeTokenFromBytes(bytes);
}

export function findNut16FrameStrings(text: string): string[] {
  if (!text) return [];
  const matches = text.match(FRAME_GLOBAL_PATTERN) ?? [];
  const urMatches = text.match(/ur:[a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/gi) ?? [];
  return [...matches, ...urMatches].map((m) => m.trim()).filter(Boolean);
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
    // For UR frames, use index as insertion order
    const bucketIndex = frame.index || bucket.size + 1;
    if (!bucket.has(bucketIndex)) {
      bucket.set(bucketIndex, frame);
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
  if (expectedTotal > 0 && frames.length !== expectedTotal) {
    const missing = expectedTotal - frames.length;
    throw new Error(`Animated Cashu token incomplete. ${missing} frame${missing === 1 ? "" : "s"} missing.`);
  }
  const token = combineNut16Frames(frames);
  return { token, frames };
}

export function containsNut16Frame(text: string): boolean {
  if (!text) return false;
  if (isUrString(text.trim())) return true;
  if (FRAME_PATTERN.test(text.trim())) return true;
  FRAME_GLOBAL_PATTERN.lastIndex = 0;
  return FRAME_GLOBAL_PATTERN.test(text);
}

export class Nut16Collector {
  private readonly sets = new Map<string, FrameSet>();
  private urSet: { key: string; decoder: URDecoder; fragments: Set<string>; lastUpdated: number } | null = null;
  private readonly expiryMs: number;

  constructor(opts?: { expiryMs?: number }) {
    this.expiryMs = opts?.expiryMs ?? 2 * 60 * 1000;
  }

  reset(): void {
    this.sets.clear();
    this.urSet = null;
  }

  addFrame(frame: Nut16Frame): Nut16CollectorResult {
    this.cleanup();
    if (isUrString(frame.value)) {
      const key = this.urSet?.key ?? deriveUrKey(frame.value, frame.digest || extractUrDigest(frame.value));
      let state = this.urSet;
      if (!state || state.key !== key) {
        state = { key, decoder: new URDecoder(), fragments: new Set<string>(), lastUpdated: Date.now() };
        this.urSet = state;
      }
      const fragmentId = canonicalizeUrFragment(frame.value);
      const hadFragment = state.fragments.has(fragmentId);
      state.fragments.add(fragmentId);
      state.decoder.receivePart(frame.value);
      state.lastUpdated = Date.now();
      const received = state.fragments.size;
      const total = state.decoder.expectedPartCount?.() ?? frame.total ?? 0;
      const missing = total ? Math.max(total - received, 0) : 0;
      if (state.decoder.isSuccess()) {
        try {
          const ur = state.decoder.resultUR();
          const bytes = new Uint8Array(ur.decodeCBOR());
          const encoded = decodeTokenFromBytes(bytes);
          this.urSet = null;
          return { status: "complete", frame, token: encoded, key };
        } catch (error) {
          this.urSet = null;
          return { status: "error", frame, error: error instanceof Error ? error : new Error(String(error)), key };
        }
      }
      return {
        status: hadFragment ? "duplicate" : "stored",
        frame,
        received,
        total,
        missing,
        key,
      };
    }

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
    if (!this.sets.size && !this.urSet) return;
    const threshold = Date.now() - this.expiryMs;
    for (const [key, state] of this.sets.entries()) {
      if (state.lastUpdated < threshold) {
        this.sets.delete(key);
      }
    }
    if (this.urSet && this.urSet.lastUpdated < threshold) {
      this.urSet = null;
    }
  }
}
