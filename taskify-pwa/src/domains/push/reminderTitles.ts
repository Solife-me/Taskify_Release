/**
 * Reminder titles kept on the device for the service worker (C13-8). The Worker keeps no titles:
 * when a reminder fires, the service worker reads the title here, through
 * `public/reminder-titles.js`, which opens the same database and store. Its test checks the two
 * agree.
 */
export const REMINDER_TITLES_DB = "taskify-reminder-titles";
export const REMINDER_TITLES_STORE = "titles";
const VERSION = 1;

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(REMINDER_TITLES_DB, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REMINDER_TITLES_STORE)) {
        request.result.createObjectStore(REMINDER_TITLES_STORE, { keyPath: "taskId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function replace(entries: Array<{ taskId: string; title: string }>, factory: IDBFactory): Promise<void> {
  const db = await open(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(REMINDER_TITLES_STORE, "readwrite");
      const store = transaction.objectStore(REMINDER_TITLES_STORE);
      store.clear();
      for (const entry of entries) store.put({ taskId: entry.taskId, title: entry.title });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Replaces the device's titles with those of the tasks that have reminders now. */
export function saveReminderTitles(
  entries: Array<{ taskId: string; title: string }>,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<void> {
  return replace(entries, factory);
}

/** Removes every title, as when reminders are turned off. */
export function clearReminderTitles(factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  return replace([], factory);
}
