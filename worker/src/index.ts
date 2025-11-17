/* eslint-disable no-console */
import { getPreviewFromContent } from "link-preview-js";
interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ListResult {
  objects: { key: string }[];
  truncated?: boolean;
  cursor?: string | null;
}

interface R2Bucket {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
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
  TASKIFY_BACKUPS?: R2Bucket;
}

type PushPlatform = "ios" | "android";

type SubscriptionRecord = {
  endpoint: string;
  keys: { auth: string; p256dh: string };
};

type DeviceRecord = {
  deviceId: string;
  platform: PushPlatform;
  subscription: SubscriptionRecord;
  endpointHash: string;
};

type ReminderTaskInput = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutesBefore: number[];
};

type ReminderEntry = {
  reminderKey: string;
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
  sendAt: number;
};

type PendingReminder = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
};

type DeviceRow = {
  device_id: string;
  platform: PushPlatform;
  endpoint: string;
  endpoint_hash: string;
  subscription_auth: string;
  subscription_p256dh: string;
  updated_at: number;
};

type ReminderRow = {
  device_id: string;
  reminder_key: string;
  task_id: string;
  board_id: string | null;
  title: string;
  due_iso: string;
  minutes: number;
  send_at: number;
};

type PendingRow = {
  id: number;
  device_id: string;
  task_id: string;
  board_id: string | null;
  title: string;
  due_iso: string;
  minutes: number;
  created_at: number;
};

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  error?: string;
}

interface D1PreparedStatement<T = unknown> {
  bind(...values: unknown[]): D1PreparedStatement<T>;
  first<U = T>(): Promise<U | null>;
  all<U = T>(): Promise<D1Result<U>>;
  run<U = T>(): Promise<D1Result<U>>;
}

interface D1Database {
  prepare<T = unknown>(query: string): D1PreparedStatement<T>;
  batch<T = unknown>(statements: D1PreparedStatement<T>[]): Promise<D1Result<T>[]>;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MINUTE_MS = 60_000;
const MAX_LEAD_MS = 30 * 24 * 60 * MINUTE_MS; // 30 days
const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_MAX_BYTES = 600_000;
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://www.google.com/";
const THREE_MONTHS_MS = 90 * 24 * 60 * MINUTE_MS;
const ONE_WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const BACKUP_CLEANUP_STATE_KEY = "backups-cleanup-state.json";

let cachedPrivateKey: CryptoKey | null = null;
const PRIVATE_KEY_KV_KEYS = ["VAPID_PRIVATE_KEY", "private-key", "key"] as const;
let schemaReadyPromise: Promise<void> | null = null;

function requireDb(env: Env): D1Database {
  if (!env.TASKIFY_DB) {
    throw new Error("TASKIFY_DB binding is not configured");
  }
  return env.TASKIFY_DB;
}

async function ensureSchema(env: Env): Promise<void> {
  if (schemaReadyPromise) {
    return schemaReadyPromise;
  }
  const db = requireDb(env);
  const ready = (async () => {
    try {
      await db.prepare(`PRAGMA foreign_keys = ON`).run();
    } catch {
      // ignore; some environments may not support PRAGMA
    }

    await db.prepare(
      `CREATE TABLE IF NOT EXISTS devices (
         device_id TEXT PRIMARY KEY,
         platform TEXT NOT NULL,
         endpoint TEXT NOT NULL,
         endpoint_hash TEXT NOT NULL UNIQUE,
         subscription_auth TEXT NOT NULL,
         subscription_p256dh TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    ).run();

    await db.prepare(
      `CREATE TABLE IF NOT EXISTS reminders (
         device_id TEXT NOT NULL,
         reminder_key TEXT NOT NULL,
         task_id TEXT NOT NULL,
         board_id TEXT,
         title TEXT NOT NULL,
         due_iso TEXT NOT NULL,
         minutes INTEGER NOT NULL,
         send_at INTEGER NOT NULL,
         PRIMARY KEY (device_id, reminder_key),
         FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
       )`,
    ).run();

    await db.prepare(
      `CREATE TABLE IF NOT EXISTS pending_notifications (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         device_id TEXT NOT NULL,
         task_id TEXT NOT NULL,
         board_id TEXT,
         title TEXT NOT NULL,
         due_iso TEXT NOT NULL,
         minutes INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
       )`,
    ).run();

    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_reminders_send_at ON reminders(send_at)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_device ON pending_notifications(device_id)`).run();
  })()
    .catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });

  schemaReadyPromise = ready;
  return ready;
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface SchedulerController {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    await ensureSchema(env);

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        return jsonResponse({
          workerBaseUrl: url.origin,
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
        });
      }
      if (url.pathname === "/api/preview" && request.method === "GET") {
        return await handlePreviewProxy(url);
      }
      if (url.pathname === "/api/devices" && request.method === "PUT") {
        return await handleRegisterDevice(request, env);
      }
      if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
        const deviceId = decodeURIComponent(url.pathname.substring("/api/devices/".length));
        return await handleDeleteDevice(deviceId, env);
      }
      if (url.pathname === "/api/reminders" && request.method === "PUT") {
        return await handleSaveReminders(request, env);
      }
      if (url.pathname === "/api/reminders/poll" && request.method === "POST") {
        return await handlePollReminders(request, env);
      }
      if (url.pathname === "/api/backups" && request.method === "PUT") {
        return await handleSaveBackup(request, env);
      }
      if (url.pathname === "/api/backups" && request.method === "GET") {
        return await handleLoadBackup(url, env);
      }
    } catch (err) {
      console.error("Worker error", err);
      return jsonResponse({ error: (err as Error).message || "Internal error" }, 500);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: SchedulerController): Promise<void> {
    const runner = async () => {
      try {
        await ensureSchema(env);
        await processDueReminders(env);
        await cleanupExpiredBackups(env);
      } catch (err) {
        console.error('Scheduled task failed', { cron: event?.cron, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(runner());
    } else if (event && typeof (event as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil === 'function') {
      (event as unknown as { waitUntil: (promise: Promise<unknown>) => void }).waitUntil(runner());
    } else {
      await runner();
    }
  },
};

function getBackupObjectKey(npubRaw: string | null): string | null {
  if (!npubRaw) return null;
  const trimmed = npubRaw.trim().toLowerCase();
  if (!trimmed.startsWith("npub")) return null;
  if (!/^[0-9a-z]+$/.test(trimmed)) return null;
  return `backups/taskify-backup-${trimmed}.json`;
}

async function handleSaveBackup(request: Request, env: Env): Promise<Response> {
  if (!env.TASKIFY_BACKUPS) {
    return jsonResponse({ error: "Cloud backups are not configured" }, 501);
  }
  const body = await parseJson(request);
  const { npub, ciphertext, iv, version, createdAt } = body || {};
  const objectKey = getBackupObjectKey(typeof npub === "string" ? npub : null);
  if (!objectKey) {
    return jsonResponse({ error: "Invalid npub" }, 400);
  }
  if (typeof ciphertext !== "string" || !ciphertext) {
    return jsonResponse({ error: "ciphertext is required" }, 400);
  }
  if (typeof iv !== "string" || !iv) {
    return jsonResponse({ error: "iv is required" }, 400);
  }
  const nowIso = new Date().toISOString();
  const payload = {
    version: typeof version === "number" ? version : 1,
    createdAt: typeof createdAt === "string" && createdAt ? createdAt : nowIso,
    updatedAt: nowIso,
    lastReadAt: nowIso,
    ciphertext,
    iv,
  };
  await env.TASKIFY_BACKUPS.put(objectKey, JSON.stringify(payload), {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "private, max-age=0, must-revalidate",
    },
  });
  return jsonResponse({ ok: true });
}

async function handleLoadBackup(url: URL, env: Env): Promise<Response> {
  if (!env.TASKIFY_BACKUPS) {
    return jsonResponse({ error: "Cloud backups are not configured" }, 501);
  }
  const objectKey = getBackupObjectKey(url.searchParams.get("npub"));
  if (!objectKey) {
    return jsonResponse({ error: "Invalid npub" }, 400);
  }
  const stored = await env.TASKIFY_BACKUPS.get(objectKey);
  if (!stored) {
    return jsonResponse({ error: "Backup not found" }, 404);
  }
  let text: string;
  try {
    text = await stored.text();
  } catch {
    return jsonResponse({ error: "Failed to read backup" }, 500);
  }
  if (!text) {
    return jsonResponse({ error: "Backup not found" }, 404);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Backup data is corrupted" }, 500);
  }
  if (!parsed || typeof parsed !== "object") {
    return jsonResponse({ error: "Backup data is corrupted" }, 500);
  }
  const payload = parsed as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const storedPayload = { ...payload, lastReadAt: nowIso };
  try {
    await env.TASKIFY_BACKUPS.put(objectKey, JSON.stringify(storedPayload), {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    console.error("Failed to update backup metadata", {
      error: err instanceof Error ? err.message : String(err),
      key: objectKey,
    });
  }
  const { lastReadAt: _lastReadAt, ...responsePayload } = storedPayload;
  return jsonResponse({ backup: responsePayload });
}

async function cleanupExpiredBackups(env: Env): Promise<void> {
  if (!env.TASKIFY_BACKUPS) {
    return;
  }
  const now = Date.now();
  let lastRunAt = Number.NEGATIVE_INFINITY;

  try {
    const stateObject = await env.TASKIFY_BACKUPS.get(BACKUP_CLEANUP_STATE_KEY);
    if (stateObject) {
      const raw = await stateObject.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { lastRunAt?: string } | null;
          const candidate = parsed && typeof parsed.lastRunAt === "string" ? Date.parse(parsed.lastRunAt) : NaN;
          if (!Number.isNaN(candidate)) {
            lastRunAt = candidate;
          }
        } catch (err) {
          console.error("Failed to parse cleanup state", err);
        }
      }
    }
  } catch (err) {
    console.error("Failed to read cleanup state", err);
  }

  if (Number.isFinite(lastRunAt) && now - lastRunAt < ONE_WEEK_MS) {
    return;
  }

  let cursor: string | undefined;
  const cutoff = now - THREE_MONTHS_MS;
  let cleanupAttempted = false;

  do {
    let listResult: R2ListResult;
    try {
      listResult = await env.TASKIFY_BACKUPS.list({
        prefix: "backups/",
        limit: 1000,
        cursor,
      });
    } catch (err) {
      console.error("Failed to list backups", err);
      return;
    }
    cleanupAttempted = true;
    const objects = Array.isArray(listResult.objects) ? listResult.objects : [];
    for (const obj of objects) {
      if (!obj || typeof obj.key !== "string" || !obj.key) {
        continue;
      }
      try {
        const stored = await env.TASKIFY_BACKUPS.get(obj.key);
        if (!stored) {
          continue;
        }
        const raw = await stored.text();
        if (!raw) {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        if (!parsed || typeof parsed !== "object") {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        const payload = parsed as Record<string, unknown>;
        const timestamps = ["lastReadAt", "updatedAt", "createdAt"].map((field) => {
          const value = payload[field];
          if (typeof value === "string" && value) {
            const parsedDate = Date.parse(value);
            if (!Number.isNaN(parsedDate)) {
              return parsedDate;
            }
          }
          return Number.NEGATIVE_INFINITY;
        });
        const lastTouched = Math.max(...timestamps);
        if (!Number.isFinite(lastTouched) || lastTouched < cutoff) {
          await env.TASKIFY_BACKUPS.delete(obj.key);
        }
      } catch (err) {
        console.error("Failed to process backup for cleanup", {
          key: obj.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = listResult.truncated ? (listResult.cursor ?? undefined) : undefined;
  } while (cursor);

  if (cleanupAttempted) {
    try {
      await env.TASKIFY_BACKUPS.put(
        BACKUP_CLEANUP_STATE_KEY,
        JSON.stringify({ lastRunAt: new Date(now).toISOString() }),
        {
          httpMetadata: {
            contentType: "application/json",
            cacheControl: "private, max-age=0, must-revalidate",
          },
        },
      );
    } catch (err) {
      console.error("Failed to update cleanup state", err);
    }
  }
}

async function handleRegisterDevice(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, platform, subscription } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  if (platform !== "ios" && platform !== "android") {
    return jsonResponse({ error: "platform must be ios or android" }, 400);
  }
  if (!subscription || typeof subscription !== "object" || typeof subscription.endpoint !== "string") {
    return jsonResponse({ error: "subscription is required" }, 400);
  }
  if (!subscription.keys || typeof subscription.keys.auth !== "string" || typeof subscription.keys.p256dh !== "string") {
    return jsonResponse({ error: "subscription keys are invalid" }, 400);
  }

  const endpointHash = await hashEndpoint(subscription.endpoint);

  let resolvedDeviceId = deviceId;
  const existingById = await getDeviceRecord(env, deviceId);
  if (!existingById) {
    const existingByEndpoint = await findDeviceIdByEndpoint(env, subscription.endpoint);
    if (existingByEndpoint) {
      resolvedDeviceId = existingByEndpoint;
    }
  }

  const record: DeviceRecord = {
    deviceId: resolvedDeviceId,
    platform,
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        auth: subscription.keys.auth,
        p256dh: subscription.keys.p256dh,
      },
    },
    endpointHash,
  };
  await upsertDevice(env, record, Date.now());

  return jsonResponse({ subscriptionId: endpointHash, deviceId: resolvedDeviceId });
}


const PREVIEW_TITLE_MAX_LENGTH = 160;
const PREVIEW_DESCRIPTION_MAX_LENGTH = 260;

type PreviewRankedValue = { value: string; priority: number };

type PreviewImageCandidate = {
  url: string;
  priority: number;
  kind: "image" | "icon";
};

type PreviewPayload = {
  url: string;
  finalUrl: string;
  displayUrl: string;
  title: string;
  description?: string;
  image?: string;
  icon?: string;
  siteName?: string;
};

type JsonLdPrimitive = string | number | boolean | null;
interface JsonLdObject {
  [key: string]: JsonLdValue | undefined;
}
type JsonLdValue = JsonLdPrimitive | JsonLdObject | JsonLdValue[];

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    })
    .replace(/&#(\d+);/g, (match, num) => {
      const code = parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    });
}

function normalizeText(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const decoded = decodeHtmlEntities(raw);
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

function resolveUrl(base: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

function unwrapGoogleRedirectUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "consent.youtube.com" || host === "consent.google.com") {
      const continuation = parsed.searchParams.get("continue") || parsed.searchParams.get("continue_url");
      if (continuation) {
        return continuation;
      }
    }
    if (host.endsWith(".google.com")) {
      if (parsed.pathname === "/url" || parsed.pathname === "/imgres") {
        const candidate = parsed.searchParams.get("url") || parsed.searchParams.get("q") || parsed.searchParams.get("imgurl");
        if (candidate) {
          return candidate;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return rawUrl;
}

function buildDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    let path = parsed.pathname || "";
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    const display = path && path !== "/" ? `${host}${path}` : host;
    return display || parsed.hostname || url;
  } catch {
    return url;
  }
}

function fallbackTitleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slugCandidate = (() => {
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (!segment) continue;
        if (/^\d+$/.test(segment)) continue;
        const decoded = decodeURIComponent(segment.replace(/\+/g, " "));
        const cleaned = decoded.replace(/\.(html?|php)$/i, "");
        if (!/[a-zA-Z]/.test(cleaned)) continue;
        const words = cleaned
          .split(/[^a-zA-Z0-9]+/g)
          .filter(Boolean)
          .map((word) => word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : "")
          .filter(Boolean);
        if (words.length >= 2 || (words.length === 1 && words[0].length >= 4)) {
          return words.join(" ");
        }
      }
      return null;
    })();
    if (slugCandidate) {
      return slugCandidate;
    }
    const primarySegments = segments.slice(0, 2);
    const pathPart = primarySegments.length ? ` / ${primarySegments.join(" / ")}` : "";
    return (host || parsed.hostname || url) + pathPart;
  } catch {
    return url;
  }
}

function getHostLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function refinePreviewTitle(
  title: string | undefined,
  context: { siteName?: string; finalUrl?: string },
): string | undefined {
  if (!title) return undefined;
  let cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  cleaned = stripLeadingMetadataSegments(cleaned, context);
  cleaned = stripTrailingMetadataSegments(cleaned, context);
  if (context.finalUrl) {
    cleaned = stripHostFromTitle(cleaned, context.finalUrl, context.siteName);
  }
  return cleaned || undefined;
}

function stripLeadingMetadataSegments(
  title: string,
  context: { siteName?: string; finalUrl?: string },
): string {
  let current = title.trim();
  const host = getHostLabel(context.finalUrl);
  while (true) {
    const match = current.match(/^([^:\-|—·]+?)([:\-|—·]\s+)/u);
    if (!match) break;
    const segment = match[1]?.trim();
    const rawSeparator = match[2] || "";
    if (!segment) {
      current = current.slice(match[0].length).trimStart();
      continue;
    }
    if (!isMetadataSegment(segment, { siteName: context.siteName, host, separator: rawSeparator.trim() || rawSeparator })) {
      break;
    }
    current = current.slice(match[0].length).trimStart();
  }
  return current.trim();
}

function stripTrailingMetadataSegments(
  title: string,
  context: { siteName?: string; finalUrl?: string },
): string {
  let current = title.trim();
  const host = getHostLabel(context.finalUrl);
  while (true) {
    const match = current.match(/([:\-|—·]\s*)([^:\-|—·]+)$/u);
    if (!match || match.index === undefined) {
      break;
    }
    const [, rawSeparator] = match;
    const separator = rawSeparator.trim() || rawSeparator;
    const segment = match[2]?.trim();
    if (!segment) {
      current = current.slice(0, match.index).trimEnd();
      continue;
    }
    if (!isMetadataSegment(segment, { siteName: context.siteName, host, separator })) {
      break;
    }
    current = current.slice(0, match.index).trimEnd();
  }
  return current.trim();
}

function isMetadataSegment(
  segment: string,
  context: { siteName?: string; host?: string; separator: string },
): boolean {
  const lower = segment.toLowerCase();
  if (!segment) return true;
  if (context.siteName && lower === context.siteName.toLowerCase()) return true;
  if (context.host && lower === context.host.toLowerCase()) return true;
  if (lower === "everything else") return true;
  if (lower === "amazon.com" || lower === "amazon") return true;
  if (lower.startsWith("by ")) return true;
  if (/amazon/.test(lower) || /isbn/.test(lower) || /asin/.test(lower)) return true;
  if (/goodreads/.test(lower) || /barnes/.test(lower) || /target/.test(lower)) return true;
  if (lower === "books" || lower === "book") return true;
  if (/\b(?:hardcover|paperback|audiobook|ebook|kindle)\b/.test(lower)) return true;
  if (/https?:\/\//.test(lower) || /\.[a-z]{2,}$/.test(lower)) return true;
  const digitCount = (segment.match(/\d/g) || []).length;
  if (digitCount >= 6) return true;
  if (context.separator === ":" && /\b(?:author|editor)\b/.test(lower)) return true;
  if (segment.includes(",")) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length && words.length <= 6) {
      const properCase = words.filter((word) => /^[A-Z][a-z'’.-]*$/.test(word) || /^[A-Z]\.$/.test(word));
      if (properCase.length === words.length) {
        return true;
      }
    }
  }
  return false;
}

function buildBrowserHeaders(options: { referer?: string } = {}): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-CH-UA": '"Not A(Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": PREVIEW_USER_AGENT,
    Referer: options.referer || DEFAULT_REFERER,
    DNT: "1",
  };
}

async function readResponseBodyLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > PREVIEW_MAX_BYTES ? text.slice(0, PREVIEW_MAX_BYTES) : text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  const chunks: string[] = [];
  while (received < PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    const allowed =
      received > PREVIEW_MAX_BYTES ? value.subarray(0, value.length - (received - PREVIEW_MAX_BYTES)) : value;
    if (allowed.length > 0) {
      chunks.push(decoder.decode(allowed, { stream: true }));
    }
    if (received >= PREVIEW_MAX_BYTES) break;
  }
  chunks.push(decoder.decode());
  const joined = chunks.join("");
  return joined.length > PREVIEW_MAX_BYTES ? joined.slice(0, PREVIEW_MAX_BYTES) : joined;
}

function stripHostFromTitle(title: string, url: string, siteName?: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const rootHost = host.split(".").slice(-2).join(".");
    const normalizedSite = siteName ? siteName.replace(/^www\./i, "") : undefined;
    const loweredTitle = title.toLowerCase();
    const candidates = Array.from(
      new Set([host, rootHost, normalizedSite, siteName ?? ""].filter(Boolean) as string[]),
    );
    const separators = [": ", " - ", " — ", " | ", " · ", " :: "];
    for (const candidate of candidates) {
      const loweredCandidate = candidate.toLowerCase();
      for (const separator of separators) {
        if (loweredTitle.startsWith((loweredCandidate + separator).toLowerCase())) {
          const trimmed = title.slice(candidate.length + separator.length).trim();
          if (trimmed) return trimmed;
        }
        if (loweredTitle.endsWith((separator + loweredCandidate).toLowerCase())) {
          const trimmed = title.slice(0, title.length - separator.length - candidate.length).trim();
          if (trimmed) return trimmed;
        }
      }
    }
  } catch {}
  return title;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function guessFaviconUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function extractFromSrcset(srcset: string | null, baseUrl: string): string | null {
  if (!srcset) return null;
  const candidates: string[] = [];
  for (const part of srcset.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [urlPart] = trimmed.split(/\s+/);
    const absolute = resolveUrl(baseUrl, urlPart);
    if (absolute) {
      candidates.push(absolute);
    }
  }
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

function parseDynamicImageAttribute(raw: string | null, baseUrl: string): string | null {
  if (!raw) return null;
  const decoded = decodeHtmlEntities(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const ranked = Object.entries(parsed)
      .map(([url, value]) => {
        const absolute = resolveUrl(baseUrl, url);
        if (!absolute) return null;
        let score = 0;
        if (Array.isArray(value) && value.length >= 2) {
          const width = Number(value[0]);
          const height = Number(value[1]);
          if (Number.isFinite(width) && Number.isFinite(height)) {
            score = width * height;
          }
        } else if (typeof value === "number") {
          score = value;
        }
        return { url: absolute, score };
      })
      .filter((entry): entry is { url: string; score: number } => Boolean(entry?.url));
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.score - a.score);
    return ranked[0]?.url ?? null;
  } catch {
    return null;
  }
}

function looksLikeBlockedPage(html: string): boolean {
  const snippet = html.slice(0, 8192).toLowerCase();
  return (
    snippet.includes("captcha") ||
    snippet.includes("robot check") ||
    snippet.includes("service unavailable") ||
    snippet.includes("automated access") ||
    snippet.includes("enable cookies")
  );
}

function buildPreviewResponse(preview: PreviewPayload, extras?: { blocked?: boolean; fallback?: boolean }): Response {
  const body = extras ? { preview, ...extras } : { preview };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "Cache-Control": "public, max-age=300",
    },
  });
}

function buildFallbackPreview(requestedUrl: string, finalUrl: string): PreviewPayload {
  const target = finalUrl || requestedUrl;
  return {
    url: requestedUrl,
    finalUrl: target,
    displayUrl: buildDisplayUrl(target),
    title: fallbackTitleForUrl(target),
    icon: guessFaviconUrl(target),
  };
}

class PreviewCollector {
  private readonly requestedUrl: string;
  private readonly finalUrl: string;
  private titles: PreviewRankedValue[] = [];
  private descriptions: PreviewRankedValue[] = [];
  private siteNames: PreviewRankedValue[] = [];
  private images: PreviewImageCandidate[] = [];
  private jsonLdBuffer = "";
  private titleBuffer = "";
  private headingBuffer = "";
  private productTitleBuffer = "";

  constructor(requestedUrl: string, finalUrl: string) {
    this.requestedUrl = requestedUrl;
    this.finalUrl = finalUrl;
  }

  async parse(html: string): Promise<void> {
    await new HTMLRewriter()
      .on("meta", {
        element: (element) => this.handleMeta(element as any),
      })
      .on("title", {
        text: (text) => this.collectTitleText(text as any),
      })
      .on("h1", {
        text: (text) => this.collectHeadingText(text as any),
      })
      .on("span#productTitle", {
        text: (text) => this.collectProductTitle(text as any),
      })
      .on("link", {
        element: (element) => this.handleLink(element as any),
      })
      .on("img", {
        element: (element) => this.handleImg(element as any),
      })
      .on('script[type="application/ld+json" i]', {
        text: (text) => this.collectJsonLd(text as any),
      })
      .transform(new Response(html))
      .text();
  }

  finalize(): PreviewPayload {
    const finalUrl = this.finalUrl || this.requestedUrl;
    const siteName = this.pickBest(this.siteNames);
    let title = this.pickBest(this.titles);
    if (title) {
      title = refinePreviewTitle(title, { siteName, finalUrl }) ?? title;
      title = truncate(title, PREVIEW_TITLE_MAX_LENGTH);
    }
    if (!title) {
      title = fallbackTitleForUrl(finalUrl);
    }
    let description = this.pickBest(this.descriptions);
    if (description) {
      description = truncate(description, PREVIEW_DESCRIPTION_MAX_LENGTH);
    }
    const image = this.pickImage("image");
    const icon = this.pickImage("icon") || guessFaviconUrl(finalUrl);

    return {
      url: this.requestedUrl,
      finalUrl,
      displayUrl: buildDisplayUrl(finalUrl),
      title,
      description: description || undefined,
      image,
      icon,
      siteName,
    };
  }

  private handleMeta(element: any): void {
    const content = element.getAttribute("content");
    if (!content) return;
    const property = (element.getAttribute("property") || "").toLowerCase();
    const name = (element.getAttribute("name") || "").toLowerCase();
    const itemprop = (element.getAttribute("itemprop") || "").toLowerCase();

    if (property === "og:title" || name === "og:title") {
      this.addTitle(content, 120);
    } else if (name === "twitter:title" || property === "twitter:title") {
      this.addTitle(content, 110);
    } else if (itemprop === "name" || name === "title") {
      this.addTitle(content, 90);
    }

    if (property === "og:site_name") {
      this.addSiteName(content, 70);
    } else if (name === "application-name") {
      this.addSiteName(content, 50);
    }

    if (property === "og:description" || name === "og:description") {
      this.addDescription(content, 110);
    } else if (name === "twitter:description" || property === "twitter:description") {
      this.addDescription(content, 100);
    } else if (name === "description") {
      this.addDescription(content, 80);
    }

    if (
      property === "og:image" ||
      property === "og:image:url" ||
      property === "og:image:secure_url" ||
      name === "twitter:image" ||
      name === "twitter:image:src" ||
      name === "og:image"
    ) {
      this.addImage(content, 120, "image");
    } else if (property === "og:logo" || name === "msapplication-square150x150logo") {
      this.addImage(content, 90, "icon");
    }
  }

  private handleLink(element: any): void {
    const rel = (element.getAttribute("rel") || "").toLowerCase();
    if (!rel) return;
    const href = element.getAttribute("href");
    if (!href) return;
    if (/apple-touch-icon/.test(rel)) {
      this.addImage(href, 90, "icon");
    } else if (/icon/.test(rel)) {
      this.addImage(href, 70, "icon");
    }
  }

  private handleImg(element: any): void {
    const base = this.finalUrl;
    const idAttr = (element.getAttribute("id") || "").toLowerCase();
    const oldHires = element.getAttribute("data-old-hires");
    if (oldHires) this.addImage(oldHires, 120, "image");

    const attrCandidates = [
      element.getAttribute("data-main-image-href"),
      element.getAttribute("data-hires"),
      element.getAttribute("data-large-image"),
      element.getAttribute("data-original-src"),
      element.getAttribute("data-src"),
      element.getAttribute("data-lazy-src"),
    ];
    for (const attr of attrCandidates) {
      if (attr) {
        const priority = idAttr.includes("landingimage") ? 120 : 95;
        this.addImage(attr, priority, "image");
      }
    }

    const dynamic = parseDynamicImageAttribute(element.getAttribute("data-a-dynamic-image"), base);
    if (dynamic) this.addImage(dynamic, 110, "image");

    const srcset = extractFromSrcset(element.getAttribute("data-srcset") || element.getAttribute("srcset"), base);
    if (srcset) this.addImage(srcset, 90, "image");

    const src = element.getAttribute("src");
    if (src) this.addImage(src, 70, "image");
  }

  private collectTitleText(text: any): void {
    if (!text?.text) return;
    this.titleBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.titleBuffer, 80);
      this.titleBuffer = "";
    }
  }

  private collectHeadingText(text: any): void {
    if (!text?.text) return;
    this.headingBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.headingBuffer, 60);
      this.headingBuffer = "";
    }
  }

  private collectProductTitle(text: any): void {
    if (!text?.text) return;
    this.productTitleBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.productTitleBuffer, 95);
      this.productTitleBuffer = "";
    }
  }

  private collectJsonLd(text: any): void {
    if (!text?.text) return;
    this.jsonLdBuffer += text.text;
    if (text.lastInTextNode) {
      this.processJsonLd(this.jsonLdBuffer);
      this.jsonLdBuffer = "";
    }
  }

  private processJsonLd(raw: string): void {
    if (!raw) return;
    try {
      const json = JSON.parse(raw) as JsonLdValue | JsonLdValue[];
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        this.walkJsonLd(node);
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }

  private walkJsonLd(value: JsonLdValue): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.walkJsonLd(entry);
      }
      return;
    }
    if (typeof value === "object") {
      const obj = value as JsonLdObject;
      if (obj.image !== undefined) {
        this.extractImageFromJsonLd(obj.image, "image", 100);
      }
      if (obj.logo !== undefined) {
        this.extractImageFromJsonLd(obj.logo, "icon", 90);
      }
      if (obj.thumbnailUrl !== undefined) {
        this.extractImageFromJsonLd(obj.thumbnailUrl, "image", 95);
      }
      if (typeof obj.name === "string") {
        this.addTitle(obj.name, 80);
      }
      if (typeof obj.headline === "string") {
        this.addTitle(obj.headline, 75);
      }
      if (typeof obj.alternativeHeadline === "string") {
        this.addTitle(obj.alternativeHeadline, 70);
      }
      if (typeof obj.description === "string") {
        this.addDescription(obj.description, 90);
      }
      for (const nested of Object.values(obj)) {
        if (nested && (typeof nested === "object" || Array.isArray(nested))) {
          this.walkJsonLd(nested);
        }
      }
    } else if (typeof value === "string") {
      // strings can be plain descriptions
      this.addDescription(value, 50);
    }
  }

  private extractImageFromJsonLd(value: JsonLdValue | undefined, kind: "image" | "icon", priority: number): void {
    if (!value) return;
    if (typeof value === "string") {
      this.addImage(value, priority, kind);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.extractImageFromJsonLd(item, kind, priority);
      }
      return;
    }
    if (typeof value === "object") {
      const obj = value as JsonLdObject;
      const urlFields: (keyof JsonLdObject)[] = ["url", "contentUrl", "@id"];
      for (const field of urlFields) {
        const candidate = obj[field];
        if (typeof candidate === "string") {
          this.addImage(candidate, priority, kind);
          return;
        }
      }
      for (const nested of Object.values(obj)) {
        if (nested) {
          this.extractImageFromJsonLd(nested, kind, priority);
        }
      }
    }
  }

  private addTitle(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.titles, normalized, priority);
  }

  private addDescription(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.descriptions, normalized, priority);
  }

  private addSiteName(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.siteNames, normalized, priority);
  }

  private addImage(value: string | null | undefined, priority: number, kind: "image" | "icon"): void {
    const absolute = resolveUrl(this.finalUrl, value);
    if (!absolute) return;
    const existing = this.images.find((entry) => entry.url === absolute);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      if (kind === "image") {
        existing.kind = "image";
      }
      return;
    }
    this.images.push({ url: absolute, priority, kind });
  }

  private upsertRankedValue(list: PreviewRankedValue[], value: string, priority: number): void {
    const existing = list.find((entry) => entry.value === value);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
    } else {
      list.push({ value, priority });
    }
  }

  private pickBest(list: PreviewRankedValue[]): string | undefined {
    if (!list.length) return undefined;
    const sorted = [...list].sort((a, b) => b.priority - a.priority);
    return sorted[0]?.value;
  }

  private pickImage(kind: "image" | "icon"): string | undefined {
    const filtered = this.images.filter((entry) => (kind === "image" ? entry.kind === "image" : true));
    const sorted = filtered.sort((a, b) => b.priority - a.priority);
    if (sorted.length) return sorted[0]?.url;
    if (kind === "icon") {
      const fallback = [...this.images].sort((a, b) => b.priority - a.priority);
      if (fallback.length) return fallback[0]?.url;
    }
    return undefined;
  }
}

type LinkPreviewResult = Awaited<ReturnType<typeof getPreviewFromContent>>;

function pickPreviewAsset(candidates: unknown, baseUrl: string): string | undefined {
  if (!candidates) return undefined;
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of list) {
    if (typeof candidate !== "string") continue;
    const absolute = resolveUrl(baseUrl, candidate);
    if (!absolute) continue;
    try {
      const parsed = new URL(absolute);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function normalizeLinkPreviewResult(
  result: LinkPreviewResult,
  requestedUrl: string,
): { preview: PreviewPayload; rich: boolean } | null {
  if (!result || typeof result !== "object") return null;

  const rawSiteName = (result as { siteName?: unknown }).siteName;
  const finalUrl = typeof (result as { url?: unknown }).url === "string" && (result as { url?: string }).url
    ? (result as { url?: string }).url!
    : requestedUrl;
  const siteName = normalizeText(typeof rawSiteName === "string" ? rawSiteName : null) ?? undefined;

  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  const rawTitle = (result as { title?: unknown }).title;
  let title = normalizeText(typeof rawTitle === "string" ? rawTitle : null);
  let usedFallbackTitle = false;
  if (title) {
    title = refinePreviewTitle(title, { siteName, finalUrl }) ?? title;
    title = truncate(title, PREVIEW_TITLE_MAX_LENGTH);
  } else {
    title = fallbackTitle;
    usedFallbackTitle = true;
  }

  const rawDescription = (result as { description?: unknown }).description;
  let description = normalizeText(typeof rawDescription === "string" ? rawDescription : null);
  if (description) {
    description = truncate(description, PREVIEW_DESCRIPTION_MAX_LENGTH);
  }

  const image = pickPreviewAsset((result as { images?: unknown }).images, finalUrl);
  const icon =
    pickPreviewAsset((result as { favicons?: unknown }).favicons, finalUrl) ?? guessFaviconUrl(finalUrl);

  const preview: PreviewPayload = {
    url: requestedUrl,
    finalUrl,
    displayUrl: buildDisplayUrl(finalUrl),
    title,
    description: description ?? undefined,
    image,
    icon,
    siteName,
  };

  const rich = Boolean(image && !usedFallbackTitle);
  return { preview, rich };
}

function mergePreviewPayloads(primary: PreviewPayload | null, secondary: PreviewPayload | null): PreviewPayload | null {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;

  const merged: PreviewPayload = { ...primary };
  const mergedFinalUrl = merged.finalUrl || secondary.finalUrl || merged.url;
  if (mergedFinalUrl !== merged.finalUrl) {
    merged.finalUrl = mergedFinalUrl;
    merged.displayUrl = buildDisplayUrl(mergedFinalUrl);
  }

  const fallbackTitle = fallbackTitleForUrl(mergedFinalUrl);
  const secondaryFallbackTitle = fallbackTitleForUrl(secondary.finalUrl || secondary.url);

  const currentTitle = merged.title;
  const secondaryTitle = secondary.title;
  const currentIsGeneric = !currentTitle || currentTitle === fallbackTitle;
  const secondaryIsGeneric = !secondaryTitle || secondaryTitle === secondaryFallbackTitle;

  if (currentIsGeneric && !secondaryIsGeneric && secondaryTitle) {
    merged.title = secondaryTitle;
  }

  merged.title =
    refinePreviewTitle(merged.title, { siteName: merged.siteName, finalUrl: merged.finalUrl }) ?? merged.title;
  if (!merged.description && secondary.description) {
    merged.description = secondary.description;
  }
  if (!merged.image && secondary.image) {
    merged.image = secondary.image;
  }
  if (!merged.icon && secondary.icon) {
    merged.icon = secondary.icon;
  }
  if (!merged.siteName && secondary.siteName) {
    merged.siteName = secondary.siteName;
  }

  return merged;
}

function hasRichPreview(preview: PreviewPayload): boolean {
  if (!preview.image) return false;
  const finalUrl = preview.finalUrl || preview.url;
  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  return Boolean(preview.title && preview.title !== fallbackTitle);
}

type DerivedPreviewResult = {
  preview: PreviewPayload | null;
  rich: boolean;
};

function collectHostCandidates(requestedUrl: string, finalUrl: string): Set<string> {
  const hosts = new Set<string>();
  for (const value of [requestedUrl, finalUrl]) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      hosts.add(parsed.hostname.toLowerCase());
    } catch {
      /* ignore */
    }
    try {
      const unwrapped = unwrapGoogleRedirectUrl(value);
      if (unwrapped && unwrapped !== value) {
        const parsed = new URL(unwrapped);
        hosts.add(parsed.hostname.toLowerCase());
      }
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function extractAmazonAsin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const asinParam = parsed.searchParams.get("asin");
    if (asinParam && /^[A-Z0-9]{10}$/i.test(asinParam)) {
      return asinParam.toUpperCase();
    }
    const pathMatch = parsed.pathname.match(
      /(?:dp|gp\/product|gp\/aw\/d|gp\/slredirect|gp\/aw\/olp|exec\/obidos\/asin)\/([A-Z0-9]{10})/i,
    );
    if (pathMatch) {
      return pathMatch[1].toUpperCase();
    }
    const genericMatch = parsed.pathname.match(/\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (genericMatch) {
      return genericMatch[1].toUpperCase();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractEtsyListingId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/\/listing\/(\d+)/i);
    if (pathMatch) {
      return pathMatch[1];
    }
    const listingId = parsed.searchParams.get("listing_id");
    if (listingId && /^\d+$/.test(listingId)) {
      return listingId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function canonicalizeAmazonUrl(url: string): string | null {
  const asin = extractAmazonAsin(url);
  if (!asin) return null;
  return `https://www.amazon.com/dp/${asin}`;
}

function canonicalizeEtsyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const listingIndex = segments.indexOf("listing");
    if (listingIndex === -1 || listingIndex + 1 >= segments.length) return null;
    const listingId = segments[listingIndex + 1];
    const slugSegments = segments.slice(listingIndex + 2);
    const slug = slugSegments.length ? `/${slugSegments.join("/")}` : "";
    return `${parsed.protocol}//${parsed.hostname}/listing/${listingId}${slug}`;
  } catch {
    return null;
  }
}

function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) {
      const id = parsed.pathname.replace(/^\/+/, "");
      return id || null;
    }
    if (parsed.hostname.includes("youtube.")) {
      const id = parsed.searchParams.get("v");
      if (id) return id;
      const match = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
      if (match) return match[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

function canonicalizeYouTubeUrl(url: string): string | null {
  const id = extractYouTubeId(url);
  if (!id) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

function buildAmazonImageUrl(asin: string): string {
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL600_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822`;
}

function extractAmazonImageFromHtml(html: string): string | undefined {
  const patterns = [
    /"hiRes":"(https:[^\"]+)"/i,
    /"large":"(https:[^\"]+)"/i,
    /"mainUrl":"(https:[^\"]+)"/i,
    /"displayImgSrc":"(https:[^\"]+)"/i,
    /data-old-hires="([^"]+)"/i,
    /data-old-hires='([^']+)'/i,
    /data-main-image-url="([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1]) {
      const cleaned = decodeHtmlEntities(match[1]).replace(/\\u0026/g, "&");
      const sanitized = sanitizeUrl(cleaned);
      if (sanitized) {
        return sanitized;
      }
    }
  }
  return undefined;
}

function safeParseJson(raw: string): any | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      // replace unescaped newlines which sometimes appear in JSON-LD
      const normalized = text.replace(/\n/g, "\\n");
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }
}

function extractImageFromJsonLd(node: any): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") {
    const sanitized = sanitizeUrl(node);
    return sanitized ?? undefined;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = extractImageFromJsonLd(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node === "object") {
    const keys = ["image", "imageUrl", "thumbnailUrl", "contentUrl", "url"];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const found = extractImageFromJsonLd((node as Record<string, unknown>)[key]);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

function extractEtsyImageFromHtml(html: string): string | undefined {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html))) {
    const parsed = safeParseJson(match[1]);
    if (!parsed) continue;
    const found = extractImageFromJsonLd(parsed);
    if (found) {
      return found;
    }
  }
  const directMatch = html.match(/https:\/\/i\.etsystatic\.com\/[^"]+/i);
  if (directMatch && directMatch[0]) {
    const cleaned = decodeHtmlEntities(directMatch[0].replace(/\\u0026/g, "&"));
    const sanitized = sanitizeUrl(cleaned);
    if (sanitized) {
      return sanitized;
    }
  }
  return undefined;
}

function extractOgTitle(html: string): string | undefined {
  const regex = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i;
  const match = regex.exec(html);
  if (match && match[1]) {
    return truncate(decodeHtmlEntities(match[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  const descMatch = html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i);
  if (descMatch && descMatch[1]) {
    return truncate(decodeHtmlEntities(descMatch[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return truncate(decodeHtmlEntities(h1Match[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  return undefined;
}

async function fetchAlternateHtml(url: string, referer?: string): Promise<{ html: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildBrowserHeaders({ referer }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const html = await readResponseBodyLimited(response);
    if (!html) return null;
    return { html, finalUrl: response.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNoembedMetadata(url: string): Promise<{ title?: string; description?: string; thumbnail?: string; providerName?: string } | null> {
  const endpoint = `https://noembed.com/embed?nowrap=1&url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const payload = json as {
      title?: unknown;
      author_name?: unknown;
      provider_name?: unknown;
      thumbnail_url?: unknown;
      description?: unknown;
    };
    const title = typeof payload.title === "string" ? payload.title : undefined;
    const description =
      typeof payload.description === "string"
        ? payload.description
        : typeof payload.author_name === "string"
          ? payload.author_name
          : undefined;
    const thumbnail = typeof payload.thumbnail_url === "string" ? payload.thumbnail_url : undefined;
    const providerName = typeof payload.provider_name === "string" ? payload.provider_name : undefined;
    return { title, description, thumbnail, providerName };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPreviewFromExternalMetadata(
  requestedUrl: string,
  finalUrl: string,
  meta: { title?: string; description?: string; thumbnail?: string; providerName?: string },
  extras: { siteName?: string; fallbackImage?: string } = {},
): PreviewPayload {
  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  const refinedTitle = refinePreviewTitle(meta.title, { siteName: extras.siteName, finalUrl }) ?? meta.title;
  const title = refinedTitle ? truncate(refinedTitle, PREVIEW_TITLE_MAX_LENGTH) : fallbackTitle;
  const description = meta.description ? truncate(meta.description, PREVIEW_DESCRIPTION_MAX_LENGTH) : undefined;
  const image = meta.thumbnail || extras.fallbackImage;
  const siteName = extras.siteName || meta.providerName || getHostLabel(finalUrl) || getHostLabel(requestedUrl);
  return {
    url: requestedUrl,
    finalUrl,
    displayUrl: buildDisplayUrl(finalUrl),
    title,
    description,
    image: image ?? undefined,
    icon: guessFaviconUrl(finalUrl),
    siteName,
  };
}

async function fetchAlternateAmazon(requestedUrl: string, finalUrl: string): Promise<DerivedPreviewResult | null> {
  const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
  if (!asin) return null;
  const mobileUrl = `https://www.amazon.com/gp/aw/d/${asin}`;
  const alternates = await fetchAlternateHtml(mobileUrl, DEFAULT_REFERER);
  if (!alternates) {
    return null;
  }
  const derived = await derivePreviewFromHtml(
    requestedUrl,
    alternates.finalUrl || mobileUrl,
    alternates.html,
    { "content-type": "text/html" },
    200,
  );
  if (derived.preview) {
    const fallbackTitle = fallbackTitleForUrl(derived.preview.finalUrl || derived.preview.url);
    if (!derived.preview.image) {
      const image = extractAmazonImageFromHtml(alternates.html);
      if (image) {
        derived.preview.image = image;
      } else {
        const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
        if (asin) {
          derived.preview.image = buildAmazonImageUrl(asin);
        }
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const ogTitle = extractOgTitle(alternates.html);
      if (ogTitle) {
        derived.preview.title = ogTitle;
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
      if (asin) {
        derived.preview.title = truncate(`Amazon product ${asin}`, PREVIEW_TITLE_MAX_LENGTH);
      }
    }
  }
  return derived;
}

async function fetchAlternateEtsy(requestedUrl: string, finalUrl: string): Promise<DerivedPreviewResult | null> {
  const listingId = extractEtsyListingId(finalUrl) || extractEtsyListingId(requestedUrl);
  if (!listingId) return null;
  const mobileUrl = `https://m.etsy.com/listing/${listingId}`;
  const alternates = await fetchAlternateHtml(mobileUrl, DEFAULT_REFERER);
  if (!alternates) {
    return null;
  }

  const derived = await derivePreviewFromHtml(
    requestedUrl,
    alternates.finalUrl || mobileUrl,
    alternates.html,
    { "content-type": "text/html" },
    200,
  );

  if (derived.preview) {
    const fallbackTitle = fallbackTitleForUrl(derived.preview.finalUrl || derived.preview.url);
    if (!derived.preview.image || /favicon/.test(derived.preview.image)) {
      const image = extractEtsyImageFromHtml(alternates.html);
      if (image) {
        derived.preview.image = image;
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const ogTitle = extractOgTitle(alternates.html);
      if (ogTitle) {
        derived.preview.title = ogTitle;
      }
    }
  }

  return derived;
}

async function derivePreviewFromHtml(
  requestedUrl: string,
  finalUrl: string,
  html: string,
  headers: Record<string, string>,
  status: number,
): Promise<DerivedPreviewResult> {
  let primaryPreview: PreviewPayload | null = null;
  let primaryRich = false;
  try {
    const linkPreviewResult = await getPreviewFromContent(
      {
        url: finalUrl,
        data: html,
        headers,
        status,
      },
      {
        headers: {
          "user-agent": PREVIEW_USER_AGENT,
        },
      },
    );
    const normalized = normalizeLinkPreviewResult(linkPreviewResult, requestedUrl);
    if (normalized) {
      primaryPreview = normalized.preview;
      primaryRich = normalized.rich;
    }
  } catch {
    /* ignore primary failure */
  }

  let collectorPreview: PreviewPayload | null = null;
  try {
    const collector = new PreviewCollector(requestedUrl, finalUrl);
    await collector.parse(html);
    collectorPreview = collector.finalize();
  } catch {
    collectorPreview = null;
  }

  const mergedPreview = mergePreviewPayloads(primaryPreview, collectorPreview);
  if (!mergedPreview) {
    return { preview: null, rich: false };
  }
  return { preview: mergedPreview, rich: hasRichPreview(mergedPreview) || primaryRich };
}

type AlternatePreviewReason = "blocked" | "incomplete";

async function fetchYouTubeOEmbed(url: string): Promise<PreviewPayload | null> {
  let target = url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) {
      const videoId = parsed.pathname.replace(/^\/+/, "");
      if (videoId) {
        target = `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
  } catch {
    /* ignore */
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const title = typeof (json as { title?: unknown }).title === "string" ? (json as { title?: string }).title : undefined;
    const authorName =
      typeof (json as { author_name?: unknown }).author_name === "string"
        ? (json as { author_name?: string }).author_name
        : undefined;
    const thumbnail =
      typeof (json as { thumbnail_url?: unknown }).thumbnail_url === "string"
        ? (json as { thumbnail_url?: string }).thumbnail_url
        : undefined;
    const fallbackTitle = fallbackTitleForUrl(target);
    const finalTitle = title ? truncate(title, PREVIEW_TITLE_MAX_LENGTH) : fallbackTitle;
    const description = authorName ? `${authorName} • YouTube` : undefined;

    return {
      url,
      finalUrl: target,
      displayUrl: buildDisplayUrl(target),
      title: finalTitle,
      description,
      image: thumbnail ?? undefined,
      icon: "https://www.youtube.com/s/desktop/fe1f68f5/img/favicon_144.png",
      siteName: "YouTube",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEtsyOEmbed(url: string): Promise<PreviewPayload | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const canonical = canonicalizeEtsyUrl(url) ?? url;
    const endpoint = `https://www.etsy.com/oembed?url=${encodeURIComponent(canonical)}`;
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const data = json as {
      title?: unknown;
      url?: unknown;
      author_name?: unknown;
      provider_name?: unknown;
      thumbnail_url?: unknown;
    };
    const oembedUrl = typeof data.url === "string" && data.url ? data.url : canonical;
    const title =
      typeof data.title === "string" && data.title
        ? truncate(data.title, PREVIEW_TITLE_MAX_LENGTH)
        : fallbackTitleForUrl(oembedUrl);
    const seller = typeof data.author_name === "string" && data.author_name ? data.author_name : undefined;
    const image =
      typeof data.thumbnail_url === "string" && data.thumbnail_url ? data.thumbnail_url : undefined;
    const siteName =
      (typeof data.provider_name === "string" && data.provider_name) || "Etsy";

    return {
      url,
      finalUrl: oembedUrl,
      displayUrl: buildDisplayUrl(oembedUrl),
      title,
      description: seller ? `by ${seller}` : undefined,
      image: image ?? undefined,
      icon: "https://www.etsy.com/images/favicon.ico",
      siteName,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function attemptAlternatePreview(
  requestedUrl: string,
  finalUrl: string,
  reason: AlternatePreviewReason,
  existingPreview: PreviewPayload | null,
): Promise<{ preview: PreviewPayload; fallback?: boolean } | null> {
  const canonicalRequested = unwrapGoogleRedirectUrl(requestedUrl);
  const canonicalFinal = unwrapGoogleRedirectUrl(finalUrl || requestedUrl);
  const hosts = collectHostCandidates(canonicalRequested, canonicalFinal);
  let requestedHost: string | undefined;
  try {
    requestedHost = new URL(canonicalRequested).hostname.toLowerCase();
  } catch {
    requestedHost = undefined;
  }
  const hostMatches = (predicate: (host: string) => boolean) =>
    Array.from(hosts).some(predicate) || (requestedHost ? predicate(requestedHost) : false);
  const needsUpgrade = !existingPreview || !hasRichPreview(existingPreview);
  let fallbackCandidate: { preview: PreviewPayload; fallback?: boolean } | null = null;
  const setFallbackCandidate = (preview: PreviewPayload | null, options: { markFallback?: boolean } = {}): void => {
    if (!preview || !preview.image) return;
    if (!fallbackCandidate) {
      fallbackCandidate = options.markFallback ? { preview, fallback: true } : { preview };
    }
  };

  if (hostMatches((host) => host.includes("youtube.") || host.endsWith("youtu.be"))) {
    const canonicalYouTubeUrl =
      canonicalizeYouTubeUrl(canonicalFinal || canonicalRequested) ?? canonicalizeYouTubeUrl(canonicalRequested);
    const targetYoutubeUrl = canonicalYouTubeUrl || canonicalFinal || canonicalRequested;
    const youtubePreview = await fetchYouTubeOEmbed(targetYoutubeUrl);
    if (youtubePreview) {
      if (youtubePreview.image && youtubePreview.title) {
        return { preview: youtubePreview };
      }
      setFallbackCandidate(youtubePreview, { markFallback: needsUpgrade });
    }
    if (canonicalYouTubeUrl) {
      const youtubeNoembed = await fetchNoembedMetadata(canonicalYouTubeUrl);
      if (youtubeNoembed && (youtubeNoembed.title || youtubeNoembed.thumbnail)) {
        const fallbackImage = (() => {
          const id = extractYouTubeId(canonicalYouTubeUrl);
          return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
        })();
        const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalYouTubeUrl, youtubeNoembed, {
          siteName: "YouTube",
          fallbackImage,
        });
        if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
          return { preview };
        }
        setFallbackCandidate(preview, { markFallback: true });
      }
    }
  }

  const isAmazonHost = hostMatches((host) => host.includes("amazon."));
  if (isAmazonHost) {
    const canonicalAmazon = canonicalizeAmazonUrl(canonicalFinal || canonicalRequested) ?? canonicalizeAmazonUrl(canonicalRequested);
    if (canonicalAmazon) {
      const noembed = await fetchNoembedMetadata(canonicalAmazon);
      if (noembed && (noembed.title || noembed.thumbnail)) {
        const asin = extractAmazonAsin(canonicalAmazon) ?? extractAmazonAsin(canonicalRequested);
        const fallbackImage = asin ? buildAmazonImageUrl(asin) : undefined;
        const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalAmazon, noembed, {
          siteName: "Amazon",
          fallbackImage,
        });
        if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
          return { preview };
        }
        setFallbackCandidate(preview, { markFallback: true });
      }
    }
  }

  if (isAmazonHost && (reason === "blocked" || needsUpgrade)) {
    const amazonResult = await fetchAlternateAmazon(canonicalRequested, canonicalFinal || canonicalRequested);
    if (amazonResult?.preview) {
      if (amazonResult.rich) {
        return { preview: amazonResult.preview };
      }
      setFallbackCandidate(amazonResult.preview, { markFallback: true });
    }
  }

  const isEtsyHost = hostMatches((host) => host.includes("etsy."));
  if (isEtsyHost) {
    const canonicalEtsyUrl =
      canonicalizeEtsyUrl(canonicalFinal || canonicalRequested) ?? canonicalizeEtsyUrl(canonicalRequested);
    const targetEtsyUrl = canonicalEtsyUrl || canonicalFinal || canonicalRequested;
    const etsyPreview = await fetchEtsyOEmbed(targetEtsyUrl);
    if (etsyPreview) {
      if (etsyPreview.image && etsyPreview.title) {
        return { preview: etsyPreview };
      }
      setFallbackCandidate(etsyPreview, { markFallback: needsUpgrade });
    }
    const etsyNoembed = canonicalEtsyUrl ? await fetchNoembedMetadata(canonicalEtsyUrl) : null;
    if (etsyNoembed && (etsyNoembed.title || etsyNoembed.thumbnail)) {
      const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalEtsyUrl || targetEtsyUrl, etsyNoembed, {
        siteName: "Etsy",
      });
      if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
        return { preview };
      }
      setFallbackCandidate(preview, { markFallback: true });
    }
  }

  if (isEtsyHost && (reason === "blocked" || needsUpgrade)) {
    const etsyResult = await fetchAlternateEtsy(canonicalRequested, canonicalFinal || canonicalRequested);
    if (etsyResult?.preview) {
      if (etsyResult.rich) {
        return { preview: etsyResult.preview };
      }
      setFallbackCandidate(etsyResult.preview, { markFallback: needsUpgrade });
    }
  }

  if (fallbackCandidate) {
    return fallbackCandidate;
  }

  return null;
}

async function handlePreviewProxy(url: URL): Promise<Response> {
  const targetRaw = url.searchParams.get("url");
  if (!targetRaw) {
    return jsonResponse({ error: "url is required" }, 400);
  }
  const normalizedTarget = unwrapGoogleRedirectUrl(targetRaw);
  let parsed: URL;
  try {
    parsed = new URL(normalizedTarget);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonResponse({ error: "Only http(s) URLs are supported" }, 400);
  }
  const requestedUrl = parsed.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(requestedUrl, {
      method: "GET",
      headers: buildBrowserHeaders(),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    const alternate = await attemptAlternatePreview(requestedUrl, requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    const alternate = await attemptAlternatePreview(requestedUrl, upstream.url || requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, upstream.url || requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }

  let bodyText: string;
  try {
    bodyText = await readResponseBodyLimited(upstream);
  } catch {
    const alternate = await attemptAlternatePreview(requestedUrl, upstream.url || requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, upstream.url || requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }

  const finalUrlRaw = upstream.url || requestedUrl;
  const finalUrl = unwrapGoogleRedirectUrl(finalUrlRaw);
  const headerMap: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    headerMap[key.toLowerCase()] = value;
  });

  const blockedHint = !bodyText ? false : looksLikeBlockedPage(bodyText);

  const derived = await derivePreviewFromHtml(requestedUrl, finalUrl, bodyText || "", headerMap, upstream.status);
  if (derived.preview && derived.rich) {
    return buildPreviewResponse(derived.preview);
  }

  const alternate = await attemptAlternatePreview(
    requestedUrl,
    finalUrl,
    blockedHint ? "blocked" : "incomplete",
    derived.preview,
  );
  if (alternate) {
    return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
  }

  if (derived.preview) {
    return buildPreviewResponse(derived.preview, { fallback: !derived.rich });
  }

  const fallback = buildFallbackPreview(requestedUrl, finalUrl);
  return buildPreviewResponse(fallback, blockedHint ? { blocked: true } : { fallback: true });
}

async function handleDeleteDevice(deviceId: string, env: Env): Promise<Response> {
  const db = requireDb(env);
  const existing = await db
    .prepare<{ endpoint_hash: string | null }>(
      `SELECT endpoint_hash
       FROM devices
       WHERE device_id = ?`,
    )
    .bind(deviceId)
    .first<{ endpoint_hash: string | null }>();

  await db.batch([
    db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId),
  ]);

  if (env.TASKIFY_DEVICES) {
    await env.TASKIFY_DEVICES.delete(deviceKey(deviceId)).catch(() => {});
    const endpointHash = existing?.endpoint_hash;
    if (endpointHash) {
      await env.TASKIFY_DEVICES.delete(endpointKey(endpointHash)).catch(() => {});
    }
  }
  await env.TASKIFY_REMINDERS?.delete(remindersKey(deviceId)).catch(() => {});
  await env.TASKIFY_PENDING?.delete(pendingKey(deviceId)).catch(() => {});

  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handleSaveReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, reminders } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  if (!(await getDeviceRecord(env, deviceId))) {
    return jsonResponse({ error: "Unknown device" }, 404);
  }
  if (!Array.isArray(reminders)) {
    return jsonResponse({ error: "reminders must be an array" }, 400);
  }

  const db = requireDb(env);
  const now = Date.now();
  const entries: ReminderEntry[] = [];
  for (const item of reminders as ReminderTaskInput[]) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.taskId !== "string" || typeof item.title !== "string" || typeof item.dueISO !== "string") continue;
    if (!Array.isArray(item.minutesBefore)) continue;
    const dueTime = Date.parse(item.dueISO);
    if (Number.isNaN(dueTime)) continue;
    for (const minutes of item.minutesBefore) {
      if (typeof minutes !== "number" || minutes < 0) continue;
      const sendAt = dueTime - minutes * MINUTE_MS;
      if (sendAt <= now - MINUTE_MS) continue; // skip very old reminders
      if (sendAt - now > MAX_LEAD_MS) continue; // skip too far in future
      const reminderKey = `${item.taskId}:${minutes}`;
      entries.push({
        reminderKey,
        taskId: item.taskId,
        boardId: item.boardId,
        title: item.title,
        dueISO: item.dueISO,
        minutes,
        sendAt,
      });
    }
  }

  const statements = [db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId)];
  if (entries.length > 0) {
    entries.sort((a, b) => a.sendAt - b.sendAt);
    for (const entry of entries) {
      statements.push(
        db
          .prepare(
            `INSERT INTO reminders (device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            deviceId,
            entry.reminderKey,
            entry.taskId,
            entry.boardId ?? null,
            entry.title,
            entry.dueISO,
            entry.minutes,
            entry.sendAt,
          ),
      );
    }
  }

  await db.batch(statements);
  await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();

  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handlePollReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { endpoint, deviceId } = body || {};
  let resolvedDeviceId = typeof deviceId === "string" ? deviceId : undefined;
  if (!resolvedDeviceId && typeof endpoint === "string") {
    resolvedDeviceId = await findDeviceIdByEndpoint(env, endpoint);
  }
  if (!resolvedDeviceId) {
    return jsonResponse({ error: "Device not registered" }, 404);
  }
  const db = requireDb(env);
  const pendingRows = await db
    .prepare<PendingRow>(
      `SELECT id, task_id, board_id, title, due_iso, minutes
       FROM pending_notifications
       WHERE device_id = ?
       ORDER BY created_at, id`,
    )
    .bind(resolvedDeviceId)
    .all<PendingRow>();

  const rows = pendingRows.results ?? [];
  if (!rows.length) {
    return jsonResponse([]);
  }
  const deleteStatements = rows.map((row) => db.prepare("DELETE FROM pending_notifications WHERE id = ?").bind(row.id));
  await db.batch(deleteStatements);

  return jsonResponse(
    rows.map((row) => ({
      taskId: row.task_id,
      boardId: row.board_id ?? undefined,
      title: row.title,
      dueISO: row.due_iso,
      minutes: row.minutes,
    })),
  );
}

async function processDueReminders(env: Env): Promise<void> {
  const now = Date.now();
  const batchSize = 256;
  const db = requireDb(env);

  // Process in batches to keep cron executions bounded.
  while (true) {
    const dueResult = await db
      .prepare<ReminderRow>(
        `SELECT device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at
         FROM reminders
         WHERE send_at <= ?
         ORDER BY send_at
         LIMIT ?`,
      )
      .bind(now, batchSize)
      .all<ReminderRow>();

    const dueReminders = dueResult.results ?? [];
    if (!dueReminders.length) {
      break;
    }

    const deleteStatements = dueReminders.map((reminder) =>
      db
        .prepare("DELETE FROM reminders WHERE device_id = ? AND reminder_key = ?")
        .bind(reminder.device_id, reminder.reminder_key),
    );
    await db.batch(deleteStatements);

    const grouped = new Map<string, ReminderRow[]>();
    for (const reminder of dueReminders) {
      const existing = grouped.get(reminder.device_id);
      if (existing) {
        existing.push(reminder);
      } else {
        grouped.set(reminder.device_id, [reminder]);
      }
    }

    for (const [deviceId, reminders] of grouped) {
      const device = await getDeviceRecord(env, deviceId);
      if (!device) {
        await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();
        continue;
      }
      const pendingNotifications: PendingReminder[] = reminders.map((reminder) => ({
        taskId: reminder.task_id,
        boardId: reminder.board_id ?? undefined,
        title: reminder.title,
        dueISO: reminder.due_iso,
        minutes: reminder.minutes,
      }));
      await appendPending(env, deviceId, pendingNotifications);
      const ttlSeconds = computeReminderTTL(pendingNotifications, now);
      await sendPushPing(env, device, deviceId, ttlSeconds);
    }

    if (dueReminders.length < batchSize) {
      break;
    }
  }
}

async function appendPending(env: Env, deviceId: string, notifications: PendingReminder[]): Promise<void> {
  if (!notifications.length) return;
  const now = Date.now();
  const db = requireDb(env);
  const statements = notifications.map((notification) =>
    db
      .prepare(
        `INSERT INTO pending_notifications (device_id, task_id, board_id, title, due_iso, minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deviceId,
        notification.taskId,
        notification.boardId ?? null,
        notification.title,
        notification.dueISO,
        notification.minutes,
        now,
      ),
  );
  await db.batch(statements);
}

async function upsertDevice(env: Env, record: DeviceRecord, updatedAt: number): Promise<void> {
  const db = requireDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO devices (device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           platform = excluded.platform,
           endpoint = excluded.endpoint,
           endpoint_hash = excluded.endpoint_hash,
           subscription_auth = excluded.subscription_auth,
           subscription_p256dh = excluded.subscription_p256dh,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.deviceId,
        record.platform,
        record.subscription.endpoint,
        record.endpointHash,
        record.subscription.keys.auth,
        record.subscription.keys.p256dh,
        updatedAt,
      ),
  ]);
}

async function getDeviceRecord(env: Env, deviceId: string): Promise<DeviceRecord | null> {
  const db = requireDb(env);
  const row = await db
    .prepare<DeviceRow>(
      `SELECT device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh
       FROM devices
       WHERE device_id = ?`,
    )
    .bind(deviceId)
    .first<DeviceRow>();
  if (!row) {
    return migrateDeviceFromKv(env, deviceId);
  }
  return {
    deviceId: row.device_id,
    platform: row.platform,
    endpointHash: row.endpoint_hash,
    subscription: {
      endpoint: row.endpoint,
      keys: {
        auth: row.subscription_auth,
        p256dh: row.subscription_p256dh,
      },
    },
  };
}

async function findDeviceIdByEndpoint(env: Env, endpoint: string): Promise<string | undefined> {
  const hash = await hashEndpoint(endpoint);
  const db = requireDb(env);
  const row = await db
    .prepare<{ device_id: string }>(
      `SELECT device_id
       FROM devices
       WHERE endpoint_hash = ?`,
    )
    .bind(hash)
    .first<{ device_id: string }>();
  if (row?.device_id) {
    return row.device_id;
  }
  if (!env.TASKIFY_DEVICES) {
    return undefined;
  }
  const legacyDeviceId = await env.TASKIFY_DEVICES.get(endpointKey(hash));
  if (!legacyDeviceId) {
    return undefined;
  }
  await migrateDeviceFromKv(env, legacyDeviceId);
  return legacyDeviceId;
}

async function migrateDeviceFromKv(env: Env, deviceId: string): Promise<DeviceRecord | null> {
  const kvDevices = env.TASKIFY_DEVICES;
  if (!kvDevices) return null;

  const raw = await kvDevices.get(deviceKey(deviceId));
  if (!raw) return null;

  let parsed: DeviceRecord | null = null;
  try {
    const maybe = JSON.parse(raw) as DeviceRecord;
    if (
      maybe &&
      typeof maybe.deviceId === "string" &&
      (maybe.platform === "ios" || maybe.platform === "android") &&
      maybe.subscription &&
      typeof maybe.subscription.endpoint === "string" &&
      maybe.subscription.keys &&
      typeof maybe.subscription.keys.auth === "string" &&
      typeof maybe.subscription.keys.p256dh === "string"
    ) {
      parsed = maybe;
    }
  } catch (err) {
    console.warn("Failed to parse legacy device record", deviceId, err);
    return null;
  }

  if (!parsed) return null;

  if (!parsed.endpointHash) {
    parsed.endpointHash = await hashEndpoint(parsed.subscription.endpoint);
  }

  await upsertDevice(env, parsed, Date.now());

  await migrateRemindersFromKv(env, deviceId);
  await migratePendingFromKv(env, deviceId);

  await Promise.all([
    kvDevices.delete(deviceKey(deviceId)).catch(() => {}),
    parsed.endpointHash ? kvDevices.delete(endpointKey(parsed.endpointHash)).catch(() => {}) : Promise.resolve(),
  ]);

  return parsed;
}

async function migrateRemindersFromKv(env: Env, deviceId: string): Promise<void> {
  const kvReminders = env.TASKIFY_REMINDERS;
  if (!kvReminders) return;

  const raw = await kvReminders.get(remindersKey(deviceId));
  if (!raw) return;

  let entries: ReminderEntry[] = [];
  try {
    const maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) {
      entries = maybe as ReminderEntry[];
    }
  } catch (err) {
    console.warn("Failed to parse legacy reminders", { deviceId, err });
    entries = [];
  }

  if (!entries.length) {
    await kvReminders.delete(remindersKey(deviceId)).catch(() => {});
    return;
  }

  const db = requireDb(env);
  const statements = [db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId)];
  entries.sort((a, b) => (a?.sendAt ?? 0) - (b?.sendAt ?? 0));
  for (const entry of entries) {
    if (!entry || typeof entry.reminderKey !== "string" || typeof entry.taskId !== "string") continue;
    if (typeof entry.title !== "string" || typeof entry.dueISO !== "string" || typeof entry.minutes !== "number") continue;
    if (typeof entry.sendAt !== "number") continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO reminders (device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
        .bind(
          deviceId,
          entry.reminderKey,
          entry.taskId,
          entry.boardId ?? null,
          entry.title,
          entry.dueISO,
          entry.minutes,
          entry.sendAt,
        ),
    );
  }

  if (statements.length > 1) {
    await db.batch(statements);
  } else {
    await statements[0].run();
  }

  await kvReminders.delete(remindersKey(deviceId)).catch(() => {});
}

async function migratePendingFromKv(env: Env, deviceId: string): Promise<void> {
  const kvPending = env.TASKIFY_PENDING;
  if (!kvPending) return;

  const raw = await kvPending.get(pendingKey(deviceId));
  if (!raw) return;

  let entries: PendingReminder[] = [];
  try {
    const maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) {
      entries = maybe as PendingReminder[];
    }
  } catch (err) {
    console.warn("Failed to parse legacy pending payload", { deviceId, err });
    entries = [];
  }

  const normalized = entries.filter(
    (entry) =>
      entry &&
      typeof entry.taskId === "string" &&
      typeof entry.title === "string" &&
      typeof entry.dueISO === "string" &&
      typeof entry.minutes === "number",
  );

  if (!normalized.length) {
    await kvPending.delete(pendingKey(deviceId)).catch(() => {});
    return;
  }

  const db = requireDb(env);
  await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();
  await appendPending(env, deviceId, normalized);
  await kvPending.delete(pendingKey(deviceId)).catch(() => {});
}

function deviceKey(deviceId: string): string {
  return `device:${deviceId}`;
}

function remindersKey(deviceId: string): string {
  return `reminders:${deviceId}`;
}

function pendingKey(deviceId: string): string {
  return `pending:${deviceId}`;
}

function endpointKey(hash: string): string {
  return `endpoint:${hash}`;
}

function computeReminderTTL(reminders: PendingReminder[], now: number): number {
  let ttl = 300; // minimum of 5 minutes to give the device time to wake
  for (const reminder of reminders) {
    if (!reminder || typeof reminder.dueISO !== "string") continue;
    const due = Date.parse(reminder.dueISO);
    if (Number.isNaN(due)) continue;
    const secondsUntilDue = Math.max(0, Math.ceil((due - now) / 1000));
    ttl = Math.max(ttl, secondsUntilDue + 120); // allow a small buffer past due time
  }
  return Math.max(300, Math.min(86400, ttl));
}

async function sendPushPing(env: Env, device: DeviceRecord, deviceId: string, ttlSeconds: number): Promise<void> {
  try {
    const endpoint = device.subscription.endpoint;
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const token = await createVapidJWT(env, aud);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttlSeconds),
        Authorization: `WebPush ${token}`,
        "Crypto-Key": `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        "Content-Length": "0",
      },
    });

    if (response.status === 404 || response.status === 410) {
      console.warn("Subscription expired", deviceId);
      await handleDeleteDevice(deviceId, env);
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      console.warn("Push ping failed", response.status, text);
    }
  } catch (err) {
    console.error("Push ping error", err);
  }
}

async function createVapidJWT(env: Env, aud: string): Promise<string> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID keys are not configured");
  }
  const subject = normalizeVapidSubject(env.VAPID_SUBJECT);
  if (!subject) {
    throw new Error("VAPID subject is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 60 * 60; // 12 hours
  const header = base64UrlEncodeJSON({ alg: "ES256", typ: "JWT" });
  const payload = base64UrlEncodeJSON({ aud, exp, sub: subject });
  const signingInput = `${header}.${payload}`;
  const key = await getPrivateKey(env);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signature}`;
}

async function getPrivateKey(env: Env): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = await resolvePrivateKeyPem(env);
  const keyBytes = decodePemKey(pem);
  if (!keyBytes.length) {
    throw new Error("VAPID private key material is empty");
  }

  try {
    cachedPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return cachedPrivateKey;
  } catch (err) {
    if (!shouldAttemptRawVapidImport(err, keyBytes)) {
      throw err;
    }
    cachedPrivateKey = await importRawVapidPrivateKey(env, keyBytes);
    return cachedPrivateKey;
  }
}

async function resolvePrivateKeyPem(env: Env): Promise<string> {
  const binding = env.VAPID_PRIVATE_KEY as unknown;
  if (typeof binding === "string") {
    const trimmed = binding.trim();
    if (trimmed) return trimmed;
  }

  const maybeKv = binding as KVNamespace | undefined;
  if (maybeKv && typeof maybeKv.get === "function") {
    for (const candidate of PRIVATE_KEY_KV_KEYS) {
      try {
        const value = await maybeKv.get(candidate);
        if (value && value.trim()) return value.trim();
      } catch {
        // ignore and try next candidate
      }
    }
  }

  throw new Error("VAPID private key is not configured");
}

function shouldAttemptRawVapidImport(err: unknown, keyBytes: Uint8Array): boolean {
  if (!keyBytes || keyBytes.length !== 32) return false;
  if (!err) return false;
  const name = typeof (err as { name?: string }).name === "string" ? (err as { name?: string }).name : "";
  if (name === "DataError") return true;
  const message = typeof (err as Error).message === "string" ? (err as Error).message : "";
  return /invalid pkcs8/i.test(message);
}

async function importRawVapidPrivateKey(env: Env, scalar: Uint8Array): Promise<CryptoKey> {
  if (scalar.length !== 32) {
    throw new Error("Raw VAPID private key must be 32 bytes");
  }
  if (!env.VAPID_PUBLIC_KEY) {
    throw new Error("VAPID public key is required to import raw private key material");
  }
  const publicBytes = base64UrlDecode(env.VAPID_PUBLIC_KEY.trim());
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("VAPID public key is not a valid uncompressed P-256 point");
  }
  const xBytes = publicBytes.slice(1, 33);
  const yBytes = publicBytes.slice(33, 65);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    ext: false,
    key_ops: ["sign"],
    d: base64UrlEncode(scalar),
    x: base64UrlEncode(xBytes),
    y: base64UrlEncode(yBytes),
  } as JsonWebKey;

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

async function parseJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodePemKey(pem: string): Uint8Array {
  const trimmed = pem.trim();
  if (!trimmed) return new Uint8Array();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const nested = typeof parsed?.privateKey === "string"
        ? parsed.privateKey
        : typeof parsed?.key === "string"
          ? parsed.key
          : typeof parsed?.value === "string"
            ? parsed.value
            : undefined;
      if (nested) {
        return decodePemKey(nested);
      }
    } catch {
      // fall through to base64 decoding
    }
  }

  const cleaned = trimmed
    .replace(/-----BEGIN [^-----]+-----/g, "")
    .replace(/-----END [^-----]+-----/g, "")
    .replace(/\s+/g, "");

  if (!cleaned) return new Uint8Array();
  return base64UrlDecode(cleaned);
}

function base64UrlEncode(buffer: Uint8Array): string {
  let string = "";
  buffer.forEach((byte) => {
    string += String.fromCharCode(byte);
  });
  return btoa(string).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
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

function base64UrlEncodeJSON(value: unknown): string {
  const text = JSON.stringify(value);
  return base64UrlEncode(new TextEncoder().encode(text));
}

function normalizeVapidSubject(subjectRaw: string): string {
  if (typeof subjectRaw !== "string") return "";
  const trimmed = subjectRaw.trim();
  if (!trimmed) return "";

  if (/^mailto:/i.test(trimmed)) {
    const mailto = trimmed.replace(/^mailto:/i, "").replace(/\s+/g, "");
    return mailto ? `mailto:${mailto}` : "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "");
  }

  return trimmed;
}
