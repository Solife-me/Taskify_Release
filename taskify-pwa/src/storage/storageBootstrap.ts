import {
  LS_CONTACTS_SYNC_META,
  LS_CONTACT_NIP05_CACHE,
  LS_CONTACT_PROFILE_CACHE,
  LS_NIP51_CONTACTS_MIGRATED,
  LS_DM_BLOCKED_PEERS,
  LS_DM_DELETED_EVENTS,
  LS_ECASH_OPEN_REQUESTS,
  LS_LIGHTNING_CONTACTS,
  LS_MINT_BACKUP_CACHE,
  LS_PROFILE_EVENT_IDS,
  LS_PROFILE_METADATA_CACHE,
  LS_RELAY_INFO_CACHE,
  LS_SPENT_NOSTR_PAYMENTS,
} from "../localStorageKeys";
import { LS_BACKGROUND_IMAGE } from "../domains/storageKeys";

import { getTaskifyDb, TASKIFY_STORE_NOSTR, TASKIFY_STORE_TASKS, TASKIFY_STORE_WALLET } from "./taskifyDb";
import { idbKeyValue } from "./idbKeyValue";

const TASKS_KEY = "taskify_tasks_v5";
const BOARDS_KEY = "taskify_boards_v2";
const EVENTS_KEY = "taskify_calendar_events_v1";
const EXTERNAL_EVENTS_KEY = "taskify_calendar_external_events_v1";
const BOARD_SYNC_CURSORS_KEY = "taskify_board_sync_cursors_v1";

const CASHU_PROOFS_KEY = "cashu_proofs_v1";
const CASHU_ACTIVE_MINT_KEY = "cashu_active_mint_v1";
const CASHU_PENDING_TOKENS_KEY = "cashu_pending_tokens_v1";
const CASHU_MINT_LIST_KEY = "cashu_tracked_mints_v1";
const CASHU_HISTORY_KEY = "cashuHistory";
const CASHU_NIP60_STATE_KEY = "cashu_nip60_state_v1";
const CASHU_NIP60_QUEUE_KEY = "cashu_nip60_queue_v1";
const CASHU_NIP61_PROCESSED_KEY = "cashu_nip61_processed_v1";
const CASHU_NIP61_SINCE_KEY = "cashu_nip61_since_v1";

const PROFILE_SHARE_CACHE_KEY = "taskify.profileSharePayload.v1";
const INBOX_PROCESSED_KEY = "taskify_inbox_processed_v1";

export async function initializeStorageBoundaries(): Promise<void> {
  // Ensure DB exists and stores are created (no-op if IndexedDB unavailable).
  try {
    await getTaskifyDb();
  } catch {
    // ignore; state hooks still run with in-memory values
  }

  // Preload keys needed during initial render.
  await Promise.all([
    idbKeyValue.initStore(TASKIFY_STORE_TASKS, [
      TASKS_KEY,
      BOARDS_KEY,
      EVENTS_KEY,
      EXTERNAL_EVENTS_KEY,
      LS_BACKGROUND_IMAGE,

      BOARD_SYNC_CURSORS_KEY, // relay sync cursors — must preload so repeat opens skip limit:500
    ]),
    idbKeyValue.initStore(TASKIFY_STORE_WALLET, [
      CASHU_PROOFS_KEY,
      CASHU_ACTIVE_MINT_KEY,
      CASHU_PENDING_TOKENS_KEY,
      CASHU_MINT_LIST_KEY,
      CASHU_HISTORY_KEY,
      CASHU_NIP60_STATE_KEY,
      CASHU_NIP60_QUEUE_KEY,
      CASHU_NIP61_PROCESSED_KEY,
      CASHU_NIP61_SINCE_KEY,
      LS_MINT_BACKUP_CACHE,
      LS_ECASH_OPEN_REQUESTS,
      LS_SPENT_NOSTR_PAYMENTS,
    ]),
    idbKeyValue.initStore(TASKIFY_STORE_NOSTR, [
      LS_LIGHTNING_CONTACTS,
      LS_CONTACTS_SYNC_META,
      LS_NIP51_CONTACTS_MIGRATED,
      LS_CONTACT_NIP05_CACHE,
      LS_RELAY_INFO_CACHE,
      LS_PROFILE_METADATA_CACHE,
      LS_CONTACT_PROFILE_CACHE,
      LS_PROFILE_EVENT_IDS,
      LS_DM_DELETED_EVENTS,
      LS_DM_BLOCKED_PEERS,
      PROFILE_SHARE_CACHE_KEY,
      INBOX_PROCESSED_KEY,
    ]),
  ]);
}
