/**
 * botCommands.ts — NIP-51 bot commands list (kind 30078, d-tag
 * "taskify-bot-commands") publish/fetch for Taskify CLI.
 * Contract: docs/bot-command-lists.md. Mirrors
 * taskify-pwa/src/lib/botCommands.ts (parity by convention, not shared code).
 */

import NDK, { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk";
import { nip19, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeRelayUrls } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";

export const BOT_COMMANDS_KIND = 30078;
export const BOT_COMMANDS_D_TAG = "taskify-bot-commands";

export type BotCommand = {
  name: string;
  description: string;
};

const BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const BOT_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export const BOT_COMMANDS_MAX_COUNT = 100;

function firstTagValue(event: NostrEvent, name: string): string | null {
  for (const tag of (event.tags || []) as unknown[] as string[][]) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

/**
 * Strict recognition: an event is a bot commands list only when it is
 * kind 30078 with the exact "taskify-bot-commands" d-tag and carries at
 * least one valid `command` tag. Any other NIP-51 list is ignored.
 */
export function parseBotCommands(event: NostrEvent): BotCommand[] | null {
  if (!event || event.kind !== BOT_COMMANDS_KIND) return null;
  if (firstTagValue(event, "d") !== BOT_COMMANDS_D_TAG) return null;

  const commands: BotCommand[] = [];
  const seen = new Set<string>();
  for (const tag of (event.tags || []) as unknown[] as string[][]) {
    if (!Array.isArray(tag) || tag[0] !== "command") continue;
    const name = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
    if (!BOT_COMMAND_NAME_PATTERN.test(name)) continue;
    const description = typeof tag[2] === "string"
      ? tag[2].replace(/[\r\n]+/g, " ").trim().slice(0, BOT_COMMAND_DESCRIPTION_MAX_LENGTH)
      : "";
    if (seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, description });
    if (commands.length >= BOT_COMMANDS_MAX_COUNT) break;
  }
  return commands.length ? commands : null;
}

export class BotCommandsValidationError extends Error {}

/**
 * Validates commands destined for publication. Beyond the wire format this
 * enforces the contract's privacy rules: the published list must contain
 * only command names and short descriptions — no keys, no user identifiers.
 */
export function validateBotCommandsDraft(commands: unknown): BotCommand[] {
  if (!Array.isArray(commands)) {
    throw new BotCommandsValidationError("Commands must be a JSON array.");
  }
  if (!commands.length) {
    throw new BotCommandsValidationError("At least one command is required.");
  }
  if (commands.length > BOT_COMMANDS_MAX_COUNT) {
    throw new BotCommandsValidationError(`At most ${BOT_COMMANDS_MAX_COUNT} commands are allowed.`);
  }
  const seen = new Set<string>();
  return commands.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new BotCommandsValidationError("Each command must be an object with name and description.");
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    if (!BOT_COMMAND_NAME_PATTERN.test(name)) {
      throw new BotCommandsValidationError(
        `Invalid command name '${name || "(missing)"}': use 1-32 lowercase letters, digits, or underscores (no leading slash).`,
      );
    }
    if (seen.has(name)) {
      throw new BotCommandsValidationError(`Duplicate command name: ${name}`);
    }
    seen.add(name);

    const description = typeof entry.description === "string"
      ? entry.description.replace(/[\r\n]+/g, " ").trim().slice(0, BOT_COMMAND_DESCRIPTION_MAX_LENGTH)
      : "";
    if (!description) {
      throw new BotCommandsValidationError(`Command "${name}" needs a short description.`);
    }
    for (const value of [name, description]) {
      if (/nsec1|npub1|hex\.|nprofile1|naddr1/i.test(value)) {
        throw new BotCommandsValidationError(
          `Command "${name}" contains a Nostr key or identifier — the published list must not contain user data (see docs/bot-command-lists.md).`,
        );
      }
    }
    return { name, description };
  });
}

async function connectNdk(relayList: string[]): Promise<NDK> {
  const ndk = new NDK({ explicitRelayUrls: relayList });
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
    let latest: NDKEvent | null = null;
    for (const ev of events) {
      if (!latest || (ev.created_at ?? 0) > (latest.created_at ?? 0)) latest = ev;
    }
    if (!latest) return [];
    const raw = latest.rawEvent?.() as NostrEvent | undefined;
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
  await Promise.race([ndk.connect(), new Promise<void>((r) => setTimeout(r, 3_000))]);

  const tags: string[][] = [
    ["d", BOT_COMMANDS_D_TAG],
    ...commands.map((command) => ["command", command.name, command.description]),
    ["alt", `Taskify bot commands (${commands.length})`],
    ["client", "taskify-cli"],
  ];

  const event = new NDKEvent(ndk);
  event.kind = BOT_COMMANDS_KIND;
  event.content = "";
  event.tags = tags;
  event.created_at = Math.floor(Date.now() / 1000);
  await event.sign();
  await event.publish();

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

  let latest: NDKEvent | null = null;
  for (const ev of events) {
    if (!latest || (ev.created_at ?? 0) > (latest.created_at ?? 0)) latest = ev;
  }
  if (!latest) return { event: null, commands: [] };
  const raw = latest.rawEvent?.() as NostrEvent | undefined;
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