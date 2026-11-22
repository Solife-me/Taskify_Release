import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SHELL_URLS = [
  "/",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];

export function collectPrecacheUrls(manifest) {
  const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entryKey) throw new Error("Cannot build the service-worker cache without a Vite entry.");

  const visited = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || visited.has(key)) return;
    visited.add(key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entryKey);
  for (const dynamicEntry of manifest[entryKey].dynamicImports ?? []) visit(dynamicEntry);
  // First-run onboarding can render on an offline launch. The modal stack's print and scan
  // imports stay lazy like the rest of the optional features.
  visit("src/ui/app/AppModalStack.tsx");

  const assets = new Set();
  for (const key of visited) {
    const chunk = manifest[key];
    if (typeof chunk.file === "string") assets.add(`/${chunk.file}`);
    for (const css of chunk.css ?? []) assets.add(`/${css}`);
  }
  return [...SHELL_URLS, ...assets].sort((left, right) => {
    const leftIsShell = SHELL_URLS.includes(left);
    const rightIsShell = SHELL_URLS.includes(right);
    if (leftIsShell !== rightIsShell) return leftIsShell ? -1 : 1;
    return left.localeCompare(right);
  });
}

export function injectServiceWorkerBuild(source, buildId, urls) {
  const buildMarker = /\/\*__TASKIFY_BUILD_ID__\*\/\s*'[^']*'/;
  const urlsMarker = /\/\*__TASKIFY_PRECACHE_URLS__\*\/\s*\[[^\n]*\]/;
  if (!buildMarker.test(source) || !urlsMarker.test(source)) {
    throw new Error("Service-worker build markers are missing.");
  }
  return source
    .replace(buildMarker, `/*__TASKIFY_BUILD_ID__*/ '${buildId.replace(/'/g, "")}'`)
    .replace(urlsMarker, `/*__TASKIFY_PRECACHE_URLS__*/ ${JSON.stringify(urls)}`);
}

export async function injectBuiltServiceWorker(outDir) {
  const workerPath = join(outDir, "sw.js");
  const htmlPath = join(outDir, "index.html");
  const [manifestSource, source, html, ...staticFiles] = await Promise.all([
    readFile(join(outDir, ".vite", "manifest.json"), "utf8"),
    readFile(workerPath, "utf8"),
    readFile(htmlPath, "utf8"),
    ...[...SHELL_URLS.slice(1), "/reminder-titles.js"].map((path) => readFile(join(outDir, path))),
  ]);
  const urls = collectPrecacheUrls(JSON.parse(manifestSource));
  if (!html.includes("</head>")) throw new Error("Cannot mark the app shell with its build id.");

  // HTML-only changes and worker-only changes also need a new cache to isolate waiting installs.
  const hash = createHash("sha256");
  for (const input of [manifestSource, source, html, ...staticFiles]) hash.update(input).update("\0");
  const buildId = hash.digest("hex").slice(0, 20);
  const markedHtml = html.replace("</head>", `  <meta name="taskify-build" content="${buildId}" />\n  </head>`);
  await Promise.all([
    writeFile(htmlPath, markedHtml),
    writeFile(workerPath, injectServiceWorkerBuild(source, buildId, urls)),
  ]);
}
