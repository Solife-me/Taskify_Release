import { verifyEvent, type Event as NostrEvent } from "nostr-tools";

import type { SessionPool } from "../nostr/SessionPool";
import { LS_BOT_COMMANDS_CACHE } from "../localStorageKeys";

/**
 * NIP-51 bot commands list (see docs/reference/bot-command-lists.md).
 *
 * A bot (an AI agent with its own Nostr key) publishes a parameterized
 * replaceable kind-30078 event advertising the chat commands it accepts.
 * The client treats the presence of this exact list as the signal that the
 * peer is a bot and shows a Telegram-style "/" command menu in the composer.
 */
export const BOT_COMMANDS_KIND = 30078;
export const BOT_COMMANDS_D_TAG = "taskify-bot-commands";

export type BotCommand = {
  name: string;
  description: string;
};

const BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const BOT_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export const BOT_COMMANDS_MAX_COUNT = 100;

const BOT_COMMANDS_CACHE_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

type CachedBotCommandsEntry = {
  commands: BotCommand[];
  fetchedAt: number;
};

function firstTagValue(event: NostrEvent, name: string): string | null {
  for (const tag of event.tags || []) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const singleLine = value.replace(/[\r\n]+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.slice(0, BOT_COMMAND_DESCRIPTION_MAX_LENGTH);
}

/**
 * Strict recognition: an event is a bot commands list only when it is
 * kind 30078 with the exact `taskify-bot-commands` d-tag and carries at
 * least one valid `command` tag. Any other NIP-51 list (Chat-Friends,
 * app backups, future d-tags) is ignored. Returns null when the event is
 * not a bot commands list.
 */
export function parseBotCommands(event: NostrEvent): BotCommand[] | null {
  if (!event || typeof event !== "object") return null;
  if (event.kind !== BOT_COMMANDS_KIND) return null;
  if (firstTagValue(event, "d") !== BOT_COMMANDS_D_TAG) return null;

  const commands: BotCommand[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags || []) {
    if (!Array.isArray(tag) || tag[0] !== "command") continue;
    const name = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
    if (!BOT_COMMAND_NAME_PATTERN.test(name)) continue;
    const description = normalizeDescription(tag[2]);
    if (seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, description: description || "" });
    if (commands.length >= BOT_COMMANDS_MAX_COUNT) break;
  }
  if (!commands.length) return null;
  return commands;
}

export type BotCommandsResult = {
  event: NostrEvent | null;
  commands: BotCommand[];
};

/**
 * Fetches the peer's latest bot commands event. The relay filter already
 * constrains kind/#d/authors, but parseBotCommands re-verifies everything
 * because relays may return supersets.
 */
export async function fetchBotCommands(
  pool: SessionPool,
  relays: string[],
  pubkey: string,
): Promise<BotCommandsResult> {
  const event = await pool.get(relays, {
    kinds: [BOT_COMMANDS_KIND],
    authors: [pubkey],
    "#d": [BOT_COMMANDS_D_TAG],
  });
  if (!event || event.pubkey !== pubkey.toLowerCase() || !verifyEvent(event)) {
    return { event: null, commands: [] };
  }
  const commands = parseBotCommands(event);
  if (!commands) return { event: null, commands: [] };
  return { event, commands };
}

type BotCommandsCacheMap = Record<string, CachedBotCommandsEntry>;

function loadCacheMap(): BotCommandsCacheMap {
  try {
    const raw = window.localStorage.getItem(LS_BOT_COMMANDS_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as BotCommandsCacheMap) : {};
  } catch {
    return {};
  }
}

function persistCacheMap(map: BotCommandsCacheMap) {
  try {
    window.localStorage.setItem(LS_BOT_COMMANDS_CACHE, JSON.stringify(map));
  } catch {
    // Storage full or unavailable — the menu just falls back to a network fetch.
  }
}

/** Immediately-available cached commands for a peer (null when not cached/not a bot). */
export function loadCachedBotCommands(peerHex: string): BotCommand[] | null {
  const entry = loadCacheMap()[peerHex.toLowerCase()];
  if (!entry || !Array.isArray(entry.commands) || !entry.commands.length) return null;
  if (!entry.commands.every((command) => command &&
    typeof command.name === "string" && BOT_COMMAND_NAME_PATTERN.test(command.name) &&
    typeof command.description === "string")) return null;
  return entry.commands;
}

/** True when the cached entry is missing or older than the refresh TTL. */
export function shouldRefreshCachedBotCommands(peerHex: string): boolean {
  const entry = loadCacheMap()[peerHex.toLowerCase()];
  if (!entry) return true;
  return Date.now() - (entry.fetchedAt || 0) > BOT_COMMANDS_CACHE_REFRESH_TTL_MS;
}

export function saveCachedBotCommands(peerHex: string, commands: BotCommand[]) {
  const key = peerHex.toLowerCase();
  const map = loadCacheMap();
  map[key] = { commands, fetchedAt: Date.now() };
  persistCacheMap(map);
}
