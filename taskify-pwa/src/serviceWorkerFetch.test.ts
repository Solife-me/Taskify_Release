import { expect, test } from "vitest";
import serviceWorkerSource from "../public/sw.js?raw";

/**
 * The real public/sw.js, loaded with stand-ins for the worker globals it touches at start-up, so
 * its fetch handler can be driven directly.
 */
function loadServiceWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: new URL("https://taskify.solife.me/sw.js"),
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: { showNotification: async () => {} },
    skipWaiting: async () => {},
  };
  const caches = { open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [] }), keys: async () => [] };
  const globals = {
    self,
    caches,
    importScripts: () => {},
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
  };
  // The worker's globals are passed as parameters; everything else is the test runner's.
  new Function(...Object.keys(globals), serviceWorkerSource)(...Object.values(globals));
  return (request: Request) => {
    let responded = false;
    listeners.get("fetch")!({ request, respondWith: () => { responded = true; }, waitUntil: () => {} });
    return { responded };
  };
}

test("relay and API traffic goes straight to the network, never through the service worker", () => {
  // A request the service worker re-fetches and fails turns into a second, uncaught error in
  // the worker. Left alone, the browser makes it and reports it once, where the page asked.
  const dispatch = loadServiceWorker();
  const requests = [
    new Request("https://push.solife.me/", { headers: { Accept: "application/nostr+json" } }),
    new Request("https://relay.example.com/"),
    new Request("https://taskify.solife.me/api/config"),
  ];
  for (const request of requests) {
    expect(dispatch(request).responded, request.url).toBe(false);
  }
});

test("the app shell is still served by the service worker", () => {
  const dispatch = loadServiceWorker();
  const shell = new Request("https://taskify.solife.me/assets/App-abc123.js");
  expect(dispatch(shell).responded).toBe(true);
});
