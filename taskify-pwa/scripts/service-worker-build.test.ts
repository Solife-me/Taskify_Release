import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  collectPrecacheUrls,
  injectBuiltServiceWorker,
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
    "src/ui/app/AppModalStack.tsx": {
      file: "assets/AppModalStack.js",
      imports: ["_sanitize.js"],
      dynamicImports: ["src/lazy.ts"],
    },
    "_nostr.js": { file: "assets/nostr.js" },
    "_sanitize.js": { file: "assets/sanitize.js" },
    "src/lazy.ts": { file: "assets/lazy.js", isDynamicEntry: true },
  };

  expect(collectPrecacheUrls(manifest)).toEqual([
    "/",
    "/favicon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/manifest.webmanifest",
    "/assets/App.js",
    "/assets/AppModalStack.js",
    "/assets/index-entry.js",
    "/assets/index.css",
    "/assets/nostr.js",
    "/assets/react.js",
    "/assets/sanitize.js",
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

test("an HTML-only deploy uses a new cache and pairs its worker with the marked HTML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskify-shell-"));
  try {
    await mkdir(join(dir, ".vite"));
    await writeFile(join(dir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "assets/index-same.js", isEntry: true },
    }));
    for (const path of ["favicon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest", "reminder-titles.js"]) {
      await writeFile(join(dir, path), path);
    }
    const source = "/*__TASKIFY_BUILD_ID__*/ 'source';\n/*__TASKIFY_PRECACHE_URLS__*/ ['/'];";
    const build = async (title: string) => {
      await writeFile(join(dir, "sw.js"), source);
      await writeFile(join(dir, "index.html"), `<head><title>${title}</title></head>`);
      await injectBuiltServiceWorker(dir);
      const worker = await readFile(join(dir, "sw.js"), "utf8");
      const html = await readFile(join(dir, "index.html"), "utf8");
      const id = worker.match(/__TASKIFY_BUILD_ID__\*\/ '([^']+)'/)?.[1];
      expect(html).toContain(`<meta name="taskify-build" content="${id}" />`);
      return id;
    };
    const first = await build("Original");
    expect(await build("Original")).toBe(first);
    expect(await build("Updated")).not.toBe(first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
