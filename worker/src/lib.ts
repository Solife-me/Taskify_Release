/* eslint-disable no-console */
// Shared worker types, helpers, and constants — extracted from index.ts
// (Item #12 worker module split, pass 5).
//
// Handler modules (gcal, preview, reminders, voice, nip05) import
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

export interface Env {
  ASSETS: AssetFetcher;
  TASKIFY_DB: D1Database;
  TASKIFY_DEVICES?: KVNamespace;
  TASKIFY_REMINDERS?: KVNamespace;
  TASKIFY_PENDING?: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string | KVNamespace;
  VAPID_SUBJECT: string;
  GEMINI_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GCAL_CLIENT_ID: string;
  GCAL_CLIENT_SECRET: string;
  GCAL_TOKEN_ENC_KEY: string;
  GCAL_TOKEN_ENC_KEY_PREV?: string;
  GCAL_WEBHOOK_SECRET: string;
  GCAL_KEY_VERSION?: string;  // current key version number as string, default "1"
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────────────────────

export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
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

// ─────────────────────────────────────────────────────────────────────────────
// Base64url codec (shared with VAPID JWT + GCal token crypto + preview proxy)
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
