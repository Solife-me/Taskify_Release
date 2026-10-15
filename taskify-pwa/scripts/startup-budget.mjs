#!/usr/bin/env node
/**
 * Measures the JavaScript a first visit downloads before Taskify can render, and fails when it
 * exceeds the budget. Run after `vite build` (needs `build.manifest`).
 *
 * Boot code is the entry chunk, everything it imports statically, and everything `main.tsx`
 * imports dynamically: `main.tsx` exists only to bootstrap, so all of its imports are awaited
 * before the first render. Code that `App` and the features load lazily is not counted. Keep
 * it that way: anything optional belongs behind a lazy import outside `main.tsx`.
 *
 * Usage: node scripts/startup-budget.mjs [--budget-kb <gzipped KB>] [--json]
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 604 KB at the start of the improvement review (October 2026); 458 KB once the wallet, QR and
// share dialogs became lazy and React, the preload helper and the Node polyfills got their own
// chunks. The budget leaves a little room; raise it only with a reason.
const DEFAULT_BUDGET_KB = 470;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = process.argv.slice(2);
const budgetArg = args.indexOf("--budget-kb");
const budgetKb = budgetArg >= 0 ? Number(args[budgetArg + 1]) : DEFAULT_BUDGET_KB;
if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  console.error("--budget-kb needs a positive number");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
} catch {
  console.error("dist/.vite/manifest.json not found: run `npm run build` first.");
  process.exit(2);
}

const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) {
  console.error("No entry chunk in the manifest.");
  process.exit(2);
}

const boot = new Set();
const visit = (key) => {
  if (boot.has(key) || !manifest[key]) return;
  boot.add(key);
  for (const dep of manifest[key].imports ?? []) visit(dep);
};
visit(entryKey);
for (const dynamic of manifest[entryKey].dynamicImports ?? []) visit(dynamic);

const rows = [...boot]
  .map((key) => {
    const file = manifest[key].file;
    const bytes = readFileSync(join(dist, file));
    return { source: key, file, rawKb: bytes.length / 1024, gzipKb: gzipSync(bytes, { level: 9 }).length / 1024 };
  })
  .filter((row) => row.file.endsWith(".js"))
  .sort((a, b) => b.gzipKb - a.gzipKb);
const totalKb = rows.reduce((sum, row) => sum + row.gzipKb, 0);

if (args.includes("--json")) {
  console.log(JSON.stringify({ budgetKb, totalKb: Math.round(totalKb), chunks: rows }, null, 2));
} else {
  for (const row of rows) {
    console.log(`${row.gzipKb.toFixed(1).padStart(7)} KB gz  ${row.file}  (${row.source})`);
  }
  console.log(`\nStartup JavaScript: ${totalKb.toFixed(1)} KB gzipped in ${rows.length} files (budget ${budgetKb} KB).`);
}

if (totalKb > budgetKb) {
  console.error(
    `Startup JavaScript is over budget by ${(totalKb - budgetKb).toFixed(1)} KB. Load the new code lazily,` +
      " outside main.tsx, or raise the budget in scripts/startup-budget.mjs with a reason.",
  );
  process.exit(1);
}
