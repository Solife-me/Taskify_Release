import { idbStorage } from "./idbStorage.ts";
import {
  STORE_TASKS_V2,
  STORE_BOARDS_V2,
  STORE_CALENDAR_EVENTS_V2,
  STORE_EXTERNAL_CALENDAR_EVENTS_V2,
} from "./entityStore.ts";

export const TASKIFY_DB_NAME = "taskify";
export const TASKIFY_DB_VERSION = 3;

export const TASKIFY_STORE_WALLET = "wallet";
export const TASKIFY_STORE_NOSTR = "nostr";
export const TASKIFY_STORE_TASKS = "tasks";
export const TASKIFY_STORE_MUTATIONS = "mutations";

let dbPromise: Promise<IDBDatabase> | null = null;

export async function getTaskifyDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = idbStorage.openDatabase({
      name: TASKIFY_DB_NAME,
      version: TASKIFY_DB_VERSION,
      upgrade(db) {
        if (!db.objectStoreNames.contains(TASKIFY_STORE_WALLET)) {
          db.createObjectStore(TASKIFY_STORE_WALLET);
        }
        if (!db.objectStoreNames.contains(TASKIFY_STORE_NOSTR)) {
          db.createObjectStore(TASKIFY_STORE_NOSTR);
        }
        if (!db.objectStoreNames.contains(TASKIFY_STORE_TASKS)) {
          db.createObjectStore(TASKIFY_STORE_TASKS);
        }
        if (!db.objectStoreNames.contains(TASKIFY_STORE_MUTATIONS)) {
          db.createObjectStore(TASKIFY_STORE_MUTATIONS, { keyPath: "id" });
        }
        // v3: per-entity stores. Each row's primary key is the entity's `id`
        // field, replacing the legacy single-blob storage in TASKIFY_STORE_TASKS.
        if (!db.objectStoreNames.contains(STORE_TASKS_V2)) {
          db.createObjectStore(STORE_TASKS_V2, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_BOARDS_V2)) {
          db.createObjectStore(STORE_BOARDS_V2, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CALENDAR_EVENTS_V2)) {
          db.createObjectStore(STORE_CALENDAR_EVENTS_V2, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_EXTERNAL_CALENDAR_EVENTS_V2)) {
          db.createObjectStore(STORE_EXTERNAL_CALENDAR_EVENTS_V2, { keyPath: "id" });
        }
      },
    });
  }
  return await dbPromise;
}
