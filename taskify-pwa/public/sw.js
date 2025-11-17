self.addEventListener('install', (event) => {
  event.waitUntil(clearOldCaches().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await clearOldCaches();
      await self.clients.claim();
    })(),
  );
});

const CACHE_PREFIX = 'taskify-cache-';
const CACHE = `${CACHE_PREFIX}v2`;
let updateNotified = false;

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);

      const fetchPromise = fetchAndUpdateCache(cache, event.request, cached);

      if (cached) {
        event.waitUntil(fetchPromise.catch(() => undefined));
        return cached;
      }

      try {
        const networkResponse = await fetchPromise;
        if (networkResponse) return networkResponse;
      } catch {}

      if (cached) return cached;
      return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
    })(),
  );
});

async function fetchAndUpdateCache(cache, request, cachedResponse) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      try {
        await cache.put(request, networkResponse.clone());
      } catch (err) {
        console.warn('SW cache put failed', err);
      }
      if (await shouldNotifyUpdate(request, cachedResponse, networkResponse)) {
        await notifyClientsAboutUpdate();
      }
    }
    return networkResponse;
  } catch (err) {
    if (!cachedResponse) throw err;
    return null;
  }
}

async function shouldNotifyUpdate(request, cachedResponse, networkResponse) {
  if (updateNotified) return false;
  if (!cachedResponse) return false;

  const destination = request.destination;
  const acceptHeader = request.headers.get('accept') || '';
  const isDocumentRequest =
    request.mode === 'navigate' ||
    destination === 'document' ||
    acceptHeader.includes('text/html');

  if (!isDocumentRequest) return false;

  const cachedEtag = cachedResponse.headers.get('etag');
  const networkEtag = networkResponse.headers.get('etag');
  if (cachedEtag && networkEtag) {
    if (cachedEtag === networkEtag) return false;
    return true;
  }

  const cachedLastMod = cachedResponse.headers.get('last-modified');
  const networkLastMod = networkResponse.headers.get('last-modified');
  if (cachedLastMod && networkLastMod) {
    if (cachedLastMod === networkLastMod) return false;
    return true;
  }

  const cachedLength = cachedResponse.headers.get('content-length');
  const networkLength = networkResponse.headers.get('content-length');
  if (cachedLength && networkLength) {
    if (cachedLength === networkLength) return false;
    return true;
  }

  try {
    const cachedBody = await cachedResponse.clone().text();
    const networkBody = await networkResponse.clone().text();
    return cachedBody !== networkBody;
  } catch (err) {
    console.warn('SW compare failed', err);
  }

  return true;
}

async function notifyClientsAboutUpdate() {
  if (updateNotified) return;
  updateNotified = true;
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(
    clientList.map((client) =>
      client.postMessage({
        type: 'UPDATE_AVAILABLE',
      }),
    ),
  );
}

async function clearOldCaches() {
  const keys = await caches.keys();
  const deletions = keys
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
    .map((key) => caches.delete(key));
  await Promise.all(deletions);
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePushEvent());
});

async function handlePushEvent() {
  const reminders = await fetchPendingRemindersWithRetry();

  if (!reminders.length) {
    await self.registration.showNotification('Task reminder', {
      body: 'You have an upcoming task.',
      tag: 'taskify_reminder',
    });
    return;
  }

  await Promise.all(reminders.map(async (item) => {
    const title = buildReminderTitle(item);
    const body = buildReminderBody(item);
    const tag = `taskify_${item.taskId || 'unknown'}_${item.minutes || 0}`;
    const url = item.taskId ? `/?task=${encodeURIComponent(item.taskId)}` : '/';
    await self.registration.showNotification(title, {
      body,
      tag,
      data: {
        ...item,
        url,
      },
    });
  }));
}

async function fetchPendingRemindersWithRetry(maxAttempts = 3, delayMs = 500) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const registration = await self.registration;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return [];
      const response = await fetch('/api/reminders/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        cache: 'no-store',
      });
      if (!response.ok) {
        console.warn('Reminder poll failed', response.status);
      } else {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) return data;
        if (Array.isArray(data) && data.length === 0 && attempt === maxAttempts - 1) return data;
      }
    } catch (err) {
      console.warn('Failed to retrieve reminder payloads', err);
    }
    if (attempt < maxAttempts - 1) {
      await wait(delayMs);
    }
  }
  return [];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReminderTitle(item) {
  const raw = typeof item?.title === 'string' ? item.title : '';
  const cleaned = raw.trim();
  const base = cleaned || 'Task';
  const withoutSuffix = base.replace(/\s+from\s+taskify$/i, '').trim();
  return withoutSuffix || 'Task';
}

function buildReminderBody(item) {
  const minutes = Number(item?.minutes) || 0;
  let due = null;
  if (typeof item?.dueISO === 'string') {
    const parsed = Date.parse(item.dueISO);
    if (!Number.isNaN(parsed)) due = new Date(parsed);
  }
  const timeString = due ? due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  if (minutes <= 0) {
    return timeString
      ? `is due now at ${timeString}`
      : 'is due now';
  }

  const offset = formatOffset(minutes);
  return timeString
    ? `is due in ${offset} at ${timeString}`
    : `is due in ${offset}`;
}

function formatOffset(minutes) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client && client.url === targetUrl) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
