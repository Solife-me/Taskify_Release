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
import { enforceRateLimit, jsonResponse, readBodyWithin, requireDb, withBodyWithin } from "./lib.ts";

// A lookup's input sent in the body: a URL or address, never more than this.
const MAX_LOOKUP_BODY_BYTES = 8 * 1024;

/**
 * The lookup input as the handlers read it, from a POST body or (for builds before C13-8) the
 * query string. Taken from the body, the link or name never appears in a logged request URL; the
 * URL built here is internal only.
 */
async function lookupInput(request: Request, url: URL, field: string): Promise<URL | Response> {
  if (request.method === "GET") return url;
  const bytes = await readBodyWithin(request, MAX_LOOKUP_BODY_BYTES);
  if (!bytes) return jsonResponse({ error: "Request body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string") return jsonResponse({ error: "Bad request" }, 400);
  const internal = new URL(url.origin + url.pathname);
  internal.searchParams.set(field, value);
  return internal;
}

// The Watch bridge verifies a signature over the whole body, so the body is bounded first.
const MAX_WATCH_BRIDGE_BODY_BYTES = 256 * 1024;
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

// Rows kept only as long as they are useful: daily voice and write-budget counters for a week,
// reminder notifications a device never fetched for two weeks, and used request signatures until
// expiry.
const VOICE_QUOTA_RETENTION_DAYS = 7;
const PENDING_NOTIFICATION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_MINUTE = 17;

export async function pruneStaleRows(env: Env, now = Date.now()): Promise<void> {
  const db = requireDb(env);
  const quotaCutoff = new Date(now - VOICE_QUOTA_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM voice_quota WHERE date < ?").bind(quotaCutoff),
    db.prepare("DELETE FROM write_budget WHERE date < ?").bind(quotaCutoff),
    db.prepare("DELETE FROM pending_notifications WHERE created_at < ?").bind(now - PENDING_NOTIFICATION_RETENTION_MS),
    db.prepare("DELETE FROM request_signatures WHERE expires_at < ?").bind(now),
  ]);
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface SchedulerController {
  waitUntil(promise: Promise<unknown>): void;
}

// Keep in step with taskify-pwa/public/_headers. Cloudflare serves any request that matches a
// static asset without running the Worker, so that file is what real asset responses carry;
// this copy covers the responses the Worker itself builds from env.ASSETS (non-matching paths).
// The PWA's scanners and dictation need the camera and microphone for its own origin.
const ASSET_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  // Scripts only from this origin: the page holds the Nostr key, the wallet, and the device key
  // that decrypts them. Connections and media stay open because relays, mints, file hosts, and
  // pictures are user-chosen. Keep in step with taskify-pwa/public/_headers.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob: https: wss:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

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
  async fetch(request: Request, env: Env, ctx?: SchedulerController): Promise<Response> {
    if (request.method === "OPTIONS") {
      // Same-origin only (see JSON_HEADERS); a cross-origin preflight gets no CORS grant.
      return new Response(null, { status: 204 });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        return jsonResponse({
          workerBaseUrl: url.origin,
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
        });
      }
      if (url.pathname === "/api/preview" && (request.method === "POST" || request.method === "GET")) {
        const limited = await enforceRateLimit(request, env.PREVIEW_RATE_LIMITER, "preview");
        if (limited) return limited;
        const input = await lookupInput(request, url, "url");
        if (input instanceof Response) return input;
        return await handlePreviewProxy(input);
      }
      if (url.pathname === "/api/nip05" && (request.method === "POST" || request.method === "GET")) {
        const limited = await enforceRateLimit(request, env.NIP05_RATE_LIMITER, "nip05");
        if (limited) return limited;
        const input = await lookupInput(request, url, "address");
        if (input instanceof Response) return input;
        return await handleNip05Lookup(input, ctx);
      }
      if (url.pathname === "/api/devices" && request.method === "PUT") {
        const limited = await enforceRateLimit(request, env.PUSH_RATE_LIMITER, "push");
        if (limited) return limited;
        return await handleRegisterDevice(request, env);
      }
      if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
        const limited = await enforceRateLimit(request, env.PUSH_RATE_LIMITER, "push");
        if (limited) return limited;
        const deviceId = decodeURIComponent(url.pathname.substring("/api/devices/".length));
        return await handleDeleteDevice(request, deviceId, env);
      }
      if (url.pathname === "/api/reminders" && request.method === "PUT") {
        const limited = await enforceRateLimit(request, env.PUSH_RATE_LIMITER, "push");
        if (limited) return limited;
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
        const bounded = await withBodyWithin(request, MAX_WATCH_BRIDGE_BODY_BYTES);
        if (bounded instanceof Response) return bounded;
        return await handleWatchNostrPublish(bounded, env);
      }
      if (url.pathname === "/api/watch/nostr/query" && request.method === "POST") {
        const bounded = await withBodyWithin(request, MAX_WATCH_BRIDGE_BODY_BYTES);
        if (bounded instanceof Response) return bounded;
        return await handleWatchNostrQuery(bounded, env);
      }
    } catch (err) {
      // Malformed percent-encoding in a path is the caller's mistake, not a server fault.
      if (err instanceof URIError) return jsonResponse({ error: "Bad request" }, 400);
      // Internal detail (database errors, binding names) stays in the log, not the response.
      console.error("Worker error", err);
      return jsonResponse({ error: "Internal error" }, 500);
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
        await processDueReminders(env);
        // Once an hour is plenty, and keeps the other 59 ticks to their own work.
        if (new Date().getUTCMinutes() === PRUNE_MINUTE) await pruneStaleRows(env);
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
