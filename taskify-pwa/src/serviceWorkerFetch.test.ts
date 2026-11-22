import { expect, test, vi } from "vitest";
import serviceWorkerSource from "../public/sw.js?raw";

type WorkerHarnessOptions = {
  cachedResponse?: Response;
  networkResponse?: Response;
  offline?: boolean;
  precache?: string[];
  cacheKeys?: Request[];
};

/** Runs the real worker with small stand-ins for the browser-owned worker globals. */
function loadServiceWorker(options: WorkerHarnessOptions = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const postedMessages: unknown[] = [];
  const skipWaiting = vi.fn(async () => {});
  const cache = {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => options.cacheKeys ?? []),
    match: vi.fn(async (request: Request | string) => {
      if (request === "worker-base-url") return undefined;
      return options.cachedResponse?.clone();
    }),
    put: vi.fn(async () => {}),
  };
  const caches = {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => [] as string[]),
    open: vi.fn(async () => cache),
  };
  const fetch = vi.fn(async (_request: Request | string, _init?: RequestInit) => {
    if (options.offline) throw new TypeError("Failed to fetch");
    return options.networkResponse?.clone()
      ?? new Response("ok", { headers: { "Content-Type": "text/plain" } });
  });
  const self = {
    location: new URL("https://taskify.solife.me/sw.js"),
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: {
      claim: async () => {},
      matchAll: async () => [{ id: "window-1", postMessage: (message: unknown) => postedMessages.push(message) }],
    },
    registration: { showNotification: async () => {} },
    skipWaiting,
  };
  const globals = {
    self,
    caches,
    importScripts: () => {},
    fetch,
  };
  const source = options.precache
    ? serviceWorkerSource.replace("/*__TASKIFY_PRECACHE_URLS__*/ ['/']", JSON.stringify(options.precache))
    : serviceWorkerSource;
  new Function(...Object.keys(globals), source)(...Object.values(globals));

  async function dispatchExtendable(type: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => waits.push(Promise.resolve(promise)),
    });
    await Promise.all(waits);
  }

  async function dispatchFetch(request: Request) {
    const waits: Promise<unknown>[] = [];
    let responsePromise: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request,
      respondWith: (response: Promise<Response>) => { responsePromise = Promise.resolve(response); },
      waitUntil: (promise: Promise<unknown>) => waits.push(Promise.resolve(promise)),
    });
    const response = await responsePromise;
    await Promise.all(waits);
    return { responded: Boolean(responsePromise), response };
  }

  return {
    cache,
    caches,
    dispatchFetch,
    dispatchInstall: () => dispatchExtendable("install"),
    dispatchMessage: (data: unknown) => dispatchExtendable("message", { data }),
    fetch,
    postedMessages,
    skipWaiting,
  };
}

function navigation(path: string): Request {
  const request = new Request(`https://taskify.solife.me${path}`, { headers: { Accept: "text/html" } });
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

test("relay and API traffic goes straight to the network, never through the service worker", async () => {
  const worker = loadServiceWorker();
  const requests = [
    new Request("https://push.solife.me/", { headers: { Accept: "application/nostr+json" } }),
    new Request("https://relay.example.com/"),
    new Request("https://taskify.solife.me/api/config"),
  ];
  for (const request of requests) {
    expect((await worker.dispatchFetch(request)).responded, request.url).toBe(false);
  }
});

test("the app shell is still served by the service worker", async () => {
  const worker = loadServiceWorker();
  const shell = new Request("https://taskify.solife.me/assets/App-abc123.js");
  expect((await worker.dispatchFetch(shell)).responded).toBe(true);
});

test("keeps a 31-day-old app shell usable for an offline deep link", async () => {
  const worker = loadServiceWorker({
    cachedResponse: new Response("installed shell", {
      headers: { "x-taskify-sw-cached-at": String(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    }),
    offline: true,
  });
  const { response } = await worker.dispatchFetch(navigation("/boards/week-default"));
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe("installed shell");
  expect(worker.cache.delete).not.toHaveBeenCalled();
});

test("keeps aged startup assets usable offline", async () => {
  const asset = "/assets/startup-abc12345.js";
  const worker = loadServiceWorker({
    precache: ["/", asset],
    cachedResponse: new Response("startup JS", {
      headers: { "x-taskify-sw-cached-at": String(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    }),
    offline: true,
  });
  const { response } = await worker.dispatchFetch(new Request(`https://taskify.solife.me${asset}`));
  expect(await response?.text()).toBe("startup JS");
  expect(worker.cache.delete).not.toHaveBeenCalled();
});

test("cache trimming keeps required startup entries", async () => {
  const origin = "https://taskify.solife.me";
  const asset = "/assets/startup-abc12345.js";
  const worker = loadServiceWorker({
    precache: ["/", asset],
    cacheKeys: [
      new Request(origin + "/"),
      new Request(origin + asset),
      ...Array.from({ length: 161 }, (_, index) => new Request(`${origin}/assets/runtime-${index}.js`)),
    ],
  });
  await worker.dispatchFetch(new Request(origin + "/assets/new-runtime.js"));
  const removed = worker.cache.delete.mock.calls.flat().map((request: Request) => request.url);
  expect(removed.length).toBeGreaterThan(0);
  expect(removed).not.toContain(origin + "/");
  expect(removed).not.toContain(origin + asset);
});

test("serves the active build even when a newer deployment can answer the navigation", async () => {
  const worker = loadServiceWorker({
    cachedResponse: new Response("installed shell", {
      headers: { "x-taskify-sw-cached-at": String(Date.now()) },
    }),
    networkResponse: new Response("next deployment", { headers: { "Content-Type": "text/html" } }),
  });
  const { response } = await worker.dispatchFetch(navigation("/upcoming"));
  expect(await response?.text()).toBe("installed shell");
  expect(worker.cache.put).not.toHaveBeenCalled();
});

test("installation pre-caches the app shell without forcing a waiting update to activate", async () => {
  const worker = loadServiceWorker({
    networkResponse: new Response('<meta name="taskify-build" content="source-v10" />', {
      headers: { "Content-Type": "text/html" },
    }),
  });

  await worker.dispatchInstall();

  expect(worker.fetch).toHaveBeenCalled();
  expect(worker.fetch.mock.calls.some(([request]) => (
    new URL(typeof request === "string" ? request : request.url).pathname === "/"
  ))).toBe(true);
  expect(worker.cache.put).toHaveBeenCalled();
  expect(worker.skipWaiting).not.toHaveBeenCalled();
});

test("an install or cache recovery cannot put another deployment's shell in the active build", async () => {
  const worker = loadServiceWorker({
    networkResponse: new Response('<meta name="taskify-build" content="some-other-build" />', {
      headers: { "Content-Type": "text/html" },
    }),
  });
  await expect(worker.dispatchInstall()).rejects.toThrow("different deployment");
  expect(worker.caches.delete).toHaveBeenCalledWith("taskify-cache-source-v10");
  const { response } = await worker.dispatchFetch(navigation("/upcoming"));
  expect(response?.status).toBe(503);
  expect(worker.cache.put).not.toHaveBeenCalled();
});

test("a waiting worker activates only after the page sends SKIP_WAITING", async () => {
  const worker = loadServiceWorker();

  expect(worker.skipWaiting).not.toHaveBeenCalled();
  await worker.dispatchMessage({ type: "SKIP_WAITING" });
  expect(worker.skipWaiting).toHaveBeenCalledOnce();
});

test("changing Cloudflare-injected HTML does not produce a false app update", async () => {
  const cachedAt = String(Date.now());
  const worker = loadServiceWorker({
    cachedResponse: new Response("<main>Taskify</main><script>ray=old</script>", {
      headers: { "Content-Type": "text/html", "x-taskify-sw-cached-at": cachedAt },
    }),
    networkResponse: new Response("<main>Taskify</main><script>ray=new</script>", {
      headers: { "Content-Type": "text/html" },
    }),
  });

  await worker.dispatchFetch(new Request("https://taskify.solife.me/", {
    headers: { Accept: "text/html" },
  }));

  expect(worker.postedMessages).toEqual([]);
});
