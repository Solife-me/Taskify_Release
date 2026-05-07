import { idbStorage } from "./idbStorage.ts";

export const TASKIFY_DB_NAME = "taskify";
export const TASKIFY_DB_VERSION = 2;

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
      },
    });
  }
  return await dbPromise;
}
