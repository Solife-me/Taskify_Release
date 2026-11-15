import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { verifyTaskifyAuth, type ReplayStore } from "./nostr-auth.ts";
import { jsonResponse, parseJson, unboundLimiter } from "./lib.ts";
import { assertPublicHttpUrl } from "./public-fetch.ts";

const TASK_KIND = 30_301;
const BOARD_KIND = 30_300;
const MAX_RELAYS = 8;
const MAX_AUTHORS = 128;
const MAX_EVENTS = 1_000;
const RELAY_TIMEOUT_MS = 5_000;
// A relay frame larger than this is ignored unread; a whole task event is far smaller.
const MAX_RELAY_FRAME_CHARS = 256 * 1024;

type RelayResult = { relay: string; accepted: boolean; message?: string };
type NostrFilter = {
  kinds: number[];
  authors: string[];
  limit: number;
  since?: number;
  until?: number;
  "#b"?: string[];
};

function normalizedRelayURLs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    try {
      const url = new URL(raw.trim());
      // The deployed bridge must never become an internal-network WebSocket proxy.
      if (url.protocol !== "wss:" || !url.hostname || url.username || url.password) continue;
      // Same public-host rules as the preview and NIP-05 fetchers: no localhost, local or
      // internal names, or private, link-local, or mapped addresses.
      try {
        assertPublicHttpUrl(url.href.replace(/^wss:/i, "https:"));
      } catch {
        continue;
      }
      url.hash = "";
      const normalized = url.toString().replace(/\/$/, "");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        output.push(normalized);
      }
      if (output.length === MAX_RELAYS) break;
    } catch {
      // Ignore malformed relay values.
    }
  }
  return output;
}

function validTaskEvent(value: unknown, includeBoard = false): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as NostrEvent;
  return (event.kind === TASK_KIND || (includeBoard && event.kind === BOARD_KIND))
    && typeof event.id === "string"
    && typeof event.pubkey === "string"
    && Array.isArray(event.tags)
    && event.tags.some((tag) => Array.isArray(tag) && tag[0] === "d" && typeof tag[1] === "string")
    && event.tags.some((tag) => Array.isArray(tag) && tag[0] === "b" && typeof tag[1] === "string")
    && verifyEvent(event);
}

function normalizedFilter(value: unknown): NostrFilter | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const authors = Array.isArray(raw.authors)
    ? raw.authors.filter((author): author is string => typeof author === "string" && /^[0-9a-f]{64}$/i.test(author))
    : [];
  if (!authors.length) return null;
  return {
    kinds: [TASK_KIND],
    authors: [...new Set(authors.map((author) => author.toLowerCase()))].slice(0, MAX_AUTHORS),
    limit: Math.min(MAX_EVENTS, Math.max(1, Number(raw.limit) || MAX_EVENTS)),
  };
}

function normalizedHistoryFilter(value: unknown): NostrFilter | null {
  const normalized = normalizedFilter(value);
  if (!normalized || normalized.authors.length !== 1) return null;
  const raw = value as Record<string, unknown>;
  const tags = raw["#b"];
  const since = raw.since ?? 0;
  const until = raw.until;
  if (!Array.isArray(tags) || tags.length !== 1 || typeof tags[0] !== "string" || !/^[0-9a-f]{64}$/.test(tags[0])
    || typeof since !== "number" || !Number.isSafeInteger(since) || since < 0
    || typeof until !== "number" || !Number.isSafeInteger(until) || until < since
    || !Number.isInteger(normalized.limit)) return null;
  return { ...normalized, kinds: [BOARD_KIND, TASK_KIND], "#b": tags, since, until };
}

async function openRelay(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  if (socket.readyState === WebSocket.OPEN) return socket;
  return await new Promise<WebSocket>((resolve, reject) => {
    const fail = (message: string) => finish(() => {
      try { socket.close(); } catch { /* already closed or connecting */ }
      reject(new Error(message));
    });
    const timer = setTimeout(() => fail("Relay connection timed out"), RELAY_TIMEOUT_MS);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      callback();
    };
    const onOpen = () => finish(() => resolve(socket));
    const onError = () => fail("Relay connection failed");
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function publishToRelay(relay: string, event: NostrEvent): Promise<RelayResult> {
  let socket: WebSocket | null = null;
  try {
    socket = await openRelay(relay);
    const result = await new Promise<RelayResult>((resolve) => {
      const timer = setTimeout(
        () => resolve({ relay, accepted: false, message: "Relay acknowledgement timed out" }),
        RELAY_TIMEOUT_MS,
      );
      const finish = (value: RelayResult) => {
        clearTimeout(timer);
        resolve(value);
      };
      socket!.addEventListener("message", (message) => {
        try {
          const frame = JSON.parse(String(message.data));
          if (Array.isArray(frame) && frame[0] === "OK" && frame[1] === event.id) {
            finish({ relay, accepted: frame[2] === true, message: typeof frame[3] === "string" ? frame[3] : undefined });
          }
        } catch {
          // Ignore unrelated or malformed relay frames.
        }
      });
      socket!.addEventListener("close", () => finish({ relay, accepted: false, message: "Relay closed the connection" }));
      socket!.send(JSON.stringify(["EVENT", event]));
    });
    return result;
  } catch (error) {
    return { relay, accepted: false, message: error instanceof Error ? error.message : "Relay unavailable" };
  } finally {
    try { socket?.close(1000, "Taskify request complete"); } catch { /* already closed */ }
  }
}

async function queryRelay(relay: string, filter: NostrFilter, history: boolean): Promise<{ events: NostrEvent[]; completed: boolean }> {
  let socket: WebSocket | null = null;
  const events = new Map<string, NostrEvent>();
  let completed = false;
  try {
    socket = await openRelay(relay);
    const subscriptionID = `watch-${crypto.randomUUID()}`;
    await new Promise<void>((resolve) => {
      let finished = false;
      let bytes = 0;
      const timer = setTimeout(finish, RELAY_TIMEOUT_MS);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      }
      socket!.addEventListener("message", (message) => {
        if (finished) return;
        try {
          const data = String(message.data);
          bytes += data.length;
          if (bytes > 4 * 1024 * 1024) { finish(); return; }
          if (data.length > MAX_RELAY_FRAME_CHARS) return;
          const frame = JSON.parse(data);
          if (!Array.isArray(frame) || frame[1] !== subscriptionID) return;
          if (frame[0] === "EOSE") {
            completed = true;
            finish();
            return;
          }
          if (frame[0] === "CLOSED") { finish(); return; }
          if (frame[0] !== "EVENT" || !validTaskEvent(frame[2], history)) return;
          const event = frame[2];
          if (!filter.authors.includes(event.pubkey)) return;
          if (history && (event.created_at < filter.since! || event.created_at > filter.until!
            || !event.tags.some(tag => tag[0] === "b" && filter["#b"]!.includes(tag[1])))) return;
          if (!events.has(event.id) && events.size >= filter.limit) { finish(); return; }
          events.set(event.id, event);
          if (!history && events.size >= filter.limit) finish();
        } catch {
          // Ignore unrelated or malformed relay frames.
        }
      });
      socket!.addEventListener("close", finish);
      socket!.addEventListener("error", finish);
      socket!.send(JSON.stringify(["REQ", subscriptionID, filter]));
    });
    try { socket.send(JSON.stringify(["CLOSE", subscriptionID])); } catch { /* closing */ }
  } catch {
    // The caller can apply partial events and retry without advancing this source.
  } finally {
    try { socket?.close(1000, "Taskify request complete"); } catch { /* already closed */ }
  }
  return { events: [...events.values()], completed };
}

/**
 * Every account's bridge traffic reaches public relays from the Worker's shared egress IPs, where
 * relays apply per-IP limits. Bound each account's share so one busy account can't spend the
 * budget every other Watch user depends on. Keyed by the signed account, not the client IP.
 */
async function accountRateLimited(env: BridgeEnv | undefined, npub: string): Promise<Response | null> {
  const binding = env?.WATCH_NOSTR_RATE_LIMITER;
  if (!binding) return unboundLimiter("watch-nostr");
  const { success } = await binding.limit({ key: `watch-nostr:${npub}` });
  if (success) return null;
  const response = jsonResponse({ error: "Too many requests" }, 429);
  response.headers.set("Retry-After", "60");
  return response;
}

type BridgeEnv = {
  WATCH_NOSTR_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  TASKIFY_AUTH_V1?: string;
  TASKIFY_DB?: ReplayStore;
};

export async function handleWatchNostrPublish(request: Request, env?: BridgeEnv): Promise<Response> {
  // Publishing is single-use; a captured request cannot be sent again.
  const auth = await verifyTaskifyAuth(request, {
    allowV1: env?.TASKIFY_AUTH_V1 !== "off",
    replayStore: env?.TASKIFY_DB,
  });
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);
  const limited = await accountRateLimited(env, auth.npub);
  if (limited) return limited;
  const body = await parseJson(request.clone());
  const relays = normalizedRelayURLs(body?.relays);
  if (!relays.length || !validTaskEvent(body?.event)) {
    return jsonResponse({ error: "A valid signed Taskify task event and relay list are required" }, 400);
  }
  const results = await Promise.all(relays.map((relay) => publishToRelay(relay, body.event)));
  const accepted = results.filter((result) => result.accepted).length;
  return jsonResponse({ accepted, attempted: results.length, results }, accepted > 0 ? 200 : 502);
}

export async function handleWatchNostrQuery(request: Request, env?: BridgeEnv): Promise<Response> {
  // Read-only and frequent: bound to this route and 60 seconds, but not recorded, which would
  // cost a database write per Watch refresh.
  const auth = await verifyTaskifyAuth(request, { allowV1: env?.TASKIFY_AUTH_V1 !== "off" });
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);
  const limited = await accountRateLimited(env, auth.npub);
  if (limited) return limited;
  const body = await parseJson(request.clone());
  const relays = normalizedRelayURLs(body?.relays);
  const history = body?.history === true;
  const filter = history ? normalizedHistoryFilter(body?.filter) : normalizedFilter(body?.filter);
  if (!relays.length || !filter || (history && relays.length !== 1)) {
    return jsonResponse({ error: "A valid relay list and Taskify task filter are required" }, 400);
  }
  const batches = await Promise.all(relays.map((relay) => queryRelay(relay, filter, history)));
  if (history) {
    const page = batches[0];
    return jsonResponse({ historyPage: true, refreshed: page.completed, events: page.events });
  }
  const byID = new Map<string, NostrEvent>();
  for (const event of batches.flatMap(batch => batch.events)) {
    if (!byID.has(event.id)) byID.set(event.id, event);
    if (byID.size >= MAX_EVENTS) break;
  }
  return jsonResponse({ events: [...byID.values()] });
}

export const watchNostrBridgeTestHooks = {
  normalizedRelayURLs,
  normalizedFilter,
  normalizedHistoryFilter,
  validTaskEvent,
};
