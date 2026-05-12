import { idbStorage } from "./idbStorage.ts";

export const TASKIFY_DB_NAME = "taskify";
export const TASKIFY_DB_VERSION = 3;

export const TASKIFY_STORE_WALLET = "wallet";
export const TASKIFY_STORE_NOSTR = "nostr";
export const TASKIFY_STORE_TASKS = "tasks";

let dbPromise: Promise<IDBDatabase> | null = null;

const REQUIRED_STORES = [
  TASKIFY_STORE_WALLET,
  TASKIFY_STORE_NOSTR,
  TASKIFY_STORE_TASKS,
];

function ensureTaskifyStores(db: IDBDatabase): void {
  for (const storeName of REQUIRED_STORES) {
    if (!db.objectStoreNames.contains(storeName)) {
      db.createObjectStore(storeName);
    }
  }
}

function hasRequiredStores(db: IDBDatabase): boolean {
  return REQUIRED_STORES.every((storeName) => db.objectStoreNames.contains(storeName));
}

function attachVersionChangeHandler(db: IDBDatabase): IDBDatabase {
  db.onversionchange = () => {
    db.close();
    dbPromise = null;
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

async function openTaskifyDb(): Promise<IDBDatabase> {
  try {
    return await ensureRequiredStoresAvailable(
      await idbStorage.openDatabase({
        name: TASKIFY_DB_NAME,
        version: TASKIFY_DB_VERSION,
        upgrade: ensureTaskifyStores,
      }),
    );
  } catch (error) {
    if (!isVersionError(error)) throw error;
  }

  const existing = await idbStorage.openDatabase({ name: TASKIFY_DB_NAME });
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
      name: TASKIFY_DB_NAME,
      version: nextVersion,
      upgrade: ensureTaskifyStores,
    }),
  );
}

export async function getTaskifyDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openTaskifyDb().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return await dbPromise;
}
