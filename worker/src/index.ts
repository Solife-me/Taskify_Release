/* eslint-disable no-console */
import { getPreviewFromContent } from "link-preview-js";
import { schnorr } from "@noble/curves/secp256k1.js";
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

interface Cache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface CacheStorage {
  default: Cache;
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
  "Cache-Control": "no-store",
};

const MINUTE_MS = 60_000;
const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_MAX_BYTES = 600_000;
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://www.google.com/";
const NIP05_CACHE_MAX_AGE_MS = 15 * MINUTE_MS;
const THREE_MONTHS_MS = 90 * 24 * 60 * MINUTE_MS;
const ONE_WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const BACKUP_CLEANUP_STATE_KEY = "backups-cleanup-state.json";

const VOICE_MAX_SESSIONS_PER_DAY = 10;
const VOICE_MAX_SECONDS_PER_DAY = 300;

const VOICE_TEST_BYPASS_NPUBS = new Set([
  "npub13p5mg2wszus5nt7seldn8d6dnppvf3xqe5q2vsq076r2ysvh93eqwhgqdm",
  "npub1f4t6089m5zhljvrurfuc8ceymlr6yzrdljxz9yaskyj8r8s536ns6rv35g",
]);
const GEMINI_MODEL_PRIMARY = "gemini-3.1-flash-lite-preview";
const GEMINI_MODEL_FALLBACK_1 = "gemini-3-flash-preview";
const GEMINI_MODEL_FALLBACK_2 = "gemini-2.5-flash";

type TaskCandidate = {
  id: string;
  title: string;
  dueText?: string;
  boardId?: string;
  subtasks?: string[];
  status: "draft" | "confirmed" | "dismissed";
};

type TaskOperation = {
  type: "create_task" | "update_task" | "delete_task" | "mark_uncertain";
  title?: string;
  dueText?: string;
  subtasks?: string[];
  targetRef?: string;
  changes?: Partial<Pick<TaskCandidate, "title" | "dueText" | "boardId" | "subtasks">>;
};

type FinalTask = {
  title: string;
  dueISO?: string;
  boardId?: string;
  notes?: string;
  subtasks?: string[];
  priority?: 1 | 2 | 3;
};

type VoiceQuotaRow = {
  npub: string;
  date: string;
  session_count: number;
  total_seconds: number;
};

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

    await db.prepare(
      `CREATE TABLE IF NOT EXISTS voice_quota (
         npub          TEXT    NOT NULL,
         date          TEXT    NOT NULL,
         session_count INTEGER NOT NULL DEFAULT 0,
         total_seconds INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (npub, date)
       )`,
    ).run();

    await ensureGcalSchema(env);
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

function parseNip05Address(input: string | null | undefined): { name: string; domain: string; normalized: string } | null {
  const value = (input || "").trim();
  if (!value) return null;
  const atIndex = value.indexOf("@");
  if (atIndex <= 0 || atIndex === value.length - 1) return null;
  const name = value.slice(0, atIndex).trim().toLowerCase();
  const domain = value.slice(atIndex + 1).trim().toLowerCase();
  if (!name || !domain) return null;
  return { name, domain, normalized: `${name}@${domain}` };
}

export default {
  async fetch(request: Request, env: Env, ctx: SchedulerController): Promise<Response> {
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
      if (url.pathname === "/api/nip05" && request.method === "GET") {
        return await handleNip05Lookup(url);
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
      if (url.pathname === "/api/voice/extract" && request.method === "POST") {
        return await handleVoiceExtract(request, env);
      }
      if (url.pathname === "/api/voice/finalize" && request.method === "POST") {
        return await handleVoiceFinalize(request, env);
      }
      // Google Calendar routes
      if (url.pathname === "/api/gcal/auth/url" && request.method === "GET") {
        return await handleGcalAuthUrl(request, env);
      }
      if (url.pathname === "/api/gcal/auth/callback" && request.method === "GET") {
        return await handleGcalAuthCallback(request, env);
      }
      if (url.pathname === "/api/gcal/connection" && request.method === "DELETE") {
        return await handleGcalDisconnect(request, env);
      }
      if (url.pathname === "/api/gcal/status" && request.method === "GET") {
        return await handleGcalStatus(request, env);
      }
      if (url.pathname === "/api/gcal/calendars" && request.method === "GET") {
        return await handleGcalCalendars(request, env);
      }
      if (url.pathname.startsWith("/api/gcal/calendars/") && request.method === "PATCH") {
        const calendarId = decodeURIComponent(url.pathname.substring("/api/gcal/calendars/".length));
        return await handleGcalToggleCalendar(request, env, calendarId);
      }
      if (url.pathname === "/api/gcal/events" && request.method === "GET") {
        return await handleGcalEvents(request, env);
      }
      if (url.pathname === "/api/gcal/sync" && request.method === "POST") {
        return await handleGcalSync(request, env);
      }
      if (url.pathname.startsWith("/api/gcal/webhook/") && request.method === "POST") {
        const channelId = decodeURIComponent(url.pathname.substring("/api/gcal/webhook/".length));
        return await handleGcalWebhook(request, env, channelId, ctx);
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
        await gcalRenewExpiredWatches(env);
        await gcalRetryFailedSyncs(env);
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

async function handleNip05Lookup(url: URL): Promise<Response> {
  const addressParam = url.searchParams.get("address") ?? url.searchParams.get("addr") ?? url.searchParams.get("nip05");
  const parsed = parseNip05Address(addressParam);
  if (!parsed) {
    return jsonResponse({ error: "Invalid NIP-05 address" }, 400);
  }

  const { name, domain, normalized } = parsed;
  const cacheStorage = (globalThis as any).caches as CacheStorage | undefined;
  const cacheKey = cacheStorage ? new Request(`https://cache.taskify/nip05/${encodeURIComponent(normalized)}`) : null;
  if (cacheStorage && cacheKey) {
    try {
      const cached = await cacheStorage.default.match(cacheKey);
      if (cached) {
        const cachedAt = getCacheTimestamp(cached);
        if (cachedAt !== null && Date.now() - cachedAt < NIP05_CACHE_MAX_AGE_MS) {
          return cached;
        }
      }
    } catch {}
  }

  const searchParam = encodeURIComponent(name);
  const isLocalhost =
    /^localhost(?::\d+)?$/i.test(domain) || /^127\.0\.0\.1(?::\d+)?$/i.test(domain) || domain === "[::1]";

  const buildUrls = (scheme: "https" | "http") => [
    `${scheme}://${domain}/.well-known/nostr.json?name=${searchParam}`,
    `${scheme}://${domain}/.well-known/nostr.json`,
  ];

  const urls = [...buildUrls("https"), ...(isLocalhost ? [] : buildUrls("http"))];
  let lastError = "NIP-05 lookup failed";
  for (const target of urls) {
    try {
      const res = await fetch(target, {
        headers: { Accept: "application/json" },
        redirect: "follow",
      });
      if (!res.ok) {
        lastError = `NIP-05 lookup failed (${res.status})`;
        continue;
      }
      const record = await res.json();
      const response = jsonResponse({ nip05: normalized, resolvedFrom: target, record });
      if (cacheStorage && cacheKey) {
        response.headers.set("Cache-Control", `public, max-age=${Math.floor(NIP05_CACHE_MAX_AGE_MS / 1000)}`);
        const now = new Date();
        response.headers.set("Date", now.toUTCString());
        response.headers.set("X-Cache-Timestamp", String(now.getTime()));
        cacheStorage.default.put(cacheKey, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return jsonResponse({ error: lastError }, 502);
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
    if (/\bapple-touch-icon\b/.test(rel)) {
      this.addImage(href, 90, "icon");
    } else if (/\bicon\b/.test(rel)) {
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
      if (!Number.isFinite(minutes)) continue;
      const sendAt = dueTime - minutes * MINUTE_MS;
      if (sendAt <= now - MINUTE_MS) continue; // skip very old reminders
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

// ─────────────────────────────────────────────────────────────────────────────
// Voice dictation helpers
// ─────────────────────────────────────────────────────────────────────────────

function utcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Rule-based fallback: split transcript on commas / "and" / "also" to produce
 * create_task operations without any AI. Used when Gemini is unavailable or
 * quota is exhausted.
 */
function ruleBasedOperations(transcript: string): TaskOperation[] {
  const segments = transcript
    .split(/,|\band\b|\balso\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.map((title) => ({ type: "create_task" as const, title }));
}

function isGarbageTaskTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 4) return true;
  if (/^(and|also|then|so|i|i\s+need|i\s+have|uh|um|like)$/.test(t)) return true;
  return false;
}

function cleanupTaskTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^(?:and\s+then|and|then|also)\s+/i, "");
  title = title.replace(/^(?:i\s+need\s+to|i\s+have\s+to|i(?:'| a)?m\s+going\s+to|i\s+can(?:not|'?t)\s+forget\s+to|there(?:'s|\s+is)\s+|we\s+have\s+(?:a\s+)?)\s*/i, "");
  title = title.replace(/^to\s+/i, "");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

function extractPickupItems(title: string): string[] {
  const m = title.match(/^(?:pick\s+up|get|buy)\s+(?:some\s+)?(.+)$/i);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw) return [];
  const splitByDelims = raw.split(/,|\band\b/i).map((v) => v.trim()).filter(Boolean);
  if (splitByDelims.length > 1) return splitByDelims;
  return [];
}

function normalizeSubtasks(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  return out.length ? out : undefined;
}

function dedupe(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.length ? out : undefined;
}

function applyTranscriptCorrections(operations: TaskOperation[], transcript: string): TaskOperation[] {
  if (!operations.length) return operations;
  const out = [...operations];
  const lower = transcript.toLowerCase();

  const correction = lower.match(/actually\s+change\s+the\s+([^.,;]+?)\s+to\s+([^.,;]+)/i);
  if (correction) {
    const targetPhrase = correction[1].trim();
    const newTime = correction[2].trim();
    const targetIdx = out.findIndex((op) =>
      op.type === "create_task" &&
      typeof op.title === "string" &&
      op.title.toLowerCase().includes(targetPhrase.replace(/\b(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i, "").trim()),
    );
    if (targetIdx >= 0) {
      const priorDue = out[targetIdx].dueText ?? "";
      const day = priorDue.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+sunday|next\s+monday|next\s+tuesday|next\s+wednesday|next\s+thursday|next\s+friday|next\s+saturday)\b/i)?.[0];
      out[targetIdx] = {
        ...out[targetIdx],
        dueText: day ? `${day} at ${newTime}` : newTime,
      };
    }
  }

  return out;
}

function toOperationsFromStructuredTasks(result: unknown): TaskOperation[] {
  const tasks = Array.isArray((result as any)?.tasks) ? ((result as any).tasks as any[]) : [];
  if (!tasks.length) return [];
  const operations: TaskOperation[] = [];

  for (const t of tasks) {
    let title = typeof t?.title === "string" ? cleanupTaskTitle(t.title) : "";
    if (isGarbageTaskTitle(title)) continue;

    let dueText = typeof t?.dueText === "string" && t.dueText.trim() ? t.dueText.trim() : undefined;
    let subtasks = normalizeSubtasks(t?.subtasks);

    const groceryContext = /grocery|groceries|store|shopping|supermarket/i.test(`${title} ${dueText ?? ""}`);
    const pickupItems = extractPickupItems(title);
    if (groceryContext && pickupItems.length) {
      const prev = operations[operations.length - 1];
      if (prev?.type === "create_task" && /grocery|store|shopping/i.test(prev.title || "")) {
        prev.subtasks = dedupe([...(prev.subtasks || []), ...pickupItems]);
        continue;
      }
      title = "Go to the grocery store";
      subtasks = dedupe([...(subtasks || []), ...pickupItems]);
    }

    const inlineDue = title.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (inlineDue && !dueText) {
      dueText = inlineDue[1];
      title = title.replace(new RegExp(`\\b${inlineDue[1]}\\b`, "i"), "").replace(/\s+/g, " ").trim();
    }

    const dayPrefix = title.match(/^(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b\s*(.*)$/i);
    if (dayPrefix) {
      if (!dueText) dueText = dayPrefix[1];
      if (dayPrefix[2]) title = dayPrefix[2].trim();
    }

    const birthday = title.match(/^([A-Za-z][A-Za-z' -]{1,40})\s+has\s+a\s+birthday\s+party/i);
    if (birthday) {
      const who = birthday[1].trim().replace(/\s+/g, " ");
      title = `${who}'s birthday party`;
    }
    const birthdayFor = title.match(/^birthday\s+party(?:\s+for)?\s+([A-Za-z][A-Za-z' -]{1,40})/i);
    if (birthdayFor) {
      const who = birthdayFor[1].trim().replace(/\s+/g, " ");
      title = `Birthday party for ${who}`;
    }

    const dinnerAfterChurch = title.match(/dinner\s+after\s+church/i);
    if (dinnerAfterChurch) {
      title = "Dinner after church";
    }

    if (isGarbageTaskTitle(title)) continue;
    operations.push({ type: "create_task", title, dueText, subtasks });
  }

  return operations;
}

function parseTaskPriority(value: unknown): 1 | 2 | 3 | undefined {
  const n = typeof value === "number" ? Math.round(value) : Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

function parseDueTextFallback(dueText: string, referenceDate: string, referenceOffsetMinutes = 0): string | undefined {
  const text = dueText.trim().toLowerCase();
  if (!text) return undefined;

  const refUtcMs = Date.parse(referenceDate);
  const safeRefUtcMs = Number.isNaN(refUtcMs) ? Date.now() : refUtcMs;
  const safeOffsetMinutes = Number.isFinite(referenceOffsetMinutes) ? referenceOffsetMinutes : 0;

  // Represent user's local wall-clock time on a UTC-based Date object.
  const localNow = new Date(safeRefUtcMs - safeOffsetMinutes * 60_000);

  const dayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  const dayMatch = text.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (!dayMatch) return undefined;

  const targetLocal = new Date(localNow.getTime());
  const dayWord = dayMatch[1];

  if (dayWord === "tomorrow") {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
  } else if (dayWord !== "today" && dayWord !== "tonight") {
    const targetDow = dayMap[dayWord];
    const currentDow = targetLocal.getUTCDay();
    let delta = (targetDow - currentDow + 7) % 7;
    if (delta === 0) delta = 7;
    targetLocal.setUTCDate(targetLocal.getUTCDate() + delta);
  }

  let hours: number | undefined;
  let minutes = 0;

  if (/\bnoon\b/.test(text)) {
    hours = 12;
  } else if (/\bmidnight\b/.test(text)) {
    hours = 0;
  } else {
    const tm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (tm) {
      const h = Number(tm[1]);
      const m = tm[2] ? Number(tm[2]) : 0;
      if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
        hours = h % 12;
        if (tm[3] === "pm") hours += 12;
        minutes = m;
      }
    }
  }

  if (hours === undefined) return undefined;

  const y = targetLocal.getUTCFullYear();
  const m = targetLocal.getUTCMonth();
  const d = targetLocal.getUTCDate();

  // local wall-clock -> UTC
  const utcMs = Date.UTC(y, m, d, hours, minutes, 0, 0) + safeOffsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

async function getVoiceQuota(db: D1Database, npub: string, date: string): Promise<VoiceQuotaRow | null> {
  return db
    .prepare<VoiceQuotaRow>("SELECT npub, date, session_count, total_seconds FROM voice_quota WHERE npub = ? AND date = ?")
    .bind(npub, date)
    .first<VoiceQuotaRow>();
}

async function incrementVoiceQuota(db: D1Database, npub: string, date: string, addSeconds: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO voice_quota (npub, date, session_count, total_seconds)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(npub, date) DO UPDATE SET
         session_count = session_count + 1,
         total_seconds = total_seconds + ?`,
    )
    .bind(npub, date, addSeconds, addSeconds)
    .run();
}

/**
 * Call Gemini 2.0 Flash and parse the JSON embedded in the first candidate's
 * text part. Returns null on any error (network, parse, unexpected shape).
 */
function parseJsonStringSafely(text: unknown): unknown | null {
  if (typeof text !== "string") return null;
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

async function callGemini(apiKey: string, prompt: string): Promise<unknown | null> {
  const models = [GEMINI_MODEL_PRIMARY, GEMINI_MODEL_FALLBACK_1, GEMINI_MODEL_FALLBACK_2];

  for (const model of models) {
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 1024,
              responseMimeType: "application/json",
            },
          }),
        },
      );
    } catch {
      continue;
    }

    if (!response.ok) continue;

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      continue;
    }
    const text = (json as any)?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseJsonStringSafely(text);
    if (parsed) return parsed;
  }

  return null;
}

async function callCloudflareGlmFallback(env: Env, prompt: string): Promise<unknown | null> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) return null;

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/zai-org/glm-4.7-flash`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.1,
        }),
      },
    );
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }

  // Workers AI chat responses may place text in result.response or result.output_text
  const text = (json as any)?.result?.response
    ?? (json as any)?.result?.output_text
    ?? (json as any)?.response;

  return parseJsonStringSafely(text);
}

async function callVoiceModelWithFallback(env: Env, prompt: string): Promise<unknown | null> {
  if (env.GEMINI_API_KEY) {
    const gemini = await callGemini(env.GEMINI_API_KEY, prompt);
    if (gemini) return gemini;
  }
  return callCloudflareGlmFallback(env, prompt);
}

async function handleVoiceExtract(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)) {
    return jsonResponse({ error: "Voice extraction is not configured" }, 501);
  }

  const body = await parseJson(request);
  const npub = typeof body?.npub === "string" ? body.npub.trim() : "";
  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  const candidates: TaskCandidate[] = Array.isArray(body?.candidates) ? body.candidates : [];
  const sessionDurationSeconds: number =
    typeof body?.sessionDurationSeconds === "number" && Number.isFinite(body.sessionDurationSeconds)
      ? Math.max(0, body.sessionDurationSeconds)
      : 0;

  if (!npub) {
    return jsonResponse({ error: "npub is required" }, 400);
  }
  if (!/^npub1[0-9a-z]+$/i.test(npub)) {
    return jsonResponse({ error: "npub must be a valid bech32 npub" }, 400);
  }
  if (!transcript) {
    return jsonResponse({ error: "transcript must be a non-empty string" }, 400);
  }

  const npubNormalized = npub.trim().toLowerCase();
  const bypassQuota = VOICE_TEST_BYPASS_NPUBS.has(npubNormalized);

  const db = requireDb(env);
  const today = utcDateString();
  const quota = await getVoiceQuota(db, npub, today);

  const currentSessions = quota?.session_count ?? 0;
  const currentSeconds = quota?.total_seconds ?? 0;
  const projectedSessions = currentSessions + 1;
  const projectedSeconds = currentSeconds + sessionDurationSeconds;

  const overQuota = !bypassQuota && (
    projectedSessions > VOICE_MAX_SESSIONS_PER_DAY ||
    projectedSeconds > VOICE_MAX_SECONDS_PER_DAY
  );

  if (overQuota) {
    return jsonResponse(
      { error: "quota_exceeded", message: "Voice extraction unavailable right now. Please try again later." },
      429,
    );
  }

  const prompt = `Extract actionable tasks from this full voice transcript.

Transcript: "${transcript}"

Return ONLY JSON in this exact shape:
{
  "tasks": [
    { "title": string, "dueText": string|null, "subtasks": string[] }
  ]
}

Rules:
- Prefer fewer, high-quality tasks. Do not split one task into fragments.
- Never keep leading fragments in titles (drop/clean: "I need to", "then", "and then", "then tomorrow", "then Friday", "we have", "there's").
- If user says grocery/shopping item lists, keep ONE parent task and put items in subtasks.
- Keep relative date/time phrases in dueText (e.g. "tomorrow 2:00 PM", "Friday at noon", "today at 5 PM").
- Apply in-sentence corrections: if user says "actually change X to Y", update the earlier task for X.
- Keep title nouns concise and board-ready.
- Good title examples: "Go to the grocery store", "Birthday party for Ashley", "Play date", "Dinner after church", "Get dogs from Gran Gran's".
- Bad titles: "then I", "also", "and", "next Sunday at 2 PM we have...".
- If no valid tasks exist, return {"tasks":[]}.

Output JSON only.`;

  const result = await callVoiceModelWithFallback(env, prompt);
  if (!result) {
    return jsonResponse({ error: "gemini_unavailable", message: "Voice extraction unavailable right now. Please try again later." }, 503);
  }

  let operations = toOperationsFromStructuredTasks(result);

  if (!operations.length && Array.isArray((result as any).operations)) {
    operations = (result as any).operations as TaskOperation[];
  }

  operations = applyTranscriptCorrections(operations, transcript);

  // Increment quota on successful (non-quota-exceeded) path
  await incrementVoiceQuota(db, npub, today, sessionDurationSeconds);

  return jsonResponse({ operations });
}

async function handleVoiceFinalize(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)) {
    return jsonResponse({ error: "Voice finalization is not configured" }, 501);
  }

  const body = await parseJson(request);
  const npub = typeof body?.npub === "string" ? body.npub.trim() : "";
  const rawCandidates: unknown = body?.candidates;
  const boardId = typeof body?.boardId === "string" ? body.boardId : undefined;
  const referenceDate =
    typeof body?.referenceDate === "string" && body.referenceDate
      ? body.referenceDate
      : new Date().toISOString();
  const referenceTimeZone =
    typeof body?.referenceTimeZone === "string" && body.referenceTimeZone.trim()
      ? body.referenceTimeZone.trim()
      : "UTC";
  const referenceOffsetMinutes =
    typeof body?.referenceOffsetMinutes === "number" && Number.isFinite(body.referenceOffsetMinutes)
      ? body.referenceOffsetMinutes
      : 0;

  if (!npub) {
    return jsonResponse({ error: "npub is required" }, 400);
  }
  if (!/^npub1[0-9a-z]+$/i.test(npub)) {
    return jsonResponse({ error: "npub must be a valid bech32 npub" }, 400);
  }
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return jsonResponse({ error: "candidates must be a non-empty array" }, 400);
  }

  const confirmed = (rawCandidates as TaskCandidate[]).filter(
    (c) => c && typeof c === "object" && c.status === "confirmed",
  );

  if (confirmed.length === 0) {
    return jsonResponse({ error: "No confirmed candidates to finalize" }, 400);
  }

  const tasks: FinalTask[] = [];

  const batchPrompt = `You are a Taskify task/event finalization assistant.

Reference date (user local now): ${referenceDate}
User time zone: ${referenceTimeZone}
User UTC offset minutes (Date.getTimezoneOffset): ${referenceOffsetMinutes}

Candidates:
${JSON.stringify(
    confirmed.map((c) => ({
      id: c.id,
      title: c.title,
      dueText: c.dueText ?? null,
      subtasks: c.subtasks ?? [],
      boardId: c.boardId ?? boardId ?? null,
    })),
  )}

Return ONLY JSON with exact shape:
{
  "tasks": [
    {
      "id": string,
      "title": string,
      "dueISO": string | null,
      "subtasks": string[],
      "notes": string | null,
      "boardId": string | null,
      "priority": 1 | 2 | 3 | null
    }
  ]
}

Rules:
- Return one finalized output item for every input candidate id.
- Fill all fields for each item.
- If dueText contains a date/time intent (e.g. "tomorrow 2 PM", "Friday at noon"), dueISO MUST be a valid ISO-8601 UTC datetime.
- Use dueISO null only when there is truly no parseable date/time intent.
- Priority defaults to null.
- Only set priority to 1/2/3 when the user language clearly implies urgency/importance.
- Do NOT infer priority from normal planning language.
- Keep title clean and action-oriented.
- Preserve checklist-like nouns as subtasks.
- No markdown, no prose.`;

  const batchResult = await callVoiceModelWithFallback(env, batchPrompt);
  if (!batchResult) {
    return jsonResponse({ error: "gemini_unavailable", message: "Voice finalization unavailable right now. Please try again later." }, 503);
  }
  const batchTasks = Array.isArray((batchResult as any)?.tasks) ? (batchResult as any).tasks as any[] : [];
  const batchById = new Map<string, any>();
  for (const t of batchTasks) {
    const id = typeof t?.id === "string" ? t.id : "";
    if (id) batchById.set(id, t);
  }

  for (const candidate of confirmed) {
    const fromBatch = batchById.get(candidate.id);
    let normalizedTitle = candidate.title;
    let dueISO: string | undefined;
    let subtasks = candidate.subtasks;
    let notes: string | undefined;
    let normalizedBoardId = candidate.boardId ?? boardId;
    let priority: 1 | 2 | 3 | undefined;

    if (fromBatch && typeof fromBatch.title === "string" && fromBatch.title.trim()) {
      normalizedTitle = fromBatch.title.trim();
    }
    if (fromBatch && typeof fromBatch.dueISO === "string") {
      const candidateDue = fromBatch.dueISO.trim();
      if (candidateDue && !Number.isNaN(Date.parse(candidateDue))) {
        dueISO = candidateDue;
      }
    }
    if (fromBatch && typeof fromBatch.notes === "string" && fromBatch.notes.trim()) {
      notes = fromBatch.notes.trim();
    }
    if (fromBatch && typeof fromBatch.boardId === "string" && fromBatch.boardId.trim()) {
      normalizedBoardId = fromBatch.boardId.trim();
    }
    priority = parseTaskPriority(fromBatch?.priority);
    subtasks = normalizeSubtasks(fromBatch?.subtasks) ?? subtasks;

    tasks.push({
      title: normalizedTitle,
      dueISO,
      boardId: normalizedBoardId,
      notes,
      subtasks,
      priority,
    });
  }

  return jsonResponse({ tasks });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function getCacheTimestamp(response: Response): number | null {
  const header = response.headers.get("X-Cache-Timestamp") || response.headers.get("Date");
  if (!header) {
    return null;
  }

  const numeric = Number(header);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(header);
  return Number.isNaN(parsed) ? null : parsed;
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

// =============================================================================
// Google Calendar Integration
// =============================================================================

// --- gcalCrypto helpers -------------------------------------------------------

// AES-256-GCM encrypt. Returns { enc, iv, tag } all base64url strings.
async function gcalEncryptToken(
  plaintext: string,
  keyHex: string,
): Promise<{ enc: string; iv: string; tag: string }> {
  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  // AES-GCM in Web Crypto appends 16-byte tag to ciphertext
  const cipherWithTag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBuf, tagLength: 128 },
    cryptoKey,
    encoded,
  );
  const cipherArr = new Uint8Array(cipherWithTag);
  const enc = base64UrlEncode(cipherArr.slice(0, cipherArr.length - 16));
  const tag = base64UrlEncode(cipherArr.slice(cipherArr.length - 16));
  return { enc, iv: base64UrlEncode(iv), tag };
}

// AES-256-GCM decrypt. Takes { enc, iv, tag } base64url strings + keyHex.
async function gcalDecryptToken(
  enc: string,
  iv: string,
  tag: string,
  keyHex: string,
): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const encBytes = base64UrlDecode(enc);
  const tagBytes = base64UrlDecode(tag);
  const ivBytes = base64UrlDecode(iv);
  // Web Crypto expects ciphertext + tag concatenated
  const cipherBuf = new ArrayBuffer(encBytes.length + tagBytes.length);
  const cipherWithTag = new Uint8Array(cipherBuf);
  cipherWithTag.set(encBytes);
  cipherWithTag.set(tagBytes, encBytes.length);
  const ivBuf = new ArrayBuffer(ivBytes.length);
  new Uint8Array(ivBuf).set(ivBytes);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf, tagLength: 128 },
    cryptoKey,
    cipherBuf,
  );
  return new TextDecoder().decode(plainBuf);
}

// Get the right key hex for a given keyVersion, falling back to PREV during rotation.
function gcalGetKeyForVersion(version: number, env: Env): string {
  const current = gcalCurrentKeyVersion(env);
  if (version === current) {
    return env.GCAL_TOKEN_ENC_KEY;
  }
  if (env.GCAL_TOKEN_ENC_KEY_PREV) {
    return env.GCAL_TOKEN_ENC_KEY_PREV;
  }
  throw new Error(`No key available for version ${version}`);
}

// Get the current key version number (from env.GCAL_KEY_VERSION, default 1).
function gcalCurrentKeyVersion(env: Env): number {
  const v = parseInt(env.GCAL_KEY_VERSION ?? "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// --- NIP-01 auth verification helper -----------------------------------------

// Minimal bech32 decode for npub (no checksum verification — sufficient for auth use)
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Decode(str: string): { hrp: string; data: Uint8Array } | null {
  const s = str.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const dataPart = s.slice(sep + 1);
  // Decode 5-bit words (strip 6-char checksum suffix)
  const words: number[] = [];
  for (let i = 0; i < dataPart.length - 6; i++) {
    const idx = BECH32_CHARSET.indexOf(dataPart[i]);
    if (idx < 0) return null;
    words.push(idx);
  }
  // Convert 5-bit groups → 8-bit bytes
  let acc = 0, bits = 0;
  const bytes: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, data: new Uint8Array(bytes) };
}

// Accept either raw 64-hex pubkey or bech32 "npub1…" string → lowercase hex
function npubToHex(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  const decoded = bech32Decode(trimmed);
  if (!decoded || decoded.hrp !== "npub" || decoded.data.length !== 32) return null;
  return [...decoded.data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// NIP-01 Schnorr request authentication
// Headers: X-Taskify-Npub, X-Taskify-Timestamp, X-Taskify-Sig
// Sig is a hex Schnorr signature over SHA-256(timestamp + "." + body)
// GET requests use empty string as body.
async function verifyGcalAuth(request: Request): Promise<{ npub: string } | null> {
  const npubHeader = request.headers.get("X-Taskify-Npub");
  const tsHeader = request.headers.get("X-Taskify-Timestamp");
  const sigHeader = request.headers.get("X-Taskify-Sig");

  if (!npubHeader || !tsHeader || !sigHeader) return null;

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return null;

  const pubkeyHex = npubToHex(npubHeader);
  if (!pubkeyHex) return null;

  // Compute signing payload: SHA-256(timestamp + "." + body)
  const body = await request.clone().text();
  const payload = `${ts}.${body}`;
  const msgHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const msgHash = new Uint8Array(msgHashBuf);

  try {
    const valid = schnorr.verify(hexToBytes(sigHeader), msgHash, hexToBytes(pubkeyHex));
    if (!valid) return null;
  } catch {
    return null;
  }

  return { npub: pubkeyHex };
}

// --- ensureGcalSchema --------------------------------------------------------

async function ensureGcalSchema(env: Env): Promise<void> {
  const db = requireDb(env);

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_connections (
       npub              TEXT    PRIMARY KEY,
       google_email      TEXT    NOT NULL,
       access_token_enc  TEXT    NOT NULL,
       access_token_iv   TEXT    NOT NULL,
       access_token_tag  TEXT    NOT NULL,
       refresh_token_enc TEXT    NOT NULL,
       refresh_token_iv  TEXT    NOT NULL,
       refresh_token_tag TEXT    NOT NULL,
       token_expiry      INTEGER NOT NULL,
       key_version       INTEGER NOT NULL DEFAULT 1,
       status            TEXT    NOT NULL DEFAULT 'active',
       last_sync_at      INTEGER,
       last_error        TEXT,
       created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_calendars (
       id               TEXT    PRIMARY KEY,
       npub             TEXT    NOT NULL,
       provider_cal_id  TEXT    NOT NULL,
       name             TEXT    NOT NULL,
       primary_cal      INTEGER NOT NULL DEFAULT 0,
       selected         INTEGER NOT NULL DEFAULT 1,
       color            TEXT,
       timezone         TEXT,
       sync_token       TEXT,
       watch_channel_id TEXT,
       watch_expiry     INTEGER,
       created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
       FOREIGN KEY (npub) REFERENCES gcal_connections(npub) ON DELETE CASCADE,
       UNIQUE (npub, provider_cal_id)
     )`,
  ).run();

  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_npub ON gcal_calendars(npub)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_watch ON gcal_calendars(watch_channel_id)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_watch_expiry ON gcal_calendars(watch_expiry)`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_events (
       id                TEXT    PRIMARY KEY,
       npub              TEXT    NOT NULL,
       calendar_id       TEXT    NOT NULL,
       provider_event_id TEXT    NOT NULL,
       title             TEXT    NOT NULL DEFAULT '',
       description       TEXT,
       location          TEXT,
       start_iso         TEXT    NOT NULL,
       end_iso           TEXT    NOT NULL,
       all_day           INTEGER NOT NULL DEFAULT 0,
       status            TEXT    NOT NULL DEFAULT 'confirmed',
       html_link         TEXT,
       created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       FOREIGN KEY (calendar_id) REFERENCES gcal_calendars(id) ON DELETE CASCADE,
       UNIQUE (npub, calendar_id, provider_event_id)
     )`,
  ).run();

  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_npub ON gcal_events(npub)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_calendar ON gcal_events(calendar_id)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_start ON gcal_events(npub, start_iso)`,
  ).run();
}

// --- GCal DB row types -------------------------------------------------------

type GcalConnectionRow = {
  npub: string;
  google_email: string;
  access_token_enc: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token_enc: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  token_expiry: number;
  key_version: number;
  status: string;
  last_sync_at: number | null;
  last_error: string | null;
};

type GcalCalendarRow = {
  id: string;
  npub: string;
  provider_cal_id: string;
  name: string;
  primary_cal: number;
  selected: number;
  color: string | null;
  timezone: string | null;
  sync_token: string | null;
  watch_channel_id: string | null;
  watch_expiry: number | null;
};

type GcalEventRow = {
  id: string;
  npub: string;
  calendar_id: string;
  provider_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_iso: string;
  end_iso: string;
  all_day: number;
  status: string;
  html_link: string | null;
  calendar_name?: string | null;
  calendar_color?: string | null;
};

// --- Token helpers -----------------------------------------------------------

async function gcalDecryptAccessToken(row: GcalConnectionRow, env: Env): Promise<string> {
  const keyHex = gcalGetKeyForVersion(row.key_version, env);
  return gcalDecryptToken(row.access_token_enc, row.access_token_iv, row.access_token_tag, keyHex);
}

async function gcalDecryptRefreshToken(row: GcalConnectionRow, env: Env): Promise<string> {
  const keyHex = gcalGetKeyForVersion(row.key_version, env);
  return gcalDecryptToken(row.refresh_token_enc, row.refresh_token_iv, row.refresh_token_tag, keyHex);
}

// --- refreshGcalTokenIfNeeded ------------------------------------------------

async function refreshGcalTokenIfNeeded(npub: string, env: Env): Promise<string> {
  const db = requireDb(env);
  const row = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(npub)
    .first<GcalConnectionRow>();
  if (!row) throw new Error("No GCal connection for npub");

  const nowSec = Math.floor(Date.now() / 1000);
  if (row.token_expiry > nowSec + 300) {
    return gcalDecryptAccessToken(row, env);
  }

  // Need to refresh
  const refreshToken = await gcalDecryptRefreshToken(row, env);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GCAL_CLIENT_ID,
      client_secret: env.GCAL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (resp.status === 400 || resp.status === 401) {
    await db
      .prepare(`UPDATE gcal_connections SET status = 'needs_reauth', updated_at = ? WHERE npub = ?`)
      .bind(nowSec, npub)
      .run();
    throw new Error("GCal token refresh failed: needs_reauth");
  }

  if (!resp.ok) {
    throw new Error(`GCal token refresh failed: HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  const keyVersion = gcalCurrentKeyVersion(env);
  const keyHex = env.GCAL_TOKEN_ENC_KEY;
  const encAcc = await gcalEncryptToken(data.access_token, keyHex);
  const newExpiry = nowSec + (data.expires_in ?? 3600);

  await db
    .prepare(
      `UPDATE gcal_connections
         SET access_token_enc = ?, access_token_iv = ?, access_token_tag = ?,
             token_expiry = ?, key_version = ?, status = 'active', updated_at = ?
       WHERE npub = ?`,
    )
    .bind(
      encAcc.enc, encAcc.iv, encAcc.tag,
      newExpiry, keyVersion, nowSec,
      npub,
    )
    .run();

  return data.access_token;
}

// --- registerGcalWatch -------------------------------------------------------

async function registerGcalWatch(
  npub: string,
  calendarId: string,
  providerCalId: string,
  accessToken: string,
  env: Env,
): Promise<void> {
  const db = requireDb(env);
  const channelId = crypto.randomUUID();
  const webhookAddress = `https://taskify.solife.me/api/gcal/webhook/${channelId}`;

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events/watch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookAddress,
        token: env.GCAL_WEBHOOK_SECRET,
      }),
    },
  );

  if (!resp.ok) {
    console.warn("registerGcalWatch failed", { calendarId, status: resp.status });
    return;
  }

  const data = (await resp.json()) as { expiration?: string };
  const watchExpiry = data.expiration ? Math.floor(Number(data.expiration) / 1000) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `UPDATE gcal_calendars
         SET watch_channel_id = ?, watch_expiry = ?, updated_at = ?
       WHERE id = ? AND npub = ?`,
    )
    .bind(channelId, watchExpiry, nowSec, calendarId, npub)
    .run();
}

// --- syncCalendarEvents ------------------------------------------------------

async function syncCalendarEvents(
  npub: string,
  calendarId: string,
  accessToken: string,
  env: Env,
): Promise<void> {
  const db = requireDb(env);

  // Verify calendar belongs to this npub (critical security check)
  const calRow = await db
    .prepare<GcalCalendarRow>(`SELECT * FROM gcal_calendars WHERE id = ? AND npub = ?`)
    .bind(calendarId, npub)
    .first<GcalCalendarRow>();
  if (!calRow) throw new Error(`Calendar ${calendarId} not found for npub`);

  const providerCalId = calRow.provider_cal_id;
  const nowSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = new Date((nowSec - 7 * 86400) * 1000).toISOString();
  const sixMonthsAhead = new Date((nowSec + 180 * 86400) * 1000).toISOString();

  let pageToken: string | undefined;
  let syncToken: string | undefined;

  const doSync = async (url: string): Promise<void> => {
    let nextPageToken: string | undefined;
    do {
      const fetchUrl = nextPageToken ? `${url}&pageToken=${encodeURIComponent(nextPageToken)}` : url;
      const resp = await fetch(fetchUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (resp.status === 410) {
        // Sync token expired — clear it and do full re-fetch
        await db
          .prepare(`UPDATE gcal_calendars SET sync_token = NULL, updated_at = ? WHERE id = ? AND npub = ?`)
          .bind(nowSec, calendarId, npub)
          .run();
        const fullUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?timeMin=${encodeURIComponent(sevenDaysAgo)}&timeMax=${encodeURIComponent(sixMonthsAhead)}&singleEvents=true`;
        await doSync(fullUrl);
        return;
      }

      if (!resp.ok) {
        throw new Error(`GCal events fetch failed: HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as {
        items?: GoogleCalendarEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };

      for (const item of data.items ?? []) {
        await upsertGcalEvent(npub, calendarId, item, db);
      }

      nextPageToken = data.nextPageToken;
      syncToken = data.nextSyncToken ?? syncToken;
    } while (nextPageToken);
  };

  let baseUrl: string;
  if (calRow.sync_token) {
    baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?syncToken=${encodeURIComponent(calRow.sync_token)}`;
  } else {
    baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?timeMin=${encodeURIComponent(sevenDaysAgo)}&timeMax=${encodeURIComponent(sixMonthsAhead)}&singleEvents=true`;
  }

  await doSync(baseUrl);

  if (syncToken) {
    await db
      .prepare(`UPDATE gcal_calendars SET sync_token = ?, updated_at = ? WHERE id = ? AND npub = ?`)
      .bind(syncToken, nowSec, calendarId, npub)
      .run();
  }

  void pageToken; // suppress unused var warning
}

type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  htmlLink?: string;
};

async function upsertGcalEvent(
  npub: string,
  calendarId: string,
  item: GoogleCalendarEvent,
  db: D1Database,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const allDay = !item.start?.dateTime ? 1 : 0;
  const startIso = item.start?.dateTime ?? item.start?.date ?? "";
  const endIso = item.end?.dateTime ?? item.end?.date ?? "";
  const eventId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO gcal_events
         (id, npub, calendar_id, provider_event_id, title, description, location,
          start_iso, end_iso, all_day, status, html_link, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (npub, calendar_id, provider_event_id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         location = excluded.location,
         start_iso = excluded.start_iso,
         end_iso = excluded.end_iso,
         all_day = excluded.all_day,
         status = excluded.status,
         html_link = excluded.html_link,
         updated_at = excluded.updated_at`,
    )
    .bind(
      eventId, npub, calendarId, item.id ?? "",
      item.summary ?? "", item.description ?? null, item.location ?? null,
      startIso, endIso, allDay,
      item.status ?? "confirmed", item.htmlLink ?? null,
      nowSec, nowSec,
    )
    .run();
}

// --- fetchAndSyncCalendars ---------------------------------------------------

async function fetchAndSyncCalendars(npub: string, accessToken: string, env: Env): Promise<void> {
  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);

  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`GCal calendarList fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      primary?: boolean;
      backgroundColor?: string;
      timeZone?: string;
    }>;
  };

  for (const cal of data.items ?? []) {
    const calId = crypto.randomUUID();

    await db
      .prepare(
        `INSERT INTO gcal_calendars
           (id, npub, provider_cal_id, name, primary_cal, selected, color, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (npub, provider_cal_id) DO UPDATE SET
           name = excluded.name,
           primary_cal = excluded.primary_cal,
           color = excluded.color,
           timezone = excluded.timezone,
           updated_at = excluded.updated_at`,
      )
      .bind(
        calId, npub, cal.id,
        cal.summary ?? cal.id,
        cal.primary ? 1 : 0,
        1, // default selected
        cal.backgroundColor ?? null,
        cal.timeZone ?? null,
        nowSec, nowSec,
      )
      .run();

    // Fetch the actual calendar row to get its id (may differ from calId on conflict)
    const calRow = await db
      .prepare<GcalCalendarRow>(`SELECT * FROM gcal_calendars WHERE npub = ? AND provider_cal_id = ?`)
      .bind(npub, cal.id)
      .first<GcalCalendarRow>();
    if (!calRow) continue;

    try {
      await registerGcalWatch(npub, calRow.id, cal.id, accessToken, env);
    } catch (err) {
      console.warn("registerGcalWatch error", { calendarId: calRow.id, error: (err as Error).message });
    }

    try {
      await syncCalendarEvents(npub, calRow.id, accessToken, env);
    } catch (err) {
      console.warn("syncCalendarEvents error", { calendarId: calRow.id, error: (err as Error).message });
    }
  }

  await db
    .prepare(`UPDATE gcal_connections SET last_sync_at = ?, updated_at = ? WHERE npub = ?`)
    .bind(nowSec, nowSec, npub)
    .run();
}

// --- Route handlers ----------------------------------------------------------

async function handleGcalAuthUrl(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const state = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ npub: auth.npub })));
  const params = new URLSearchParams({
    client_id: env.GCAL_CLIENT_ID,
    redirect_uri: "https://taskify.solife.me/api/gcal/auth/callback",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return jsonResponse({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}

async function handleGcalAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return new Response("Missing code or state", { status: 400 });
  }

  let npub: string;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(stateRaw)));
    npub = decoded.npub;
    if (!npub) throw new Error("no npub");
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GCAL_CLIENT_ID,
      client_secret: env.GCAL_CLIENT_SECRET,
      redirect_uri: "https://taskify.solife.me/api/gcal/auth/callback",
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return new Response("Token exchange failed", { status: 502 });
  }
  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    return new Response("Incomplete token response", { status: 502 });
  }

  // Get Google email
  const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userResp.ok) {
    return new Response("Failed to get userinfo", { status: 502 });
  }
  const userInfo = (await userResp.json()) as { email?: string };
  const googleEmail = userInfo.email ?? "";

  const nowSec = Math.floor(Date.now() / 1000);
  const keyVersion = gcalCurrentKeyVersion(env);
  const keyHex = env.GCAL_TOKEN_ENC_KEY;

  const encAcc = await gcalEncryptToken(tokens.access_token, keyHex);
  const encRef = await gcalEncryptToken(tokens.refresh_token, keyHex);
  const tokenExpiry = nowSec + (tokens.expires_in ?? 3600);

  const db = requireDb(env);
  await db
    .prepare(
      `INSERT INTO gcal_connections
         (npub, google_email,
          access_token_enc, access_token_iv, access_token_tag,
          refresh_token_enc, refresh_token_iv, refresh_token_tag,
          token_expiry, key_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (npub) DO UPDATE SET
         google_email = excluded.google_email,
         access_token_enc = excluded.access_token_enc,
         access_token_iv = excluded.access_token_iv,
         access_token_tag = excluded.access_token_tag,
         refresh_token_enc = excluded.refresh_token_enc,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_tag = excluded.refresh_token_tag,
         token_expiry = excluded.token_expiry,
         key_version = excluded.key_version,
         status = 'active',
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      npub, googleEmail,
      encAcc.enc, encAcc.iv, encAcc.tag,
      encRef.enc, encRef.iv, encRef.tag,
      tokenExpiry, keyVersion,
      nowSec, nowSec,
    )
    .run();

  // Initial calendar sync (best-effort)
  try {
    await fetchAndSyncCalendars(npub, tokens.access_token, env);
  } catch (err) {
    console.error("Initial GCal sync error", (err as Error).message);
    await db
      .prepare(`UPDATE gcal_connections SET status = 'sync_failed', last_error = ?, updated_at = ? WHERE npub = ?`)
      .bind((err as Error).message, Math.floor(Date.now() / 1000), npub)
      .run();
  }

  return Response.redirect("https://taskify.solife.me?gcal=connected", 302);
}

async function handleGcalDisconnect(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  // CASCADE in schema removes gcal_calendars + gcal_events
  await db
    .prepare(`DELETE FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .run();

  return jsonResponse({ ok: true });
}

async function handleGcalStatus(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const row = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .first<GcalConnectionRow>();

  if (!row) {
    return jsonResponse({ connected: false, status: null, googleEmail: null, lastSyncAt: null, lastError: null });
  }

  return jsonResponse({
    connected: true,
    status: row.status,
    googleEmail: row.google_email,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  });
}

async function handleGcalCalendars(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const result = await db
    .prepare<GcalCalendarRow>(
      `SELECT id, name, primary_cal, selected, color, timezone
         FROM gcal_calendars WHERE npub = ? ORDER BY primary_cal DESC, name ASC`,
    )
    .bind(auth.npub)
    .all<GcalCalendarRow>();

  const calendars = (result.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    primary_cal: r.primary_cal === 1,
    selected: r.selected === 1,
    color: r.color,
    timezone: r.timezone,
  }));

  return jsonResponse(calendars);
}

async function handleGcalToggleCalendar(
  request: Request,
  env: Env,
  calendarId: string,
): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const body = await parseJson(request);
  if (typeof body?.selected !== "boolean") {
    return jsonResponse({ error: "selected (boolean) is required" }, 400);
  }

  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);
  // npub scope is mandatory — never just WHERE id = ?
  await db
    .prepare(
      `UPDATE gcal_calendars SET selected = ?, updated_at = ? WHERE id = ? AND npub = ?`,
    )
    .bind(body.selected ? 1 : 0, nowSec, calendarId, auth.npub)
    .run();

  return jsonResponse({ ok: true });
}

async function handleGcalEvents(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const nowSec = Math.floor(Date.now() / 1000);
  const defaultFrom = new Date((nowSec - 7 * 86400) * 1000).toISOString();
  const defaultTo = new Date((nowSec + 180 * 86400) * 1000).toISOString();
  const from = url.searchParams.get("from") ?? defaultFrom;
  const to = url.searchParams.get("to") ?? defaultTo;

  const db = requireDb(env);
  // All WHERE clauses include npub = ? — no cross-user leakage possible
  const result = await db
    .prepare<GcalEventRow>(
      `SELECT e.id, e.npub, e.calendar_id, e.provider_event_id,
              e.title, e.description, e.location,
              e.start_iso, e.end_iso, e.all_day, e.status, e.html_link,
              c.name AS calendar_name, c.color AS calendar_color
         FROM gcal_events e
         JOIN gcal_calendars c ON c.id = e.calendar_id AND c.npub = e.npub
        WHERE e.npub = ?
          AND e.start_iso >= ?
          AND e.start_iso <= ?
          AND e.status != 'cancelled'
        ORDER BY e.start_iso ASC`,
    )
    .bind(auth.npub, from, to)
    .all<GcalEventRow>();

  const events = (result.results ?? []).map((r) => ({
    id: r.id,
    calendarId: r.calendar_id,
    providerEventId: r.provider_event_id,
    calendarName: r.calendar_name ?? r.calendar_id,
    calendarColor: r.calendar_color ?? undefined,
    title: r.title,
    description: r.description,
    location: r.location,
    startISO: r.start_iso,
    endISO: r.end_iso,
    allDay: r.all_day === 1,
    status: r.status,
    htmlLink: r.html_link,
    source: "google" as const,
    kind: "calendar_event" as const,
  }));

  return jsonResponse(events);
}

async function handleGcalSync(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const conn = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .first<GcalConnectionRow>();

  if (!conn) return jsonResponse({ error: "Not connected" }, 404);

  let accessToken: string;
  try {
    accessToken = await refreshGcalTokenIfNeeded(auth.npub, env);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502);
  }

  const calendarsResult = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE npub = ?`,
    )
    .bind(auth.npub)
    .all<GcalCalendarRow>();

  let synced = 0;
  const errors: string[] = [];

  for (const cal of calendarsResult.results ?? []) {
    try {
      await syncCalendarEvents(auth.npub, cal.id, accessToken, env);
      synced++;
    } catch (err) {
      errors.push(`${cal.name}: ${(err as Error).message}`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await db
    .prepare(`UPDATE gcal_connections SET last_sync_at = ?, updated_at = ? WHERE npub = ?`)
    .bind(nowSec, nowSec, auth.npub)
    .run();

  return jsonResponse({ synced, errors });
}

async function handleGcalWebhook(
  request: Request,
  env: Env,
  channelId: string,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  // Validate secret before any DB lookup
  const channelToken = request.headers.get("X-Goog-Channel-Token");
  if (channelToken !== env.GCAL_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = requireDb(env);
  const calRow = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE watch_channel_id = ?`,
    )
    .bind(channelId)
    .first<GcalCalendarRow>();

  if (!calRow) return new Response("Not Found", { status: 404 });

  ctx.waitUntil(
    (async () => {
      try {
        const accessToken = await refreshGcalTokenIfNeeded(calRow.npub, env);
        await syncCalendarEvents(calRow.npub, calRow.id, accessToken, env);
      } catch (err) {
        console.error("Webhook sync error", { channelId, error: (err as Error).message });
      }
    })(),
  );

  return new Response(null, { status: 200 });
}

// --- Cron helpers ------------------------------------------------------------

async function gcalRenewExpiredWatches(env: Env): Promise<void> {
  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE watch_expiry < ? OR watch_expiry IS NULL`,
    )
    .bind(nowSec + 86400)
    .all<GcalCalendarRow>();

  for (const cal of result.results ?? []) {
    try {
      const accessToken = await refreshGcalTokenIfNeeded(cal.npub, env);
      await registerGcalWatch(cal.npub, cal.id, cal.provider_cal_id, accessToken, env);
    } catch (err) {
      console.error("gcalRenewExpiredWatches error", { calId: cal.id, error: (err as Error).message });
    }
  }
}

async function gcalRetryFailedSyncs(env: Env): Promise<void> {
  const db = requireDb(env);

  const result = await db
    .prepare<GcalConnectionRow>(
      `SELECT * FROM gcal_connections WHERE status = 'sync_failed'`,
    )
    .all<GcalConnectionRow>();

  for (const conn of result.results ?? []) {
    try {
      const accessToken = await refreshGcalTokenIfNeeded(conn.npub, env);
      await fetchAndSyncCalendars(conn.npub, accessToken, env);
      await db
        .prepare(`UPDATE gcal_connections SET status = 'active', last_error = NULL, updated_at = ? WHERE npub = ?`)
        .bind(Math.floor(Date.now() / 1000), conn.npub)
        .run();
    } catch (err) {
      console.error("gcalRetryFailedSyncs error", { npub: conn.npub, error: (err as Error).message });
      await db
        .prepare(`UPDATE gcal_connections SET last_error = ?, updated_at = ? WHERE npub = ?`)
        .bind((err as Error).message, Math.floor(Date.now() / 1000), conn.npub)
        .run();
    }
  }
}

// Named exports for unit testing
export { gcalEncryptToken, gcalDecryptToken, verifyGcalAuth };
