/**
 * The account: which boards this user has, and how to reach them.
 *
 * Taskify keeps a user's board list in an encrypted, replaceable Nostr event (kind 30078, d-tag
 * `taskify-app-backup`), encrypted to the account's own key. Any client with the account's
 * `nsec` can read it, which is how the panel finds the same boards the PWA shows without needing
 * a server of its own.
 */
import { nip44 } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { DEFAULT_NOSTR_RELAYS, type NostrAppBackupBoard } from "taskify-core";
import { getSession, DEFAULT_RELAYS } from "./session";

export const BACKUP_KIND = 30078;
export const BACKUP_D_TAG = "taskify-app-backup";
export const BACKUP_CLIENT_TAG = "taskify.app";

/** The account backup's shape, as the PWA writes it (see `taskify-pwa/src/nostrBackup.ts`). */
export type NostrAppBackupPayload = {
  version: 1;
  timestamp: number;
  boards: NostrAppBackupBoard[];
  settings: Record<string, unknown>;
  defaultRelays?: string[];
};

export type AccountBoards = {
  boards: NostrAppBackupBoard[];
  settings: Record<string, unknown>;
  defaultRelays: string[];
  /** When the backup was written, as a Unix second. */
  timestamp: number;
};

function normalizeRelays(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/** Decrypts the account backup event. The payload is NIP-44 v2 to the account's own key. */
async function decryptBackup(content: string, secretKeyHex: string, pubkey: string): Promise<NostrAppBackupPayload | null> {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(secretKeyHex), pubkey);
    const plaintext = await nip44.v2.decrypt(content, conversationKey);
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as NostrAppBackupPayload;
  } catch {
    // A backup encrypted to another key (or not a backup at all) is not ours.
    return null;
  }
}

/**
 * Reads the account's board list.
 *
 * The backup is fetched from the account's relays. If there is no backup yet, the account still
 * works: boards shared with this account arrive through the NIP-17 inbox, and the panel shows
 * what it finds.
 */
export async function loadAccountBoards(secretKeyHex: string, pubkey: string): Promise<AccountBoards> {
  const session = await getSession(DEFAULT_RELAYS);
  const events = await session.fetchEvents(
    [{ kinds: [BACKUP_KIND], authors: [pubkey], "#d": [BACKUP_D_TAG], limit: 1 }],
    DEFAULT_RELAYS,
    8000,
  );

  let newest: { content: string; created_at: number } | null = null;
  for (const event of events) {
    if (!newest || event.created_at > newest.created_at) {
      newest = { content: event.content, created_at: event.created_at };
    }
  }

  if (!newest) {
    return { boards: [], settings: {}, defaultRelays: [...DEFAULT_NOSTR_RELAYS], timestamp: 0 };
  }

  const payload = await decryptBackup(newest.content, secretKeyHex, pubkey);
  if (!payload) {
    return { boards: [], settings: {}, defaultRelays: [...DEFAULT_NOSTR_RELAYS], timestamp: newest.created_at };
  }

  const boards: NostrAppBackupBoard[] = Array.isArray(payload.boards)
    ? payload.boards.filter((board): board is NostrAppBackupBoard => !!board && typeof board === "object")
    : [];

  return {
    boards,
    settings: payload.settings && typeof payload.settings === "object" ? payload.settings : {},
    defaultRelays: normalizeRelays(payload.defaultRelays).length
      ? normalizeRelays(payload.defaultRelays)
      : [...DEFAULT_NOSTR_RELAYS],
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : newest.created_at,
  };
}

/** The relays a board's tasks live on, falling back to the account's relays. */
export function boardRelays(board: NostrAppBackupBoard, accountRelays: string[]): string[] {
  const own = normalizeRelays(board.relays);
  return own.length ? own : accountRelays;
}
