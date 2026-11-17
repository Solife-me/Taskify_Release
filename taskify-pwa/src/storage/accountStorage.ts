import { LS_KEY_BACKUP_STATE } from "../onboarding/firstRunRules";
import { encryptWithDeviceKey, decryptWithDeviceKey } from "../lib/deviceKeyCrypto";
import { idbKeyValue } from "./idbKeyValue";
import { idbStorage } from "./idbStorage";
import { taskEntityStore, boardEntityStore, calendarEventEntityStore, externalCalendarEventEntityStore } from "./entityStore";
import { setAccountStoragePrefix, writeAccountStorageValue } from "./kvStorage";
import {
  getDeviceTaskifyDb, getTaskifyDb, getTaskifyDbByName, selectTaskifyAccountDatabase,
  TASKIFY_DB_NAME, TASKIFY_STORE_TASKS,
} from "./taskifyDb";

const LEGACY_OWNER_KEY = "taskify_account_storage_owner_v1";
const PENDING_RESTORE_KEY = "taskify_account_restore_v1";

type AccountScope = { pubkey: string | null; database: string; prefix: string };
type TransitionOptions = { createdHere?: boolean; backup?: object };
let activeScope: AccountScope | null = null;
let switching = false;

async function scopeFor(pubkey: string | null): Promise<AccountScope> {
  const deviceDatabase = await getDeviceTaskifyDb();
  let owner: string | undefined;
  await idbStorage.transaction(deviceDatabase, TASKIFY_STORE_TASKS, pubkey ? "readwrite" : "readonly", (tx) => {
    const store = tx.objectStore(TASKIFY_STORE_TASKS);
    const request = store.get(LEGACY_OWNER_KEY);
    request.onsuccess = () => {
      owner = request.result;
      if (owner === undefined && pubkey) {
        store.add(pubkey, LEGACY_OWNER_KEY);
        owner = pubkey;
      }
    };
  });
  if (owner === pubkey || (!owner && pubkey === null)) {
    return { pubkey, database: TASKIFY_DB_NAME, prefix: "" };
  }
  const namespace = pubkey ?? "guest";
  return { pubkey, database: `taskify-account-${namespace}`, prefix: `taskify-account:${namespace}:` };
}

export async function bindAccountStorage(pubkey: string | null): Promise<void> {
  if (activeScope) return;
  const scope = await scopeFor(pubkey);
  await getTaskifyDbByName(scope.database);
  selectTaskifyAccountDatabase(scope.database);
  setAccountStoragePrefix(scope.prefix);
  activeScope = scope;
}

export function accountStorageNeedsSwitch(next: string | null): boolean {
  return activeScope !== null && next !== activeScope.pubkey;
}

export async function flushAccountStorage(): Promise<void> {
  await Promise.all([
    taskEntityStore.flush(), boardEntityStore.flush(), calendarEventEntityStore.flush(),
    externalCalendarEventEntityStore.flush(), idbKeyValue.flushAll(),
  ]);
}

export async function switchAccountStorage(
  next: string | null,
  persistIdentity: () => Promise<void>,
  options: TransitionOptions = {},
): Promise<void> {
  if (switching) throw new Error("Taskify is already switching accounts.");
  switching = true;
  let staged: { database: IDBDatabase; value: string } | undefined;
  try {
    await flushAccountStorage();
    const scope = await scopeFor(next);
    const target = await getTaskifyDbByName(scope.database);
    if (options.backup) {
      const encrypted = await encryptWithDeviceKey(JSON.stringify(options.backup));
      await idbStorage.put(target, TASKIFY_STORE_TASKS, encrypted, PENDING_RESTORE_KEY);
      staged = { database: target, value: encrypted };
    }
    if (options.createdHere) {
      writeAccountStorageValue(scope.prefix, LS_KEY_BACKUP_STATE, JSON.stringify({ createdHereAt: Date.now() }));
    }
    await persistIdentity();
    staged = undefined;
    // Leave this page pinned to its old signer and stores until reload. Slow callbacks and
    // pending relay writes can never be redirected into the account that is opening next.
    window.location.reload();
  } catch (error) {
    switching = false;
    if (staged) {
      await removePendingBackup(staged.database, staged.value).catch(cleanupError => {
        console.warn("Could not roll back a staged account backup", cleanupError);
      });
    }
    throw error;
  }
}

async function removePendingBackup(database: IDBDatabase, expected: string): Promise<void> {
  await idbStorage.transaction(database, TASKIFY_STORE_TASKS, "readwrite", (tx) => {
    const store = tx.objectStore(TASKIFY_STORE_TASKS);
    const request = store.get(PENDING_RESTORE_KEY);
    request.onsuccess = () => {
      if (request.result === expected) store.delete(PENDING_RESTORE_KEY);
    };
  });
}

export async function readPendingAccountBackup(): Promise<{ value: string; finish: () => Promise<void> } | null> {
  const database = await getTaskifyDb();
  const raw = await idbStorage.get<string>(database, TASKIFY_STORE_TASKS, PENDING_RESTORE_KEY);
  if (!raw) return null;
  return {
    value: await decryptWithDeviceKey(raw),
    finish: async () => {
      await flushAccountStorage();
      await removePendingBackup(database, raw);
    },
  };
}

// A different tab changed the shared sign-in. The old document stays scoped to its own data
// while local writes finish, then boot selects the new account.
export function watchAccountStorageSelection(keys: string[]): void {
  window.addEventListener("storage", (event) => {
    if (switching || (event.key !== null && !keys.includes(event.key))) return;
    switching = true;
    // Keep the current account open if the prior edits could not be saved. The storage
    // failure banner reports the error and the active account is still the old one.
    void flushAccountStorage().then(() => window.location.reload()).catch(() => { switching = false; });
  });
}
