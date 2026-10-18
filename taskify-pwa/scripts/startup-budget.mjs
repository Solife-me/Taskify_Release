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
// chunks; 441 KB once Upcoming, Chat, the Bible board and voice dictation became lazy. The budget leaves a little room; raise it only with a reason.
const DEFAULT_BUDGET_KB = 455;

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

function staticClosure(startKeys) {
  const result = new Set();
  const visit = (key) => {
    if (result.has(key) || !manifest[key]) return;
    result.add(key);
    for (const dep of manifest[key].imports ?? []) visit(dep);
  };
  for (const key of startKeys) visit(key);
  return result;
}

const boot = staticClosure([entryKey, ...(manifest[entryKey].dynamicImports ?? [])]);

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

// Optional features must stay out of startup. Each must be its own lazily loaded chunk: if it
// is imported statically somewhere, it merges into a startup chunk and has no manifest entry.
const LAZY_FEATURES = [
  "src/ui/upcoming/UpcomingPage.tsx",
  "src/ui/board/BibleBoardView.tsx",
  "src/components/VoiceDictationModal.tsx",
  "src/ui/print/PrintSheets.tsx",
  "src/chat/ChatPage.tsx",
  "src/wallet/WalletRuntime.tsx",
];
const notLazy = LAZY_FEATURES.filter((key) => !manifest[key]?.isDynamicEntry || boot.has(key));
if (notLazy.length) {
  console.error("These features must load lazily but are part of startup:\n" + notLazy.join("\n"));
  process.exit(1);
}
if (!args.includes("--json")) console.log(`Lazy features: ${LAZY_FEATURES.length} checked, none in startup.`);

// Libraries that must not reach startup, found by a string their code always contains (they can
// share a chunk with other code, so the chunk graph alone cannot tell).
const FORBIDDEN_IN_STARTUP = [
  { name: "DOMPurify (loads with the document viewer and HTML previews)", marker: "SAFE_FOR_TEMPLATES" },
];
for (const { name, marker } of FORBIDDEN_IN_STARTUP) {
  const carriers = rows.filter((row) => readFileSync(join(dist, row.file), "utf8").includes(marker));
  if (carriers.length) {
    console.error(`${name} is part of startup, in: ${carriers.map((row) => row.file).join(", ")}`);
    process.exit(1);
  }
}

// The modal stack opens for common things (the delete-undo snackbar, onboarding), so it must not
// carry the camera QR scanner; that loads with the sheets that scan.
const modalStackKey = "src/ui/app/AppModalStack.tsx";
if (manifest[modalStackKey]) {
  const heavy = [...staticClosure([modalStackKey])].filter((key) => /qr-tools/.test(`${key} ${manifest[key].file}`));
  if (heavy.length) {
    console.error("The modal stack would load the QR tools:\n" + heavy.join("\n"));
    process.exit(1);
  }
}

// Chat is intentionally independent of the wallet being phased out. Protect the production
// chunk graph as well as source imports: opening Chat must not fetch the wallet modal, runtime,
// Cashu SDK or their supporting payment chunks. Dynamic imports below App are not traversed,
// except for ChatPage because opening Chat does load it.
const chatShellKey = Object.keys(manifest).find((key) => key.endsWith("/chat/ChatShell.tsx"));
if (chatShellKey) {
  const chatStarts = [chatShellKey, ...(manifest[chatShellKey].dynamicImports ?? [])];
  const chatFiles = [...staticClosure(chatStarts)].map((key) => `${key}\n${manifest[key].file}`);
  const forbidden = chatFiles.filter((entry) =>
    /cashu-sdk|cashuTokenMetadata|CashuWalletModal|WalletRuntime|useWalletHistory|cashuProofHelpers|nut16|lightning-/i.test(entry),
  );
  if (forbidden.length) {
    console.error("Opening Chat would load wallet/Cashu chunks:\n" + forbidden.join("\n"));
    process.exit(1);
  }
  if (!args.includes("--json")) console.log("Chat route: no wallet or Cashu chunks.");
}
