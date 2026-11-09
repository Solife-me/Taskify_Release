import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
  const manifestPath = join(outDir, ".vite", "manifest.json");
  const workerPath = join(outDir, "sw.js");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = Object.values(manifest).find((chunk) => chunk?.isEntry);
  if (!entry?.file) throw new Error("Cannot derive a service-worker build id.");
  const buildId = basename(entry.file).replace(/\.[^.]+$/, "");
  const source = await readFile(workerPath, "utf8");
  await writeFile(workerPath, injectServiceWorkerBuild(source, buildId, collectPrecacheUrls(manifest)));
}
