/**
 * Chat alerts for the web app. Taskify's push relay is a NIP-17 inbox: when a gift wrap for this
 * account arrives there, it sends this browser a Web Push alert that names no sender or
 * conversation. Turning alerts on takes two steps, the same as on iPhone:
 *
 * 1. register this browser's push subscription with the relay (a NIP-98 request signed by the
 *    user, so it works with any signer);
 * 2. list the relay in the account's NIP-17 inbox preference (kind 10050), so senders deliver there.
 */
import type { EventTemplate } from "nostr-tools";
import { inboxReadRelays, normalizeRelayUrls } from "taskify-runtime-nostr";
import type { NostrEvent } from "../nostr/nostrPool";
import type { NostrSigner } from "../../identity/signer";
import { withTimeout } from "../../lib/withTimeout";
import { PUSH_OPERATION_TIMEOUT_MS } from "./reminderClient";

export const CHAT_PUSH_RELAY_URL = "wss://push.solife.me";
export const CHAT_PUSH_SERVER_URL = "https://push.solife.me";
export const NIP17_INBOX_PREFERENCE_KIND = 10050;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A NIP-98 `Authorization` header for one request. The nonce keeps two same-second requests distinct. */
export async function nip98Authorization(
  signer: NostrSigner,
  request: { url: string; method: string; body: string },
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const event = await signer.sign({
    kind: 27235,
    created_at: now,
    tags: [
      ["u", request.url],
      ["method", request.method.toUpperCase()],
      ["payload", await sha256Hex(request.body)],
      ["nonce", crypto.randomUUID()],
    ],
    content: "",
  });
  return `Nostr ${base64(JSON.stringify(event))}`;
}

type RegistrationResponse = { enabled: boolean; remainingRegistrations?: number };

async function registrationRequest(
  method: "PUT" | "DELETE",
  params: { signer: NostrSigner; installationId: string; body: string; serverUrl?: string },
): Promise<RegistrationResponse> {
  const url = `${params.serverUrl ?? CHAT_PUSH_SERVER_URL}/v1/registrations/${encodeURIComponent(params.installationId)}`;
  const authorization = await nip98Authorization(params.signer, { url, method, body: params.body });
  const response = await withTimeout(
    fetch(url, {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: params.body || undefined,
    }),
    PUSH_OPERATION_TIMEOUT_MS,
    "Timed out while contacting the chat notification server.",
  );
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" && message ? message : `Chat notification server error (${response.status})`);
  }
  return data as RegistrationResponse;
}

/** Registers (or refreshes) this browser for chat alerts. The relay forgets registrations unused for 90 days. */
export function registerChatPush(params: {
  signer: NostrSigner;
  installationId: string;
  subscription: PushSubscriptionJSON;
  serverUrl?: string;
}): Promise<RegistrationResponse> {
  const body = JSON.stringify({ platform: "web", application: "taskify", subscription: params.subscription });
  return registrationRequest("PUT", { ...params, body });
}

export function unregisterChatPush(params: {
  signer: NostrSigner;
  installationId: string;
  serverUrl?: string;
}): Promise<RegistrationResponse> {
  return registrationRequest("DELETE", { ...params, body: "" });
}

/** The inbox relays the account advertises in its latest valid kind-10050 event (none if it has none). */
export function advertisedInboxRelays(events: NostrEvent[], pubkey: string): string[] {
  return inboxReadRelays(events as Parameters<typeof inboxReadRelays>[0], pubkey, []);
}

/**
 * The inbox list with the push relay added, or null when it is already there. An account that
 * advertises nothing yet starts from the relays it reads today, so its messages keep arriving there.
 */
export function inboxRelaysWithPushRelay(advertised: string[], fallback: string[], relay = CHAT_PUSH_RELAY_URL): string[] | null {
  if (advertised.includes(relay)) return null;
  const base = advertised.length ? advertised : normalizeRelayUrls(fallback).filter((url) => url !== relay);
  return [...base, relay];
}

/**
 * The inbox list without the push relay, or null when nothing should change: the relay is not
 * listed, or removing it would leave nowhere for messages to arrive.
 */
export function inboxRelaysWithoutPushRelay(advertised: string[], relay = CHAT_PUSH_RELAY_URL): string[] | null {
  if (!advertised.includes(relay)) return null;
  const remaining = advertised.filter((url) => url !== relay);
  return remaining.length ? remaining : null;
}

export function inboxPreferenceTemplate(relays: string[], createdAt = Math.floor(Date.now() / 1000)): EventTemplate {
  return {
    kind: NIP17_INBOX_PREFERENCE_KIND,
    created_at: createdAt,
    tags: relays.map((url) => ["relay", url]),
    content: "",
  };
}
