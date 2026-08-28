import { hexToBytes } from "@noble/hashes/utils.js";
import {
  getPublicKey,
  nip44,
  verifyEvent,
  type NostrEvent,
} from "nostr-tools";
import { normalizeRelayList, type NostrAppBackupBoard } from "taskify-core";

export const NOSTR_ACCOUNT_BACKUP_KIND = 30078;
export const NOSTR_ACCOUNT_BACKUP_D_TAG = "taskify-app-backup";

export type AccountCatalogBackup = {
  version: 1;
  timestamp: number;
  eventId: string;
  boards: NostrAppBackupBoard[];
  defaultRelays: string[];
};

type AccountBackupFetcher = {
  fetchEvents(
    filters: Array<Record<string, unknown>>,
    relayUrls?: string[],
    timeoutMs?: number,
  ): Promise<NostrEvent[]>;
};

function dTag(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === "d")?.[1];
}

function parseCatalogPayload(plaintext: string, event: NostrEvent): AccountCatalogBackup {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new Error("Account backup payload is not valid JSON.");
  }
  if (parsed.version !== 1) throw new Error("Unsupported account backup version.");

  const boards = Array.isArray(parsed.boards)
    ? parsed.boards.filter((board): board is NostrAppBackupBoard =>
        !!board && typeof board === "object" && typeof (board as NostrAppBackupBoard).id === "string")
    : [];
  const timestamp = Number(parsed.timestamp);
  return {
    version: 1,
    timestamp: Number.isFinite(timestamp) ? timestamp : event.created_at,
    eventId: event.id,
    boards,
    defaultRelays: normalizeRelayList(parsed.defaultRelays) ?? [],
  };
}

export async function decodeAccountCatalogBackup(
  event: NostrEvent,
  secretKeyHex: string,
): Promise<AccountCatalogBackup> {
  if (event.kind !== NOSTR_ACCOUNT_BACKUP_KIND || dTag(event) !== NOSTR_ACCOUNT_BACKUP_D_TAG) {
    throw new Error("Event is not a Taskify account backup.");
  }
  if (!verifyEvent(event)) throw new Error("Account backup signature is invalid.");

  const secret = hexToBytes(secretKeyHex);
  const pubkey = getPublicKey(secret);
  if (event.pubkey.toLocaleLowerCase() !== pubkey.toLocaleLowerCase()) {
    throw new Error("Account backup does not belong to the active identity.");
  }
  if (!nip44?.v2) throw new Error("NIP-44 v2 is unavailable.");

  const conversationKey = nip44.v2.utils.getConversationKey(secret, pubkey);
  const plaintext = await Promise.resolve(nip44.v2.decrypt(event.content, conversationKey));
  return parseCatalogPayload(plaintext, event);
}

export async function findAccountCatalogBackup(options: {
  session: AccountBackupFetcher;
  pubkey: string;
  secretKeyHex: string;
  relays: string[];
  timeoutMs?: number;
}): Promise<AccountCatalogBackup | null> {
  const events = await options.session.fetchEvents(
    [{
      kinds: [NOSTR_ACCOUNT_BACKUP_KIND],
      authors: [options.pubkey],
      "#d": [NOSTR_ACCOUNT_BACKUP_D_TAG],
      limit: 20,
    }],
    options.relays,
    options.timeoutMs ?? 5_000,
  );
  const candidates = events
    .filter((event) => event.kind === NOSTR_ACCOUNT_BACKUP_KIND && dTag(event) === NOSTR_ACCOUNT_BACKUP_D_TAG)
    .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id));

  for (const event of candidates) {
    try {
      return await decodeAccountCatalogBackup(event, options.secretKeyHex);
    } catch {
      // A stale or corrupt event must not hide an older valid account backup.
    }
  }
  return null;
}
