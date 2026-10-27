/**
 * botCommands.ts — NIP-51 bot commands list (kind 30078, d-tag
 * "taskify-bot-commands") publish/fetch for Taskify CLI.
 * Contract: docs/reference/bot-command-lists.md. Parsing and validation are shared with
 * the PWA through taskify-core; this file only fetches and publishes.
 */

import { nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeRelayUrls, withStandaloneSession } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";
import {
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  buildBotCommandsTags,
  parseBotCommands,
  type BotCommand,
} from "taskify-core";

/** Opens a relay session for one piece of work and always closes it (`withStandaloneSession`). */
export type WithStandaloneSession = typeof withStandaloneSession;

/** The newest of `events` by `pubkeyHex`, if any. Events come back already verified. */
function latestBy(events: NostrEvent[], pubkeyHex: string, kind?: number): NostrEvent | undefined {
  let latest: NostrEvent | undefined;
  for (const event of events) {
    if (event.pubkey !== pubkeyHex || (kind !== undefined && event.kind !== kind)) continue;
    if (!latest || (event.created_at ?? 0) > (latest.created_at ?? 0)) latest = event;
  }
  return latest;
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

/** Fetch the peer's NIP-17 inbox relays (kind 10050) so the list is discoverable where DMs arrive. */
export async function fetchInboxRelays(
  pubkeyHex: string,
  relays: string[],
  options: { timeoutMs?: number; withSession?: WithStandaloneSession } = {},
): Promise<string[]> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) return [];
  try {
    const events = await (options.withSession ?? withStandaloneSession)({ relays: relayList }, (session) =>
      session.fetchVerified({ kinds: [10050], authors: [pubkeyHex], limit: 1 }, { timeoutMs: options.timeoutMs ?? 5_000 }));
    const latest = latestBy(events, pubkeyHex, 10050);
    const inbox: string[] = [];
    for (const tag of latest?.tags ?? []) {
      if (Array.isArray(tag) && tag[0] === "relay" && typeof tag[1] === "string" && tag[1].trim()) inbox.push(tag[1].trim());
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
  options: { withSession?: WithStandaloneSession } = {},
): Promise<PublishBotCommandsResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) throw new Error("No relays configured.");
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec.");
  const { event } = await (options.withSession ?? withStandaloneSession)(
    { relays: relayList, secretKeyHex: bytesToHex(decoded.data as Uint8Array) },
    (session) => session.publish({ kind: BOT_COMMANDS_KIND, content: "", tags: buildBotCommandsTags(commands, "taskify-cli") }),
  );
  if (!event?.id) throw new Error("Failed to publish bot commands — no event id returned.");
  return { event };
}

export type FetchBotCommandsResult = {
  event: NostrEvent | null;
  commands: BotCommand[];
};

/** Fetch the latest bot commands event for a peer (npub or hex) and parse it. */
export async function fetchBotCommands(
  pubkeyHex: string,
  relays: string[],
  options: { timeoutMs?: number; withSession?: WithStandaloneSession } = {},
): Promise<FetchBotCommandsResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) return { event: null, commands: [] };
  const events = await (options.withSession ?? withStandaloneSession)({ relays: relayList }, (session) =>
    session.fetchVerified(
      { kinds: [BOT_COMMANDS_KIND], authors: [pubkeyHex], "#d": [BOT_COMMANDS_D_TAG], limit: 1 },
      { timeoutMs: options.timeoutMs ?? 8_000 },
    ));
  const latest = latestBy(events, pubkeyHex);
  if (!latest) return { event: null, commands: [] };
  return { event: latest, commands: parseBotCommands(latest) ?? [] };
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