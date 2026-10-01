/* eslint-disable no-console */
// Shared worker types, helpers, and constants — extracted from index.ts
// (Item #12 worker module split, pass 5).
//
// Handler modules (preview, reminders, voice, nip05) import
// from here instead of "./index.ts", which removes the circular-import
// pattern that grew during passes 1-4.

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare binding shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  error?: string;
}

export interface D1PreparedStatement<T = unknown> {
  bind(...values: unknown[]): D1PreparedStatement<T>;
  first<U = T>(): Promise<U | null>;
  all<U = T>(): Promise<D1Result<U>>;
  run<U = T>(): Promise<D1Result<U>>;
}

export interface D1Database {
  prepare<T = unknown>(query: string): D1PreparedStatement<T>;
  batch<T = unknown>(statements: D1PreparedStatement<T>[]): Promise<D1Result<T>[]>;
}

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: AssetFetcher;
  TASKIFY_DB: D1Database;
  TASKIFY_DEVICES?: KVNamespace;
  TASKIFY_REMINDERS?: KVNamespace;
  TASKIFY_PENDING?: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string | KVNamespace;
  VAPID_SUBJECT: string;
  // Workers AI credentials for the voice routes.
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  VOICE_DISABLED?: string;
  VOICE_RATE_LIMITER?: RateLimitBinding;
  PREVIEW_RATE_LIMITER?: RateLimitBinding;
  NIP05_RATE_LIMITER?: RateLimitBinding;
  WATCH_NOSTR_RATE_LIMITER?: RateLimitBinding;
  PUSH_RATE_LIMITER?: RateLimitBinding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────────────────────

// No Access-Control-Allow-Origin: the PWA calls this origin (`/api/config` hands it its own
// origin), and the native apps and CLI are not browsers. Without it, other websites cannot
// read these responses, so they cannot use the preview and NIP-05 routes as their own.
export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export const MINUTE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Response + DB helpers
// ─────────────────────────────────────────────────────────────────────────────

export function requireDb(env: Env): D1Database {
  if (!env.TASKIFY_DB) {
    throw new Error("TASKIFY_DB binding is not configured");
  }
  return env.TASKIFY_DB;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function parseJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Reads a request body, giving up (null) as soon as it passes `maxBytes`. */
export async function readBodyWithin(request: Request | Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parses a JSON body of at most `maxBytes`: 413 when larger, `body: null` when not JSON. */
export async function parseJsonWithin(request: Request, maxBytes: number): Promise<{ body: any } | Response> {
  const bytes = await readBodyWithin(request, maxBytes);
  if (!bytes) return jsonResponse({ error: "Request body too large" }, 413);
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { body: null };
  }
}

/** A copy of `request` whose body is at most `maxBytes`, for handlers that hash the exact bytes. */
export async function withBodyWithin(request: Request, maxBytes: number): Promise<Request | Response> {
  const bytes = await readBodyWithin(request, maxBytes);
  if (!bytes) return jsonResponse({ error: "Request body too large" }, 413);
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}

/**
 * The part of a caller's address that rate limits key on. One IPv6 subscriber usually holds a
 * whole /64, so IPv6 callers are grouped by it; IPv4 addresses are used as they are.
 */
export function rateLimitAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.includes(":") || trimmed.includes(".")) return trimmed;
  const [head, tail] = trimmed.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = trimmed.includes("::")
    ? [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    : headGroups;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return trimmed;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function enforceRateLimit(
  request: Request,
  binding: RateLimitBinding | undefined,
  scope: string,
): Promise<Response | null> {
  if (!binding) return null;
  const clientAddress = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || "unknown";
  const result = await binding.limit({ key: `${scope}:${rateLimitAddress(clientAddress)}` });
  if (result.success) return null;
  const response = jsonResponse({ error: "Too many requests" }, 429);
  response.headers.set("Retry-After", "60");
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64url codec (shared with VAPID JWT and preview handling)
// ─────────────────────────────────────────────────────────────────────────────

export function base64UrlEncode(buffer: Uint8Array): string {
  let string = "";
  buffer.forEach((byte) => {
    string += String.fromCharCode(byte);
  });
  return btoa(string).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.length % 4 === 0 ? normalized : `${normalized}${"=".repeat(4 - (normalized.length % 4))}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
