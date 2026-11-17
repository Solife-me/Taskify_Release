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

let accountDatabaseName = TASKIFY_DB_NAME;
const databases = new Map<string, Promise<IDBDatabase>>();

export function selectTaskifyAccountDatabase(databaseName: string): void {
  accountDatabaseName = databaseName;
}

const REQUIRED_STORES = [
  TASKIFY_STORE_WALLET,
  TASKIFY_STORE_NOSTR,
  TASKIFY_STORE_TASKS,
  TASKIFY_STORE_MUTATIONS,
  STORE_TASKS_V2,
  STORE_BOARDS_V2,
  STORE_CALENDAR_EVENTS_V2,
  STORE_EXTERNAL_CALENDAR_EVENTS_V2,
];

function ensureTaskifyStores(db: IDBDatabase): void {
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
}

function hasRequiredStores(db: IDBDatabase): boolean {
  return REQUIRED_STORES.every((storeName) => db.objectStoreNames.contains(storeName));
}

function attachVersionChangeHandler(db: IDBDatabase): IDBDatabase {
  db.onversionchange = () => {
    db.close();
    databases.delete(db.name);
  };
  return db;
}

function isVersionError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "VersionError"
  );
}

async function openTaskifyDb(name: string): Promise<IDBDatabase> {
  try {
    return await ensureRequiredStoresAvailable(
      await idbStorage.openDatabase({
        name,
        version: TASKIFY_DB_VERSION,
        upgrade: ensureTaskifyStores,
      }),
    );
  } catch (error) {
    if (!isVersionError(error)) throw error;
  }

  const existing = await idbStorage.openDatabase({ name });
  return await ensureRequiredStoresAvailable(existing);
}

async function ensureRequiredStoresAvailable(db: IDBDatabase): Promise<IDBDatabase> {
  if (hasRequiredStores(db)) {
    return attachVersionChangeHandler(db);
  }

  const nextVersion = Math.max(db.version + 1, TASKIFY_DB_VERSION + 1);
  db.close();
  return attachVersionChangeHandler(
    await idbStorage.openDatabase({
      name: db.name,
      version: nextVersion,
      upgrade: ensureTaskifyStores,
    }),
  );
}

export function getTaskifyDbByName(name: string): Promise<IDBDatabase> {
  const existing = databases.get(name);
  if (existing) return existing;
  const opened = openTaskifyDb(name).catch((error) => {
    databases.delete(name);
    throw error;
  });
  databases.set(name, opened);
  return opened;
}

export function getTaskifyDb(): Promise<IDBDatabase> {
  return getTaskifyDbByName(accountDatabaseName);
}

/** The legacy database also holds the browser wrapping key, independent of the active account. */
export function getDeviceTaskifyDb(): Promise<IDBDatabase> {
  return getTaskifyDbByName(TASKIFY_DB_NAME);
}
