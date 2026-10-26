// Reads the reminder titles the app keeps on this device (src/domains/push/reminderTitles.ts),
// for the service worker: the Worker sends no titles, so a fired reminder is named from here.
// Loaded by sw.js with importScripts; the app's test loads it too, to check both sides agree.
(function () {
  const DB = 'taskify-reminder-titles';
  const STORE = 'titles';
  const VERSION = 1;

  function open(factory) {
    return new Promise((resolve, reject) => {
      const request = factory.open(DB, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'taskId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /// A map of task id to title for the ids that have one.
  async function lookup(taskIds, factory = globalThis.indexedDB) {
    const titles = new Map();
    if (!factory || !taskIds.length) return titles;
    const db = await open(factory);
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly');
        const store = transaction.objectStore(STORE);
        for (const taskId of new Set(taskIds)) {
          const request = store.get(taskId);
          request.onsuccess = () => {
            if (typeof request.result?.title === 'string' && request.result.title) titles.set(taskId, request.result.title);
          };
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
    return titles;
  }

  globalThis.taskifyReminderTitles = { lookup };
})();
