import { verifyEvent, type Event as NostrEvent } from "nostr-tools";

import type { SessionPool } from "../nostr/SessionPool";
import { LS_BOT_COMMANDS_CACHE } from "../localStorageKeys";

// NIP-51 bot commands list (docs/reference/bot-command-lists.md). Parsing is shared through
// taskify-core; this file fetches and caches.
export {
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  BOT_COMMANDS_MAX_COUNT,
  parseBotCommands,
  type BotCommand,
} from "taskify-core";
import {
  BOT_COMMAND_NAME_PATTERN,
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  parseBotCommands,
  type BotCommand,
} from "taskify-core";

const BOT_COMMANDS_CACHE_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

type CachedBotCommandsEntry = {
  commands: BotCommand[];
  fetchedAt: number;
};

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
