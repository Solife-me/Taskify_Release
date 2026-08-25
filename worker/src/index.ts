/* eslint-disable no-console */
import { handlePreviewProxy } from "./preview.ts";
import { handleVoiceExtract, handleVoiceFinalize } from "./voice.ts";
import {
  handleRegisterDevice,
  handleDeleteDevice,
  handleSaveReminders,
  handlePollReminders,
  processDueReminders,
} from "./reminders.ts";
import { handleNip05Lookup } from "./nip05.ts";
import { handleWatchNostrPublish, handleWatchNostrQuery } from "./nostr-bridge.ts";
import type { Env } from "./lib.ts";
import { enforceRateLimit, jsonResponse, requireDb } from "./lib.ts";
// Keep the shared library exports available to existing Worker-side consumers.
export type { Env, D1Database } from "./lib.ts";
export {
  JSON_HEADERS,
  requireDb,
  jsonResponse,
  parseJson,
  base64UrlEncode,
  base64UrlDecode,
} from "./lib.ts";

let schemaReadyPromise: Promise<void> | null = null;

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
  })()
    .catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });

  schemaReadyPromise = ready;
  return ready;
}

function routeUsesDatabase(pathname: string): boolean {
  return pathname === "/api/devices"
    || pathname.startsWith("/api/devices/")
    || pathname === "/api/reminders"
    || pathname === "/api/reminders/poll"
    || pathname.startsWith("/api/voice/");
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface SchedulerController {
  waitUntil(promise: Promise<unknown>): void;
}

const ASSET_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Static assets are served through the worker so these headers are
// guaranteed — a `_headers` file is not reliably applied to env.ASSETS.
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(ASSET_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (new URL(request.url).pathname === "/sw.js") {
    // The service worker must revalidate so app updates reach users.
    response.headers.set("Cache-Control", "no-cache");
    response.headers.set("Service-Worker-Allowed", "/");
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Taskify-Subscription,X-Taskify-Npub,X-Taskify-Timestamp,X-Taskify-Sig",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    try {
      // Static assets, config, link previews, and NIP-05 lookups do not touch
      // D1. Avoid running schema DDL on those hot paths and on static assets.
      if (routeUsesDatabase(url.pathname)) {
        await ensureSchema(env);
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return jsonResponse({
          workerBaseUrl: url.origin,
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
        });
      }
      if (url.pathname === "/api/preview" && request.method === "GET") {
        const limited = await enforceRateLimit(request, env.PREVIEW_RATE_LIMITER, "preview");
        if (limited) return limited;
        return await handlePreviewProxy(url);
      }
      if (url.pathname === "/api/nip05" && request.method === "GET") {
        const limited = await enforceRateLimit(request, env.NIP05_RATE_LIMITER, "nip05");
        if (limited) return limited;
        return await handleNip05Lookup(url);
      }
      if (url.pathname === "/api/devices" && request.method === "PUT") {
        return await handleRegisterDevice(request, env);
      }
      if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
        const deviceId = decodeURIComponent(url.pathname.substring("/api/devices/".length));
        return await handleDeleteDevice(request, deviceId, env);
      }
      if (url.pathname === "/api/reminders" && request.method === "PUT") {
        return await handleSaveReminders(request, env);
      }
      if (url.pathname === "/api/reminders/poll" && request.method === "POST") {
        return await handlePollReminders(request, env);
      }
      if (url.pathname === "/api/voice/extract" && request.method === "POST") {
        return await handleVoiceExtract(request, env);
      }
      if (url.pathname === "/api/voice/finalize" && request.method === "POST") {
        return await handleVoiceFinalize(request, env);
      }
      if (url.pathname === "/api/watch/nostr/publish" && request.method === "POST") {
        return await handleWatchNostrPublish(request);
      }
      if (url.pathname === "/api/watch/nostr/query" && request.method === "POST") {
        return await handleWatchNostrQuery(request);
      }
    } catch (err) {
      console.error("Worker error", err);
      return jsonResponse({ error: (err as Error).message || "Internal error" }, 500);
    }

    // Do not serve the PWA shell for removed or misspelled API routes.
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    return serveAsset(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: SchedulerController): Promise<void> {
    const runner = async () => {
      try {
        await ensureSchema(env);
        await processDueReminders(env);
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

export { normalizeNostrPublicKey, verifyTaskifyAuth } from "./nostr-auth.ts";
