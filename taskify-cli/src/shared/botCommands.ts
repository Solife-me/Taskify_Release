import { configureRelayAccess, publishStandaloneEvent } from "taskify-runtime-nostr";
/**
 * botCommands.ts — NIP-51 bot commands list (kind 30078, d-tag
 * "taskify-bot-commands") publish/fetch for Taskify CLI.
 * Contract: docs/reference/bot-command-lists.md. Parsing and validation are shared with
 * the PWA through taskify-core; this file only fetches and publishes.
 */

import NDK, { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk";
import { nip19, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeRelayUrls } from "taskify-runtime-nostr";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import {
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  buildBotCommandsTags,
  parseBotCommands,
  type BotCommand,
} from "taskify-core";

/** Signed events only, from a plain copy (see shared/verifiedEvents, which this mirrors). */
function signedRawEvents(events: Iterable<NDKEvent>): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const event of events) {
    const raw = (event.rawEvent?.() ?? event) as unknown as NostrEvent;
    const plain: NostrEvent = {
      id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at, kind: raw.kind,
      tags: raw.tags, content: raw.content, sig: raw.sig,
    };
    try { if (verifyEvent(plain)) out.push(plain); } catch { /* malformed */ }
  }
  return out;
}

export {
  BOT_COMMAND_DESCRIPTION_MAX_LENGTH,
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  BOT_COMMANDS_MAX_COUNT,
  BotCommandsValidationError,
  parseBotCommands,
  validateBotCommandsDraft,
  type BotCommand,
} from "taskify-core";

async function connectNdk(relayList: string[]): Promise<NDK> {
  const ndk = new NDK({ explicitRelayUrls: relayList });
  configureRelayAccess(ndk);
  await Promise.race([ndk.connect(), new Promise<void>((r) => setTimeout(r, 3_000))]);
  return ndk;
}

/** Fetch the peer's NIP-17 inbox relays (kind 10050) so the list is discoverable where DMs arrive. */
export async function fetchInboxRelays(
  pubkeyHex: string,
  relays: string[],
  timeoutMs = 5_000,
): Promise<string[]> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) return [];
  try {
    const ndk = await connectNdk(relayList);
    const events = await Promise.race<Set<NDKEvent>>([
      ndk.fetchEvents({ kinds: [10050], authors: [pubkeyHex], limit: 1 } as any),
      new Promise<Set<NDKEvent>>((r) => setTimeout(() => r(new Set()), timeoutMs)),
    ]).catch(() => new Set<NDKEvent>());
    let raw: NostrEvent | undefined;
    for (const ev of signedRawEvents(events)) {
      if (ev.kind !== 10050 || ev.pubkey !== pubkeyHex) continue;
      if (!raw || (ev.created_at ?? 0) > (raw.created_at ?? 0)) raw = ev;
    }
    if (!raw) return [];
    const inbox: string[] = [];
    for (const tag of ((raw?.tags ?? []) as unknown[] as string[][])) {
      if (Array.isArray(tag) && tag[0] === "relay" && typeof tag[1] === "string" && tag[1].trim()) {
        inbox.push(tag[1].trim());
      }
    }
    return inbox;
  } catch {
    return [];
  }
}

export type PublishBotCommandsResult = {
  event: NostrEvent;
};

/** Publish (or replace) the kind-30078 bot commands event for the given nsec. */
export async function publishBotCommands(
  nsec: string,
  commands: BotCommand[],
  relays: string[],
  opts?: { timeoutMs?: number },
): Promise<PublishBotCommandsResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) throw new Error("No relays configured.");

  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec.");
  const sk = decoded.data as Uint8Array;
  const pubkeyHex = getPublicKey(sk);

  const ndk = new NDK({
    explicitRelayUrls: relayList,
    signer: new NDKPrivateKeySigner(bytesToHex(sk)),
  });
  configureRelayAccess(ndk, bytesToHex(sk));
  await Promise.race([ndk.connect(), new Promise<void>((r) => setTimeout(r, 3_000))]);

  const tags = buildBotCommandsTags(commands, "taskify-cli");

  const event = new NDKEvent(ndk);
  event.kind = BOT_COMMANDS_KIND;
  event.content = "";
  event.tags = tags;
  event.created_at = Math.floor(Date.now() / 1000);
  await publishStandaloneEvent(event, relayList);

  const raw = event.rawEvent?.() as NostrEvent ?? (event as unknown as NostrEvent);
  if (!raw?.id) throw new Error("Failed to publish bot commands — no event id returned.");
  return { event: raw };
}

export type FetchBotCommandsResult = {
  event: NostrEvent | null;
  commands: BotCommand[];
};

/** Fetch the latest bot commands event for a peer (npub or hex) and parse it. */
export async function fetchBotCommands(
  pubkeyHex: string,
  relays: string[],
  timeoutMs = 8_000,
): Promise<FetchBotCommandsResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) return { event: null, commands: [] };
  const ndk = await connectNdk(relayList);
  const events = await Promise.race<Set<NDKEvent>>([
    ndk.fetchEvents({
      kinds: [BOT_COMMANDS_KIND],
      authors: [pubkeyHex],
      "#d": [BOT_COMMANDS_D_TAG],
      limit: 1,
    } as any),
    new Promise<Set<NDKEvent>>((r) => setTimeout(() => r(new Set()), timeoutMs)),
  ]).catch(() => new Set<NDKEvent>());

  let raw: NostrEvent | undefined;
  for (const ev of signedRawEvents(events)) {
    if (ev.pubkey !== pubkeyHex) continue;
    if (!raw || (ev.created_at ?? 0) > (raw.created_at ?? 0)) raw = ev;
  }
  if (!raw) return { event: null, commands: [] };
  return { event: raw, commands: parseBotCommands(raw) ?? [] };
}

export function parsePubkey(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}