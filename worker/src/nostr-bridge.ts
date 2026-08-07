import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { verifyGcalAuth } from "./gcal.ts";
import { jsonResponse, parseJson } from "./lib.ts";

const TASK_KIND = 30_301;
const MAX_RELAYS = 8;
const MAX_AUTHORS = 128;
const MAX_EVENTS = 1_000;
const RELAY_TIMEOUT_MS = 5_000;

type RelayResult = { relay: string; accepted: boolean; message?: string };
type NostrFilter = { kinds: number[]; authors: string[]; limit: number };

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
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) continue;
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

function validTaskEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as NostrEvent;
  return event.kind === TASK_KIND
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

async function openRelay(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  if (socket.readyState === WebSocket.OPEN) return socket;
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay connection timed out")), RELAY_TIMEOUT_MS);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      callback();
    };
    const onOpen = () => finish(() => resolve(socket));
    const onError = () => finish(() => reject(new Error("Relay connection failed")));
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

async function queryRelay(relay: string, filter: NostrFilter): Promise<NostrEvent[]> {
  let socket: WebSocket | null = null;
  const events: NostrEvent[] = [];
  try {
    socket = await openRelay(relay);
    const subscriptionID = `watch-${crypto.randomUUID()}`;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RELAY_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      socket!.addEventListener("message", (message) => {
        try {
          const frame = JSON.parse(String(message.data));
          if (!Array.isArray(frame)) return;
          if (frame[0] === "EVENT" && frame[1] === subscriptionID && validTaskEvent(frame[2])) {
            events.push(frame[2]);
          } else if (frame[0] === "EOSE" && frame[1] === subscriptionID) {
            finish();
          }
        } catch {
          // Ignore unrelated or malformed relay frames.
        }
      });
      socket!.addEventListener("close", finish);
      socket!.send(JSON.stringify(["REQ", subscriptionID, filter]));
    });
    try { socket.send(JSON.stringify(["CLOSE", subscriptionID])); } catch { /* closing */ }
    return events;
  } catch {
    return [];
  } finally {
    try { socket?.close(1000, "Taskify request complete"); } catch { /* already closed */ }
  }
}

export async function handleWatchNostrPublish(request: Request): Promise<Response> {
  if (!await verifyGcalAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = await parseJson(request.clone());
  const relays = normalizedRelayURLs(body?.relays);
  if (!relays.length || !validTaskEvent(body?.event)) {
    return jsonResponse({ error: "A valid signed Taskify task event and relay list are required" }, 400);
  }
  const results = await Promise.all(relays.map((relay) => publishToRelay(relay, body.event)));
  const accepted = results.filter((result) => result.accepted).length;
  return jsonResponse({ accepted, attempted: results.length, results }, accepted > 0 ? 200 : 502);
}

export async function handleWatchNostrQuery(request: Request): Promise<Response> {
  if (!await verifyGcalAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = await parseJson(request.clone());
  const relays = normalizedRelayURLs(body?.relays);
  const filter = normalizedFilter(body?.filter);
  if (!relays.length || !filter) {
    return jsonResponse({ error: "A valid relay list and Taskify task filter are required" }, 400);
  }
  const batches = await Promise.all(relays.map((relay) => queryRelay(relay, filter)));
  const byID = new Map<string, NostrEvent>();
  for (const event of batches.flat()) {
    if (!byID.has(event.id)) byID.set(event.id, event);
    if (byID.size >= MAX_EVENTS) break;
  }
  return jsonResponse({ events: [...byID.values()] });
}

export const watchNostrBridgeTestHooks = {
  normalizedRelayURLs,
  normalizedFilter,
  validTaskEvent,
};
