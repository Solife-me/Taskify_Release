self.addEventListener('install', (event) => {
  event.waitUntil(clearOldCaches().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await clearOldCaches();
      await self.clients.claim();
      activatedAt = Date.now();
    })(),
  );
});

const CACHE_PREFIX = 'taskify-cache-';
const CACHE = `${CACHE_PREFIX}v8`;
const CONFIG_CACHE = `${CACHE_PREFIX}config`;
const CACHE_TIMESTAMP_HEADER = 'x-taskify-sw-cached-at';
const MAX_CACHE_ENTRIES = 160;
const CACHE_TRIM_TARGET = 140;
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DOCUMENT_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_WORKER_BASE_URL = self.location.origin;
let workerBaseUrl = DEFAULT_WORKER_BASE_URL;
let workerBaseUrlReady = restoreWorkerBaseUrl();
const notifiedClients = new Set();
const cacheAccessTimes = new Map();
let cachePutsSinceTrim = 16;
let cacheTrimPromise = null;
let activatedAt = 0;

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (shouldBypassRelayTraffic(event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (shouldBypassApi(event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Do not turn the service worker into a cache for arbitrary cross-origin or
  // data fetches. The app shell and same-origin static assets are the only
  // resources that need offline behavior.
  if (!shouldHandleCachedRequest(event.request)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await matchFreshCachedResponse(cache, event.request);
      const cachedForCompare = cached ? cached.clone() : null;

      // Vite content-hashed assets are immutable: a new deployment produces a
      // new URL. Cache-first avoids a background network request for every
      // chunk while HTML keeps its network/update comparison below.
      if (cached && isImmutableAssetRequest(event.request)) {
        return cached;
      }

      // Fast app-shell loading: race network briefly, then fall back to cache.
      // This keeps startup snappy while still refreshing cached HTML when network is available.
      if (isDocumentRequest(event.request)) {
        if (cached) {
          const networkAttempt = fetchAndUpdateCache(cache, event.request, cachedForCompare)
            .then((response) => response || cached)
            .catch(() => cached);
          const timeoutFallback = wait(700).then(() => cached);
          const winner = await Promise.race([networkAttempt, timeoutFallback]);
          event.waitUntil(networkAttempt.catch(() => undefined));
          return winner;
        }
        try {
          const networkResponse = await fetchAndUpdateCache(cache, event.request, cachedForCompare);
          if (networkResponse) return networkResponse;
        } catch {}
        return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
      }

      // Stale-while-revalidate for static/data requests.
      const fetchPromise = fetchAndUpdateCache(cache, event.request, cachedForCompare);

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

function isCacheableResponse(request, response) {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque') return false;
  const cacheControl = response.headers.get('cache-control') || '';
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return false;
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_CACHEABLE_BYTES) return false;
  const status = response.status;
  if (status === 401 || status === 403 || status === 407) return false;
  return shouldHandleCachedRequest(request);
}

async function fetchAndUpdateCache(cache, request, cachedResponse) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      let cacheUpdated = false;
      if (isCacheableResponse(request, networkResponse)) {
        let cacheError = null;
        try {
          await putStampedResponse(cache, request, networkResponse);
          cacheUpdated = true;
        } catch (err) {
          cacheError = err;
          const message = (err && err.message) || '';
          if (message && message.toLowerCase().includes('quotaexceeded')) {
            try {
              await evictOldestCacheEntries(cache, Math.max(1, Math.ceil((await cache.keys()).length / 4)));
              await putStampedResponse(cache, request, networkResponse);
              cacheUpdated = true;
              cacheError = null;
            } catch (retryErr) {
              cacheError = retryErr;
            }
          }
        }
        if (cacheError) {
          console.warn('SW cache put failed', cacheError);
        }
      }
      if (cacheUpdated && await shouldNotifyUpdate(request, cachedResponse, networkResponse)) {
        await notifyClientsAboutUpdate();
      }
    }
    return networkResponse;
  } catch (err) {
    if (!cachedResponse) throw err;
    return null;
  }
}

function shouldHandleCachedRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith('/api/')) return false;
    if (isDocumentRequest(request)) return true;
    if (['script', 'style', 'worker', 'font', 'image', 'manifest'].includes(request.destination)) return true;
    return /\.(?:js|css|woff2?|png|jpe?g|webp|gif|svg|ico|webmanifest)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isImmutableAssetRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return false;
    return /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function cacheMaxAgeForRequest(request) {
  return isDocumentRequest(request) ? MAX_DOCUMENT_CACHE_AGE_MS : MAX_STATIC_CACHE_AGE_MS;
}

async function matchFreshCachedResponse(cache, request) {
  const cached = await cache.match(request);
  if (!cached) return null;

  const cachedAt = Number(cached.headers.get(CACHE_TIMESTAMP_HEADER) || '0');
  const age = Date.now() - cachedAt;
  if (!Number.isFinite(cachedAt) || cachedAt <= 0 || age > cacheMaxAgeForRequest(request)) {
    await cache.delete(request);
    cacheAccessTimes.delete(request.url);
    return null;
  }

  cacheAccessTimes.set(request.url, Date.now());
  return cached;
}

function stampedResponse(response) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set(CACHE_TIMESTAMP_HEADER, String(Date.now()));
  // Fetch exposes a decoded body stream. Do not retain transport-encoding
  // headers when constructing a new response around that decoded stream.
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

async function putStampedResponse(cache, request, response) {
  await cache.put(request, stampedResponse(response));
  cacheAccessTimes.set(request.url, Date.now());
  await maybeTrimCurrentCache(cache);
}

async function maybeTrimCurrentCache(cache) {
  cachePutsSinceTrim += 1;
  if (cachePutsSinceTrim < 16) return;
  if (cacheTrimPromise) return cacheTrimPromise;

  cachePutsSinceTrim = 0;
  cacheTrimPromise = (async () => {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    await evictOldestCacheEntries(cache, keys.length - CACHE_TRIM_TARGET, keys);
  })().finally(() => {
    cacheTrimPromise = null;
  });
  return cacheTrimPromise;
}

async function evictOldestCacheEntries(cache, count, knownKeys) {
  if (count <= 0) return;
  const keys = knownKeys || await cache.keys();
  const ranked = keys
    .map((request, insertionIndex) => ({
      request,
      insertionIndex,
      lastAccess: cacheAccessTimes.get(request.url) || 0,
    }))
    .sort((a, b) => a.lastAccess - b.lastAccess || a.insertionIndex - b.insertionIndex);

  await Promise.all(ranked.slice(0, count).map(async ({ request }) => {
    cacheAccessTimes.delete(request.url);
    await cache.delete(request);
  }));
}

function isDocumentRequest(request) {
  const destination = request.destination;
  const acceptHeader = request.headers.get('accept') || '';
  return (
    request.mode === 'navigate' ||
    destination === 'document' ||
    acceptHeader.includes('text/html')
  );
}

async function shouldNotifyUpdate(request, cachedResponse, networkResponse) {
  if (!cachedResponse) return false;
  if (!isDocumentRequest(request)) return false;

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

  // Default to false — if we can't determine whether an update occurred,
  // suppress the notification to avoid false-positive reload prompts.
  return false;
}

async function notifyClientsAboutUpdate() {
  // Suppress notification during the first 5 seconds after activation to avoid
  // false-positive update prompts triggered by stale-while-revalidate on initial load.
  if (activatedAt && Date.now() - activatedAt < 5000) return;

  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(
    clientList.map((client) => {
      if (notifiedClients.has(client.id)) return Promise.resolve();
      notifiedClients.add(client.id);
      return client.postMessage({
        type: 'UPDATE_AVAILABLE',
      });
    }),
  );
}

async function clearOldCaches() {
  const keys = await caches.keys();
  const deletions = keys
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE && key !== CONFIG_CACHE)
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

  // Polling is a two-phase handoff: only acknowledge rows after every browser
  // notification has been displayed successfully. If this request fails, the
  // Worker retains the rows and a later push can safely retry them.
  const acknowledgeIds = reminders
    .map((item) => Number(item && item.notificationId))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (acknowledgeIds.length > 0) {
    await acknowledgePendingReminders(acknowledgeIds);
  }
}

async function fetchPendingRemindersWithRetry(maxAttempts = 3, baseDelayMs = 500) {
  const apiBase = await getWorkerBaseUrl();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const registration = await self.registration;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return [];
      const response = await fetch(`${apiBase}/api/reminders/poll`, {
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
      // Exponential backoff: 500ms, 1000ms, 2000ms, ...
      await wait(baseDelayMs * Math.pow(2, attempt));
    }
  }
  return [];
}

async function acknowledgePendingReminders(acknowledgeIds) {
  try {
    const apiBase = await getWorkerBaseUrl();
    const registration = await self.registration;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    // The Worker deliberately caps each acknowledgement request. Chunking
    // prevents a large group of simultaneously-due reminders from being
    // displayed successfully but retained forever because the ACK was too big.
    for (let offset = 0; offset < acknowledgeIds.length; offset += 256) {
      await fetch(`${apiBase}/api/reminders/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          acknowledgeIds: acknowledgeIds.slice(offset, offset + 256),
          ackOnly: true,
        }),
        cache: 'no-store',
      });
    }
  } catch (err) {
    // Delivery already succeeded. Leaving the rows unacknowledged is safer
    // than turning a transient acknowledgement failure into data loss.
    console.warn('Failed to acknowledge reminder payloads', err);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const normalized = new URL(trimmed, DEFAULT_WORKER_BASE_URL).origin;
    const noTrailingSlash = normalized.replace(/\/$/, '');
    return noTrailingSlash || null;
  } catch {
    return null;
  }
}

async function restoreWorkerBaseUrl() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const response = await cache.match('worker-base-url');
    const text = response ? (await response.text()) : '';
    const normalized = normalizeBaseUrl(text);
    if (normalized) {
      workerBaseUrl = normalized;
    }
  } catch {}
}

async function persistWorkerBaseUrl(baseUrl) {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    await cache.put('worker-base-url', new Response(baseUrl));
  } catch {}
}

async function getWorkerBaseUrl() {
  try {
    await workerBaseUrlReady;
  } catch {}
  return workerBaseUrl || DEFAULT_WORKER_BASE_URL;
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'TASKIFY_CONFIG') return;
  const normalized = normalizeBaseUrl(data.workerBaseUrl);
  if (!normalized) return;
  workerBaseUrl = normalized;
  workerBaseUrlReady = Promise.resolve();
  persistWorkerBaseUrl(normalized);
});

const relayHostCache = new Map();

function shouldBypassApi(request) {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function shouldBypassRelayTraffic(request) {
  try {
    const acceptHeader = (request.headers.get('accept') || '').toLowerCase();
    if (acceptHeader.includes('application/nostr+json')) return true;

    const url = new URL(request.url);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return true;

    const isSameOrigin = url.origin === self.location.origin;
    if (isSameOrigin) return false;

    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const looksLikeRelayRoot = url.pathname === '/' || url.pathname === '';

    let hostLooksLikeRelay = relayHostCache.get(url.hostname);
    if (hostLooksLikeRelay === undefined) {
      hostLooksLikeRelay = /relay|nostr/i.test(url.hostname);
      relayHostCache.set(url.hostname, hostLooksLikeRelay);
    }

    return isHttp && looksLikeRelayRoot && hostLooksLikeRelay;
  } catch {
    return false;
  }
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

  if (minutes === 0) {
    return timeString
      ? `is due now at ${timeString}`
      : 'is due now';
  }

  const offset = formatOffset(minutes);
  if (minutes < 0) {
    return timeString
      ? `was due ${offset} ago at ${timeString}`
      : `was due ${offset} ago`;
  }
  return timeString
    ? `is due in ${offset} at ${timeString}`
    : `is due in ${offset}`;
}

function formatOffset(minutes) {
  const absMinutes = Math.abs(minutes);
  if (absMinutes % 1440 === 0) {
    const days = absMinutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (absMinutes % 60 === 0) {
    const hours = absMinutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${absMinutes} minute${absMinutes === 1 ? '' : 's'}`;
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
