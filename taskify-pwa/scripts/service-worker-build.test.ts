import { expect, test } from "vitest";
import {
  collectPrecacheUrls,
  injectServiceWorkerBuild,
} from "./service-worker-build.mjs";

test("collects the rendered app shell and its startup dependency closure", () => {
  const manifest = {
    "index.html": {
      file: "assets/index-entry.js",
      isEntry: true,
      imports: ["_react.js"],
      dynamicImports: ["src/App.tsx"],
      css: ["assets/index.css"],
    },
    "_react.js": { file: "assets/react.js" },
    "src/App.tsx": { file: "assets/App.js", imports: ["_nostr.js"] },
    "_nostr.js": { file: "assets/nostr.js" },
    "src/lazy.ts": { file: "assets/lazy.js", isDynamicEntry: true },
  };

  expect(collectPrecacheUrls(manifest)).toEqual([
    "/",
    "/favicon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/manifest.webmanifest",
    "/assets/App.js",
    "/assets/index-entry.js",
    "/assets/index.css",
    "/assets/nostr.js",
    "/assets/react.js",
  ]);
});

test("injects a stable build id and URL list into the service worker", () => {
  const source = [
    "const CACHE_VERSION = /*__TASKIFY_BUILD_ID__*/ 'source';",
    "const PRECACHE_URLS = /*__TASKIFY_PRECACHE_URLS__*/ ['/'];",
  ].join("\n");

  const built = injectServiceWorkerBuild(source, "index-abc123", ["/", "/assets/index-abc123.js"]);

  expect(built).toContain("/*__TASKIFY_BUILD_ID__*/ 'index-abc123'");
  expect(built).toContain('/*__TASKIFY_PRECACHE_URLS__*/ ["/","/assets/index-abc123.js"]');
});
