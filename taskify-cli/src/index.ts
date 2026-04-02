#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { readFile, writeFile } from "fs/promises";
import { createInterface } from "readline";
import { createRequire } from "module";
import { nip19, getPublicKey, generateSecretKey } from "nostr-tools";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { loadConfig, saveConfig, saveProfiles, DEFAULT_RELAYS, type ProfileConfig, type Contact, type BoardEntry } from "./config.js";
import { createNostrRuntime, type NostrRuntime } from "./nostrRuntime.js";
import { renderTable, renderTaskCard, renderJson } from "./render.js";
import { zshCompletion, bashCompletion, fishCompletion } from "./completions.js";
import { readCache, clearCache, CACHE_PATH, CACHE_TTL_MS } from "./taskCache.js";
import { runOnboarding } from "./onboarding.js";
import { buildCalendarEventDraft } from "./shared/eventDraft.js";
import {
  resolveBoardReference,
  buildBoardShareEnvelope,
  buildTaskShareEnvelope,
  buildCalendarEventInviteEnvelope,
  buildTaskAssignmentResponseEnvelope,
  buildEventRsvpResponseEnvelope,
  normalizeTaskRecurrence,
  normalizeTaskDocuments,
  normalizeTaskAssignees,
  normalizeTaskReminders,
} from "taskify-core";
import { resolveBoardForCommand } from "./shared/commandResolution.js";
import { parseBackupSnapshot, mergeBoardsFromBackup, mergeRelaysFromBackup } from "./shared/backupSync.js";
import { sendShareEnvelopeNip17, fetchShareInboxNip17 } from "./shared/shareTransport.js";
import { resolveBoardColumn, formatAvailableColumns } from "./shared/columnResolution.js";
import { publishProfile, fetchLatestProfileEvent } from "./profileMeta.js";
import { uploadImageToNip96 } from "./nip96Upload.js";
import { buildAttachmentDocuments, decryptAttachmentToDataUrl } from "./attachmentCrypto.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("taskify")
  .version(version)
  .description("Taskify CLI — manage tasks over Nostr")
  .option("-P, --profile <name>", "Use a specific profile for this command (does not change active profile)");

// ---- Validation helpers ----

function validateDue(due: string | undefined): void {
  if (!due) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    console.error(chalk.red(`Invalid --due format: "${due}". Expected YYYY-MM-DD.`));
    process.exit(1);
  }
}

function validatePriority(pri: string | undefined): void {
  if (!pri) return;
  if (!["1", "2", "3"].includes(pri)) {
    console.error(chalk.red(`Invalid --priority: "${pri}". Must be 1, 2, or 3.`));
    process.exit(1);
  }
}

function warnShortTaskId(taskId: string): void {
  if (taskId.length < 8) {
    console.warn(chalk.yellow(`Warning: taskId "${taskId}" is suspiciously short (< 8 chars). Attempting anyway.`));
  }
}

/**
 * Resolve a task by title + optional due-date when no taskId is provided.
 * Returns the matched taskId or exits with an error if ambiguous / not found.
 * This is the primary fallback for recurring instances whose IDs start with
 * "recurrence:" and can't be identified by a short 8-char prefix.
 */
async function resolveTaskIdByTitle(
  runtime: ReturnType<typeof initRuntime>,
  title: string,
  due: string | undefined,
  boardId: string | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string> {
  const tasks = await runtime.listTasks({
    boardId,
    status: "any",
    refresh: false,
    noCache: false,
  });
  const titleLower = title.toLowerCase();
  const duePart = due ? due.slice(0, 10) : undefined;
  const matches = tasks.filter((t) => {
    const titleMatch = t.title.toLowerCase().includes(titleLower);
    const dueMatch = !duePart || (t.dueISO ?? "").startsWith(duePart);
    return titleMatch && dueMatch;
  });
  if (matches.length === 0) {
    const hint = duePart ? ` due ${duePart}` : "";
    console.error(chalk.red(`No task found matching title "${title}"${hint}.`));
    console.error(chalk.dim("Tip: use taskify search to find the exact task first."));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Ambiguous: ${matches.length} tasks match "${title}"${duePart ? ` on ${duePart}` : ""}.`));
    console.error(chalk.dim("Add --due YYYY-MM-DD to narrow down, or pass the full task ID."));
    for (const t of matches.slice(0, 5)) {
      console.error(chalk.dim(`  ${t.id.slice(0, 20)}  ${t.title}  ${(t.dueISO ?? "").slice(0, 10)}`));
    }
    process.exit(1);
  }
  return matches[0].id;
}

const VALID_REMINDER_PRESETS = new Set(["0h", "5m", "15m", "30m", "1h", "1d", "1w"]);

function parseJsonOption(label: string, raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(chalk.red(`Invalid ${label} JSON.`));
    process.exit(1);
  }
}

function parseReminderOption(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parsed = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function normalizeAssigneeArgs(values: string[] | undefined): Array<{ pubkey: string; relay?: string; status?: "pending" | "accepted" | "declined" | "tentative"; respondedAt?: number }> | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = normalizeTaskAssignees(values.map((pubkey) => ({ pubkey })));
  return normalized as Array<{ pubkey: string; relay?: string; status?: "pending" | "accepted" | "declined" | "tentative"; respondedAt?: number }> | undefined;
}

function initRuntime(config: Parameters<typeof createNostrRuntime>[0]): NostrRuntime {
  try {
    return createNostrRuntime(config);
  } catch (err) {
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}

/**
 * Resolve a boardId for commands that need it.
 * - If --board given: look it up in config.boards by UUID or name; error if not found.
 * - If no --board and exactly one board configured: use it automatically.
 * - If no --board and multiple boards: print list and error.
 */
async function resolveBoardId(
  boardOpt: string | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string> {
  const resolved = resolveBoardForCommand(config.boards, boardOpt);
  if (resolved.ok) return resolved.boardId;

  if (boardOpt && resolved.listBoards) {
    console.error(chalk.red(`Board not found: "${boardOpt}". Known boards:`));
  } else {
    console.error(chalk.red(resolved.message));
  }

  if (resolved.listBoards) {
    for (const b of config.boards) {
      console.error(`  ${b.name} (${b.id})`);
    }
  }
  process.exit(resolved.exitCode);
}


async function mergeAttachmentDocuments(opts: {
  existing?: Record<string, unknown>[];
  files?: string[];
  boardId: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  fileServer?: string;
  documentsJson?: string;
  removeRefs?: string[];
  replace?: boolean;
}): Promise<unknown[] | null | undefined> {
  const base = opts.replace ? [] : [ ...((opts.existing || []) as unknown[]) ];
  const removals = new Set((opts.removeRefs || []).map((v) => v.toLowerCase()));
  const kept = base.filter((doc, idx) => {
    if (removals.has(String(idx + 1))) return false;
    const name = typeof (doc as any)?.name === "string" ? (doc as any).name.toLowerCase() : "";
    for (const ref of removals) {
      if (name && name.includes(ref)) return false;
    }
    return true;
  });
  const fromJson = normalizeTaskDocuments(parseJsonOption("--documents-json", opts.documentsJson));
  const generated = (await resolveAttachmentDocuments({ files: opts.files, boardId: opts.boardId, config: opts.config, fileServer: opts.fileServer, documentsJson: undefined })) || [];
  const merged = [...kept, ...(fromJson || []), ...generated];
  if (opts.replace && merged.length === 0) return null;
  if (!opts.replace && opts.removeRefs?.length === 0 && !(opts.files || []).length && opts.documentsJson === undefined) return undefined;
  return normalizeTaskDocuments(merged) as unknown[] | undefined;
}

async function resolveAttachmentDocuments(opts: {
  files?: string[];
  boardId: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  fileServer?: string;
  documentsJson?: string;
}): Promise<unknown[] | undefined> {
  const fromJson = normalizeTaskDocuments(parseJsonOption("--documents-json", opts.documentsJson));
  const files = (opts.files || []).filter(Boolean);
  if (!files.length) return fromJson as unknown[] | undefined;
  const boardEntry = opts.config.boards.find((b) => b.id === opts.boardId);
  const generated = await buildAttachmentDocuments({
    files,
    boardId: opts.boardId,
    shared: !!boardEntry,
    config: opts.config,
    fileServer: opts.fileServer,
  });
  const merged = [...(fromJson || []), ...generated as unknown[]];
  return normalizeTaskDocuments(merged) as unknown[] | undefined;
}


function extractDocumentUrl(doc: Record<string, unknown>): string | undefined {
  if (typeof doc.remoteUrl === "string" && doc.remoteUrl.trim()) return doc.remoteUrl.trim();
  if (typeof doc.url === "string" && doc.url.trim()) return doc.url.trim();
  return undefined;
}

function resolveDocumentByRef(documents: Record<string, unknown>[] | undefined, ref: string): { index: number; doc: Record<string, unknown> } | null {
  if (!Array.isArray(documents) || documents.length === 0) return null;
  const indexNum = Number.parseInt(ref, 10);
  if (Number.isFinite(indexNum) && indexNum >= 1 && indexNum <= documents.length) {
    return { index: indexNum - 1, doc: documents[indexNum - 1] as Record<string, unknown> };
  }
  const lowered = ref.toLowerCase();
  const idx = documents.findIndex((doc) => {
    const name = typeof doc.name === "string" ? doc.name.toLowerCase() : "";
    return name.includes(lowered);
  });
  return idx >= 0 ? { index: idx, doc: documents[idx] as Record<string, unknown> } : null;
}

// ---- board command group ----
const boardCmd = program
  .command("board")
  .description("Manage boards");

boardCmd
  .command("list")
  .description("List all configured boards")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.boards.length === 0) {
      console.log(chalk.dim("No boards configured. Use: taskify board join <id> --name <name>"));
      process.exit(0);
    }

    // Auto-sync any board whose stored name looks like a raw UUID prefix
    // (happens when a board was joined without a --name or metadata wasn't fetched).
    // This ensures agents always see human-readable names without a manual board sync step.
    const UUID_PREFIX_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
    const stale = config.boards.filter(
      (b) => UUID_PREFIX_RE.test(b.name) || b.name === b.id || b.name === b.id.slice(0, 8),
    );

    if (stale.length > 0) {
      process.stderr.write(chalk.dim(`Fetching display names for ${stale.length} board(s)…\n`));
      try {
        const runtime = initRuntime(config);
        for (const b of stale) {
          try {
            const meta = await runtime.syncBoard(b.id);
            if (meta.name) b.name = meta.name;
            if (meta.kind) b.kind = meta.kind;
            if (meta.columns) b.columns = meta.columns;
          } catch { /* non-fatal — show whatever name we have */ }
        }
        await runtime.disconnect();
        await saveConfig(config);
      } catch { /* non-fatal */ }
    }

    for (const b of config.boards) {
      const relays = b.relays?.length ? `  [${b.relays.join(", ")}]` : "";
      console.log(`  ${chalk.bold(b.name.padEnd(16))} ${chalk.dim(b.id)}${relays}`);
    }
    process.exit(0);
  });

boardCmd
  .command("join <boardId>")
  .description("Join a board by its UUID")
  .option("--name <name>", "Human-readable name for this board")
  .option("--relay <url>", "Additional relay URL for this board")
  .action(async (boardId: string, opts) => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(boardId)) {
      console.warn(chalk.yellow(`Warning: "${boardId}" does not look like a UUID.`));
    }
    const config = await loadConfig(program.opts().profile as string | undefined);
    const existing = config.boards.find((b) => b.id === boardId);
    if (existing) {
      console.log(chalk.dim(`Already on board ${existing.name} (${boardId})`));
      process.exit(0);
    }
    const name = opts.name ?? boardId.slice(0, 8);
    const entry: { id: string; name: string; relays?: string[] } = { id: boardId, name };
    if (opts.relay) {
      entry.relays = [opts.relay];
    }
    config.boards.push(entry);
    await saveConfig(config);
    console.log(chalk.green(`✓ Joined board ${name} (${boardId})`));
    // Auto-sync board metadata immediately after joining
    try {
      const runtime = initRuntime(config);
      const meta = await runtime.syncBoard(boardId);
      if (meta.kind || (meta.columns && meta.columns.length > 0)) {
        const colCount = meta.columns?.length ?? 0;
        console.log(chalk.dim(`  Synced: kind=${meta.kind ?? "?"}, columns=${colCount}`));
      }
      await runtime.disconnect();
    } catch { /* non-fatal if sync fails on join */ }
    process.exit(0);
  });

boardCmd
  .command("sync [boardId]")
  .description("Sync board metadata (kind, columns) from Nostr")
  .action(async (boardId?: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.boards.length === 0) {
      console.error(chalk.red("No boards configured."));
      process.exit(1);
    }
    const toSync = boardId
      ? (() => {
          const entry = resolveBoardReference(config.boards, boardId);
          if (!entry) {
            console.error(chalk.red(`Board not found: "${boardId}"`));
            process.exit(1);
          }
          return [entry];
        })()
      : config.boards;
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      for (const entry of toSync) {
        try {
          const meta = await runtime.syncBoard(entry.id);
          const colCount = meta.columns?.length ?? 0;
          const kindStr = meta.kind ?? "unknown";
          const reloadedEntry = (await loadConfig(program.opts().profile as string | undefined)).boards.find((b) => b.id === entry.id);
          const childrenCount = reloadedEntry?.children?.length ?? 0;
          const childrenStr = kindStr === "compound" ? `, children: ${childrenCount}` : "";
          console.log(chalk.green(`✓ Synced: ${entry.name} (kind: ${kindStr}, columns: ${colCount}${childrenStr})`));
        } catch (err) {
          console.error(chalk.red(`  ✗ Failed to sync ${entry.name}: ${String(err)}`));
          exitCode = 1;
        }
      }
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

boardCmd
  .command("leave <boardId>")
  .description("Remove a board from config")
  .action(async (boardId: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const before = config.boards.length;
    config.boards = config.boards.filter((b) => b.id !== boardId);
    if (config.boards.length === before) {
      console.error(chalk.red(`Board not found: ${boardId}`));
      process.exit(1);
    }
    await saveConfig(config);
    console.log(chalk.green(`✓ Left board ${boardId}`));
    process.exit(0);
  });

boardCmd
  .command("columns [board]")
  .description("Show cached columns/lists for a board (or all boards)")
  .option("--json", "Output as JSON")
  .action(async (boardArg: string | undefined, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.boards.length === 0) {
      console.log(chalk.dim("No boards configured. Use: taskify board join <id> --name <name>"));
      process.exit(0);
    }

    const boards = boardArg
      ? (() => {
          const entry = resolveBoardReference(config.boards, boardArg);
          if (!entry) {
            console.error(chalk.red(`Board not found: "${boardArg}"`));
            process.exit(1);
          }
          return [entry];
        })()
      : config.boards;

    if (opts.json) {
      renderJson(boards.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind ?? "unknown",
        columns: b.columns ?? [],
      })));
      process.exit(0);
    }

    for (const b of boards) {
      const kindStr = b.kind ? ` (${b.kind})` : "";
      console.log(chalk.bold(`${b.name}${kindStr}:`));
      if (!b.columns || b.columns.length === 0) {
        console.log(chalk.dim(`  — no columns/lists cached (run: taskify board sync)`));
      } else {
        for (const col of b.columns) {
          console.log(`  ${chalk.bold(col.name)}  ${chalk.dim(col.id.slice(0, 8))}`);
        }
      }
    }
    process.exit(0);
  });

boardCmd
  .command("children <board>")
  .description("List children of a compound board")
  .action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const entry = resolveBoardReference(config.boards, boardArg);
    if (!entry) {
      console.error(chalk.red(`Board not found: "${boardArg}"`));
      process.exit(1);
    }
    if (entry.kind !== "compound") {
      console.log(chalk.dim(`Board is not a compound board (kind: ${entry.kind ?? "unknown"})`));
      process.exit(0);
    }
    if (!entry.children || entry.children.length === 0) {
      console.log(chalk.dim("No children cached — run: taskify board sync"));
      process.exit(0);
    }
    console.log(chalk.bold(`Children of ${entry.name}:`));
    for (const childId of entry.children) {
      const childEntry = config.boards.find((b) => b.id === childId);
      if (childEntry) {
        console.log(`  ${chalk.cyan(childEntry.name.padEnd(16))} ${chalk.dim(childId)}`);
      } else {
        console.log(`  ${chalk.dim(childId)} ${chalk.yellow("(not in local config)")}`);
      }
    }
    process.exit(0);
  });

boardCmd
  .command("column-add <board> <name>")
  .description("Add a list column")
  .action(async (boardArg: string, name: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) throw new Error(`Board not found: "${boardArg}"`);
      if (entry.kind !== "lists") throw new Error("Column operations are only supported for list boards");
      const next = [...(entry.columns ?? []), { id: crypto.randomUUID(), name }];
      const updated = await runtime.updateBoard(entry.id, { columns: next });
      if (!updated) throw new Error("Failed to update board");
      console.log(chalk.green(`✓ Added column \"${name}\"`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally { await runtime.disconnect(); }
  });

boardCmd
  .command("column-rename <board> <columnRef> <name>")
  .description("Rename a list column by id or name")
  .action(async (boardArg: string, columnRef: string, name: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry || entry.kind !== "lists") throw new Error("List board not found");
      const columns = [...(entry.columns ?? [])];
      const idx = columns.findIndex((c) => c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase());
      if (idx === -1) throw new Error(`Column not found: ${columnRef}`);
      columns[idx] = { ...columns[idx], name };
      await runtime.updateBoard(entry.id, { columns });
      console.log(chalk.green(`✓ Renamed column to \"${name}\"`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally { await runtime.disconnect(); }
  });

boardCmd
  .command("column-delete <board> <columnRef>")
  .description("Delete a list column by id or name")
  .action(async (boardArg: string, columnRef: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry || entry.kind !== "lists") throw new Error("List board not found");
      const before = entry.columns ?? [];
      const after = before.filter((c) => !(c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase()));
      if (after.length === before.length) throw new Error(`Column not found: ${columnRef}`);
      await runtime.updateBoard(entry.id, { columns: after });
      console.log(chalk.green(`✓ Deleted column: ${columnRef}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally { await runtime.disconnect(); }
  });

boardCmd
  .command("column-reorder <board> <columnRef> <position>")
  .description("Reorder a list column by id or name to 1-based position")
  .action(async (boardArg: string, columnRef: string, positionRaw: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const pos = Number.parseInt(positionRaw, 10);
      if (!Number.isFinite(pos) || pos < 1) throw new Error("Position must be >= 1");
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry || entry.kind !== "lists") throw new Error("List board not found");
      const columns = [...(entry.columns ?? [])];
      const idx = columns.findIndex((c) => c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase());
      if (idx === -1) throw new Error(`Column not found: ${columnRef}`);
      const [moved] = columns.splice(idx, 1);
      const target = Math.min(columns.length, pos - 1);
      columns.splice(target, 0, moved);
      await runtime.updateBoard(entry.id, { columns });
      console.log(chalk.green(`✓ Reordered column: ${moved.name} -> ${target + 1}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally { await runtime.disconnect(); }
  });

boardCmd
  .command("rename <board> <name>")
  .description("Rename board")
  .action(async (boardArg: string, name: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) throw new Error(`Board not found: ${boardArg}`);
      await runtime.updateBoard(entry.id, { name });
      console.log(chalk.green(`✓ Renamed board to ${name}`));
      process.exit(0);
    } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

boardCmd.command("archive <board>").description("Archive board").action(async (boardArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { archived: true }); console.log(chalk.green("✓ Board archived")); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("unarchive <board>").description("Unarchive board").action(async (boardArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { archived: false }); console.log(chalk.green("✓ Board unarchived")); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("hide <board>").description("Hide board").action(async (boardArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { hidden: true }); console.log(chalk.green("✓ Board hidden")); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("unhide <board>").description("Unhide board").action(async (boardArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { hidden: false }); console.log(chalk.green("✓ Board visible")); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("index-card <board> <state>").description("Set index-card mode on/off").action(async (boardArg: string, state: string) => {
  const enabled = ["on", "true", "1", "enable"].includes(state.toLowerCase());
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { indexCardEnabled: enabled }); console.log(chalk.green(`✓ Index-card ${enabled ? "enabled" : "disabled"}`)); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("clear-completed <board>").description("Delete completed tasks in board").action(async (boardArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); const count = await runtime.clearCompleted(entry.id); console.log(chalk.green(`✓ Cleared ${count} completed task(s)`)); process.exit(0); }
  catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("share-settings <board> <json>").description("Update board share settings (JSON object)").action(async (boardArg: string, jsonRaw: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try {
    const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`);
    const parsed = JSON.parse(jsonRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("share-settings must be a JSON object");
    await runtime.updateBoard(entry.id, { shareSettings: parsed as Record<string, unknown> });
    console.log(chalk.green("✓ Updated share settings")); process.exit(0);
  } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd
  .command("sort <board> [mode] [direction]")
  .description("Get or set board sort settings (modes: manual|due|priority|created|alpha, directions: asc|desc)")
  .action(async (boardArg: string, mode?: string, direction?: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const entry = resolveBoardReference(config.boards, boardArg);
    if (!entry) {
      console.error(chalk.red(`Board not found: "${boardArg}"`));
      process.exit(1);
    }
    if (!mode) {
      console.log(`Sort mode:      ${entry.sortMode ?? "manual (default)"}`);
      console.log(`Sort direction: ${entry.sortDirection ?? "asc (default)"}`);
      process.exit(0);
    }
    const VALID_MODES = ["manual", "due", "priority", "created", "alpha"];
    const VALID_DIRS = ["asc", "desc"];
    if (!VALID_MODES.includes(mode)) {
      console.error(chalk.red(`Invalid sort mode. Use: ${VALID_MODES.join(", ")}`));
      process.exit(1);
    }
    if (direction && !VALID_DIRS.includes(direction)) {
      console.error(chalk.red(`Invalid direction. Use: asc, desc`));
      process.exit(1);
    }
    const runtime = initRuntime(config);
    try {
      await runtime.updateBoard(entry.id, {
        sortMode: mode as BoardEntry["sortMode"],
        sortDirection: ((direction ?? "asc") as BoardEntry["sortDirection"]),
      });
      console.log(chalk.green(`✓ Sort set: ${mode} ${direction ?? "asc"}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

boardCmd.command("child-add <board> <child>").description("Add child board to a compound board").action(async (boardArg: string, childArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try {
    const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
    const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
    const children = [...(entry.children ?? [])]; if (!children.includes(childId)) children.push(childId);
    await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Added child: ${childId}`)); process.exit(0);
  } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("child-remove <board> <child>").description("Remove child board from a compound board").action(async (boardArg: string, childArg: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try {
    const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
    const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
    const children = (entry.children ?? []).filter((id) => id !== childId);
    await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Removed child: ${childId}`)); process.exit(0);
  } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

boardCmd.command("child-reorder <board> <child> <position>").description("Reorder child board in a compound board").action(async (boardArg: string, childArg: string, positionRaw: string) => {
  const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
  try {
    const pos = Number.parseInt(positionRaw, 10); if (!Number.isFinite(pos) || pos < 1) throw new Error("Position must be >= 1");
    const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
    const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
    const children = [...(entry.children ?? [])]; const idx = children.indexOf(childId); if (idx === -1) throw new Error(`Child not found: ${childId}`);
    const [moved] = children.splice(idx, 1); const target = Math.min(children.length, pos - 1); children.splice(target, 0, moved);
    await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Reordered child: ${childId} -> ${target + 1}`)); process.exit(0);
  } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
});

// ---- boards (alias for board list) ----
program
  .command("boards")
  .description("List configured boards (alias for: board list)")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.boards.length === 0) {
      console.log(chalk.dim("No boards configured. Use: taskify board join <id> --name <name>"));
      process.exit(0);
    }

    const UUID_PREFIX_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
    const stale = config.boards.filter(
      (b) => UUID_PREFIX_RE.test(b.name) || b.name === b.id || b.name === b.id.slice(0, 8),
    );

    if (stale.length > 0) {
      process.stderr.write(chalk.dim(`Fetching display names for ${stale.length} board(s)…\n`));
      try {
        const runtime = initRuntime(config);
        for (const b of stale) {
          try {
            const meta = await runtime.syncBoard(b.id);
            if (meta.name) b.name = meta.name;
            if (meta.kind) b.kind = meta.kind;
            if (meta.columns) b.columns = meta.columns;
          } catch { /* non-fatal */ }
        }
        await runtime.disconnect();
        await saveConfig(config);
      } catch { /* non-fatal */ }
    }

    for (const b of config.boards) {
      console.log(`  ${chalk.bold(b.name.padEnd(16))} ${chalk.dim(b.id)}`);
    }
    process.exit(0);
  });

// ---- event command group ----
const eventCmd = program
  .command("event")
  .description("Manage calendar events");

eventCmd
  .command("list")
  .description("List events")
  .option("--board <id|name>", "Filter by board")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const events = await runtime.listEvents({ boardId });
      if (opts.json) {
        renderJson(events);
      } else if (events.length === 0) {
        console.log(chalk.dim("No events found."));
      } else {
        const showBoard = !boardId;
        for (const e of events) {
          const when = e.kind === "time"
            ? `${e.startISO ?? ""}${e.endISO ? ` → ${e.endISO}` : ""}`
            : `${e.startDate ?? ""}${e.endDate ? ` → ${e.endDate}` : ""}`;
          const boardLabel = showBoard ? ` ${chalk.dim(`[${e.boardName ?? e.boardId}]`)}` : "";
          console.log(`${chalk.cyan(e.id.slice(0, 8))}  ${e.title}${boardLabel}  ${chalk.dim(when)}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

eventCmd
  .command("add <title>")
  .description("Create an event")
  .option("--board <id|name>", "Board to add to (required if multiple boards configured)")
  .option("--date <YYYY-MM-DD>", "Start date (required)")
  .option("--end-date <YYYY-MM-DD>", "End date for all-day range")
  .option("--time <HH:mm>", "Start time for timed event")
  .option("--end-time <HH:mm>", "End time for timed event")
  .option("--tz <iana>", "Timezone for timed event")
  .option("--description <text>", "Optional description")
  .option("--column <id|name>", "List column placement")
  .option("--recurrence-json <json>", "Recurrence object JSON")
  .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
  .option("--invitee <npubOrHex>", "Invitee pubkey/npub (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--documents-json <json>", "Documents/attachments array JSON")
  .option("--attach <path>", "Attach local file/image (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
  .option("--json", "Output as JSON")
  .action(async (title: string, opts) => {
    if (!opts.date) {
      console.error(chalk.red("--date is required (YYYY-MM-DD)"));
      process.exit(1);
    }
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    try {
      const draft = buildCalendarEventDraft({
        boardId,
        title,
        date: opts.date,
        endDate: opts.endDate,
        time: opts.time,
        endTime: opts.endTime,
        timeZone: opts.tz,
      });
      const boardEntry = config.boards.find((b) => b.id === boardId)!;
      if (boardEntry.kind === "lists" && (!boardEntry.columns || boardEntry.columns.length === 0)) {
        throw new Error(`Board "${boardEntry.name}" has no columns/lists yet. Add one first.`);
      }
      const resolvedColumn = opts.column ? resolveColumnOrExit(boardEntry, opts.column) : null;
      const recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson));
      const reminders = normalizeTaskReminders(parseReminderOption(opts.reminders));
      const documents = await resolveAttachmentDocuments({ files: opts.attach as string[], boardId, config, fileServer: opts.fileServer, documentsJson: opts.documentsJson });
      const invitees = normalizeAssigneeArgs(opts.invitee as string[])?.map((a) => ({ pubkey: a.pubkey, relay: a.relay }));
      const created = await runtime.createEvent({
        ...draft,
        description: opts.description,
        columnId: resolvedColumn?.id,
        recurrence: recurrence as any,
        reminders: reminders as any,
        participants: invitees,
        documents: documents as any,
      });
      if (opts.json) renderJson(created);
      else console.log(chalk.green(`✓ Created event: ${created.title} (${created.id.slice(0, 8)})`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

eventCmd
  .command("show <eventId>")
  .description("Show event details")
  .option("--board <id|name>", "Board to search in")
  .option("--json", "Output as JSON")
  .action(async (eventId: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const event = await runtime.getEvent(eventId, boardId);
      if (!event) {
        console.error(chalk.red(`Event not found: ${eventId}`));
        process.exit(1);
      }
      if (opts.json) renderJson(event);
      else {
        console.log(chalk.bold(event.title));
        console.log(`id: ${event.id}`);
        console.log(`board: ${event.boardName ?? event.boardId}`);
        console.log(`kind: ${event.kind}`);
        if (event.kind === "time") console.log(`when: ${event.startISO}${event.endISO ? ` → ${event.endISO}` : ""}`);
        else console.log(`when: ${event.startDate}${event.endDate ? ` → ${event.endDate}` : ""}`);
        if (event.description) console.log(`description: ${event.description}`);
        if (event.recurrence) console.log(`recurrence: ${JSON.stringify(event.recurrence)}`);
        if (Array.isArray(event.reminders) && event.reminders.length > 0) console.log(`reminders: ${event.reminders.join(", ")}`);
        if (Array.isArray(event.participants) && event.participants.length > 0) {
          console.log(`invitees: ${event.participants.length}`);
          event.participants.forEach((p) => console.log(`  - ${p.pubkey}${p.role ? ` (${p.role})` : ""}`));
        }
        if (Array.isArray(event.documents) && event.documents.length > 0) {
          console.log(`documents: ${event.documents.length}`);
          event.documents.forEach((doc: any, idx: number) => {
            const name = typeof doc?.name === "string" ? doc.name : `document-${idx + 1}`;
            const url = typeof doc?.remoteUrl === "string" ? doc.remoteUrl : (typeof doc?.url === "string" ? doc.url : "");
            const flags = [doc?.encrypted === true ? "encrypted" : null, typeof doc?.kind === "string" ? doc.kind : null].filter(Boolean).join(", ");
            console.log(`  - ${name}${flags ? ` [${flags}]` : ""}${url ? ` (${url})` : ""}`);
          });
        }
        if (event.columnId) console.log(`column: ${event.columnId}`);
        if (event.rsvpStatus) console.log(`rsvp status: ${event.rsvpStatus}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

eventCmd
  .command("update <eventId>")
  .description("Update an event")
  .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
  .option("--title <text>", "Update title")
  .option("--description <text>", "Update description")
  .option("--start-date <YYYY-MM-DD>", "Update date event start")
  .option("--end-date <YYYY-MM-DD>", "Update date event end")
  .option("--start-iso <iso>", "Update timed event start ISO")
  .option("--end-iso <iso>", "Update timed event end ISO")
  .option("--tz <iana>", "Update timed event timezone")
  .option("--column <id|name>", "Update list column placement")
  .option("--recurrence-json <json>", "Update recurrence object JSON")
  .option("--reminders <csv>", "Update reminder presets csv")
  .option("--invitee <npubOrHex>", "Replace invitees (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--documents-json <json>", "Replace documents/attachments with array JSON")
  .option("--attach <path>", "Append local file/image attachment (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--remove-attachment <ref>", "Remove attachment by 1-based index or partial name (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--replace-attachments", "Replace all existing attachments with provided attachment inputs")
  .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
  .option("--json", "Output as JSON")
  .action(async (eventId: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const boardEntry = boardId ? config.boards.find((b) => b.id === boardId) : undefined;
      const resolvedColumn = opts.column && boardEntry ? resolveColumnOrExit(boardEntry, opts.column) : null;
      const recurrence = opts.recurrenceJson !== undefined ? normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson)) ?? null : undefined;
      const reminders = opts.reminders !== undefined ? normalizeTaskReminders(parseReminderOption(opts.reminders)) ?? null : undefined;
      let documents = undefined;
      if (opts.documentsJson !== undefined || ((opts.attach as string[]).length > 0) || ((opts.removeAttachment as string[]).length > 0) || opts.replaceAttachments) {
        const existingEvent = await runtime.getEvent(eventId, boardId);
        if (!existingEvent) {
          console.error(chalk.red(`Event not found: ${eventId}`));
          process.exit(1);
        }
        documents = await mergeAttachmentDocuments({
          existing: existingEvent.documents as Record<string, unknown>[] | undefined,
          files: opts.attach as string[],
          boardId: (boardId || existingEvent.boardId),
          config,
          fileServer: opts.fileServer,
          documentsJson: opts.documentsJson,
          removeRefs: opts.removeAttachment as string[],
          replace: !!opts.replaceAttachments,
        }) ?? null;
      }
      const invitees = (opts.invitee as string[]).length > 0
        ? normalizeAssigneeArgs(opts.invitee as string[])?.map((a) => ({ pubkey: a.pubkey, relay: a.relay })) ?? []
        : undefined;
      const updated = await runtime.updateEvent(eventId, boardId, {
        title: opts.title,
        description: opts.description,
        startDate: opts.startDate,
        endDate: opts.endDate,
        startISO: opts.startIso,
        endISO: opts.endIso,
        startTzid: opts.tz,
        endTzid: opts.tz,
        columnId: resolvedColumn?.id,
        recurrence: recurrence as any,
        reminders: reminders as any,
        participants: invitees,
        documents: documents as any,
      });
      if (!updated) {
        console.error(chalk.red(`Event not found: ${eventId}`));
        process.exit(1);
      }
      if (opts.json) renderJson(updated);
      else console.log(chalk.green(`✓ Updated event: ${updated.title}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

eventCmd
  .command("delete <eventId>")
  .description("Delete an event")
  .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
  .option("--json", "Output as JSON")
  .action(async (eventId: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const deleted = await runtime.deleteEvent(eventId, boardId);
      if (!deleted) {
        console.error(chalk.red(`Event not found: ${eventId}`));
        process.exit(1);
      }
      if (opts.json) renderJson(deleted);
      else console.log(chalk.green(`✓ Deleted event: ${deleted.title}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

eventCmd
  .command("invite <eventId> <npubOrHex>")
  .description("Share an event invite over NIP-17 DM")
  .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
  .action(async (eventId: string, npubOrHex: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const recipient = npubOrHexToHex(npubOrHex);
      const event = await runtime.getEvent(eventId, opts.board ? await resolveBoardId(opts.board, config) : undefined);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      const senderHex = nsecToHexOrThrow(config.nsec);
      const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
      const eventKey = `taskify:event:${event.id}`;
      const canonical = `31923:${getPublicKey(hexToBytes(senderHex))}:${event.id}`;
      const view = `31924:${getPublicKey(hexToBytes(senderHex))}:${event.id}`;
      const envelope = buildCalendarEventInviteEnvelope({
        eventId: event.id,
        canonical,
        view,
        eventKey,
        inviteToken: `${event.id}:${recipient.slice(0, 16)}`,
        title: event.title,
        start: event.startISO ?? event.startDate,
        end: event.endISO ?? event.endDate,
        relays: config.relays,
      }, { npub: senderNpub });
      await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: recipient, relays: config.relays });
      console.log(chalk.green("✓ Event invite shared."));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

eventCmd
  .command("rsvp <eventId> <accepted|declined|tentative>")
  .description("Send RSVP response for an event invite")
  .option("--to <npubOrHex>", "Invite sender public key")
  .action(async (eventId: string, status: "accepted" | "declined" | "tentative", opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    let exitCode = 0;
    try {
      if (!opts.to) throw new Error("--to <npubOrHex> is required.");
      const senderHex = nsecToHexOrThrow(config.nsec);
      const envelope = buildEventRsvpResponseEnvelope({
        eventId,
        status,
        respondedAt: new Date().toISOString(),
      });
      await sendShareEnvelopeNip17({
        envelope,
        senderSecretHex: senderHex,
        recipientPubkeyHex: npubOrHexToHex(opts.to),
        relays: config.relays,
      });
      console.log(chalk.green("✓ RSVP sent."));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  });

const shareCmd = program
  .command("share")
  .description("Share board/task/event envelopes over NIP-17 and process inbox messages");

shareCmd
  .command("board <board> <npubOrHex>")
  .description("Share a board envelope over NIP-17 DM")
  .action(async (boardRef: string, npubOrHex: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const entry = resolveBoardReference(config.boards, boardRef);
    if (!entry) {
      console.error(chalk.red(`Board not found: ${boardRef}`));
      process.exit(1);
    }
    try {
      const senderHex = nsecToHexOrThrow(config.nsec);
      const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
      const envelope = buildBoardShareEnvelope(entry.id, entry.name, config.relays, { npub: senderNpub });
      await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
      console.log(chalk.green("✓ Board share sent."));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

shareCmd
  .command("task <taskId> <npubOrHex>")
  .description("Share a task envelope over NIP-17 DM")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--assignment", "Send as assignment request")
  .action(async (taskId: string, npubOrHex: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const task = await runtime.getTask(taskId, opts.board ? await resolveBoardId(opts.board, config) : undefined);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const senderHex = nsecToHexOrThrow(config.nsec);
      const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
      const envelope = buildTaskShareEnvelope({
        type: "task",
        title: task.title,
        note: task.note,
        priority: task.priority,
        dueISO: task.dueISO,
        dueDateEnabled: task.dueDateEnabled,
        dueTimeEnabled: task.dueTimeEnabled,
        recurrence: task.recurrence,
        reminders: task.reminders,
        documents: task.documents,
        sourceTaskId: task.id,
        assignment: opts.assignment === true ? true : undefined,
        assignees: task.assignees?.map((a) => ({ pubkey: a.pubkey })),
        relays: config.relays,
      }, { npub: senderNpub });
      await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
      console.log(chalk.green("✓ Task share sent."));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

shareCmd
  .command("event <eventId> <npubOrHex>")
  .description("Share an event invite envelope over NIP-17 DM")
  .option("--board <id|name>", "Board the event belongs to (optional)")
  .action(async (eventId: string, npubOrHex: string, opts) => {
    await program.parseAsync(["node", "taskify", "event", "invite", eventId, npubOrHex, ...(opts.board ? ["--board", opts.board] : [])], { from: "user" });
  });

shareCmd
  .command("respond-assignment <taskId> <accepted|declined|tentative> <npubOrHex>")
  .description("Send task assignment response over NIP-17 DM")
  .action(async (taskId: string, status: "accepted" | "declined" | "tentative", npubOrHex: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    try {
      const senderHex = nsecToHexOrThrow(config.nsec);
      const envelope = buildTaskAssignmentResponseEnvelope({ taskId, status, respondedAt: new Date().toISOString() });
      await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
      console.log(chalk.green("✓ Assignment response sent."));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

shareCmd
  .command("inbox")
  .description("Fetch NIP-17 share inbox messages")
  .option("--apply", "Apply actionable share messages (board join/task create)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const senderHex = nsecToHexOrThrow(config.nsec);
      const inbox = await fetchShareInboxNip17({ recipientSecretHex: senderHex, relays: config.relays, limit: 100 });
      if (opts.apply) {
        const processed = new Set(config.processedInboxRumorIds ?? []);
        for (const item of inbox) {
          if (processed.has(item.rumorId)) continue;
          if (item.envelope.item.type === "board") {
            const boardItem = item.envelope.item as { boardId: string; boardName?: string; relays?: string[] };
            const exists = config.boards.some((b) => b.id === boardItem.boardId);
            if (!exists) {
              config.boards.push({ id: boardItem.boardId, name: boardItem.boardName ?? boardItem.boardId, relays: boardItem.relays ?? config.relays });
            }
          }
          if (item.envelope.item.type === "task") {
            const taskItem = item.envelope.item as { title: string; note?: string; assignees?: Array<{ pubkey: string }> };
            await runtime.createTaskFull({
              boardId: runtime.getDefaultBoardId() ?? config.boards[0]?.id ?? "inbox",
              title: taskItem.title,
              note: taskItem.note ?? "",
              inboxItem: true,
              assignees: taskItem.assignees?.map((a) => ({ pubkey: a.pubkey })),
            });
          }
          if (item.envelope.item.type === "task-assignment-response") {
            await runtime.applyTaskAssignmentResponse(item.envelope.item.taskId, item.senderPubkey, item.envelope.item.status, item.envelope.item.respondedAt);
          }
          if (item.envelope.item.type === "event-rsvp-response") {
            await runtime.applyEventRsvpResponse(item.envelope.item.eventId, item.senderPubkey, item.envelope.item.status, item.envelope.item.respondedAt);
          }
          processed.add(item.rumorId);
        }
        config.processedInboxRumorIds = Array.from(processed).slice(-2000);
        await saveConfig(config);
      }
      if (opts.json) renderJson(inbox);
      else inbox.forEach((m) => console.log(`${chalk.cyan(m.envelope.item.type)} ${chalk.dim(m.senderPubkey.slice(0, 12))}`));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

function resolveColumnOrExit(
  entry: Awaited<ReturnType<typeof loadConfig>>["boards"][number],
  columnArg: string,
): { id: string; name: string } {
  const resolved = resolveBoardColumn(entry, columnArg);
  if (resolved.ok) return resolved.column;

  const available = formatAvailableColumns(resolved.available);
  if (resolved.reason === "no-columns") {
    console.error(chalk.red(`Board "${entry.name}" has no columns/lists yet.`));
    console.error(chalk.dim("Add a list first (PWA or `taskify board column-add`) then retry."));
    process.exit(1);
  }
  if (resolved.reason === "ambiguous") {
    console.error(chalk.red(`Ambiguous column "${columnArg}" on board "${entry.name}".`));
    console.error(chalk.dim("Use --column <id> to target deterministically."));
    console.error(chalk.dim(`Available columns:\n${available}`));
    process.exit(1);
  }
  console.error(chalk.red(`Column not found: "${columnArg}" on board "${entry.name}".`));
  console.error(chalk.dim(`Available columns:\n${available}`));
  process.exit(1);
}

// ---- list ----
program
  .command("list")
  .description("List tasks")
  .option("--board <id|name>", "Filter by board (UUID or name)")
  .option("--status <status>", "Filter: open (default), done, or any", "open")
  .option("--column <id|name>", "Filter by column id or name (use day names for week boards)")
  .option("--refresh", "Bypass cache and fetch live from relay")
  .option("--no-cache", "Do not fall back to stale cache if relay returns empty")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      let columnId: string | undefined;
      let columnName: string | undefined;
      const resolvedBoardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const resolvedBoardEntry = resolvedBoardId
        ? config.boards.find((b) => b.id === resolvedBoardId)
        : undefined;

      if (opts.column) {
        // Column requires a single board to be resolvable
        const singleBoardId = resolvedBoardId
          ?? (config.boards.length === 1 ? config.boards[0].id : undefined);
        if (!singleBoardId) {
          console.error(chalk.red("--column requires --board when multiple boards are configured"));
          process.exit(1);
        }
        const boardEntry = config.boards.find((b) => b.id === singleBoardId)!;
        const resolved = resolveColumnOrExit(boardEntry, opts.column);
        columnId = resolved.id;
        columnName = resolved.name;
      }

      const tasks = await runtime.listTasks({
        boardId: resolvedBoardId,
        status: opts.status as "open" | "done" | "any",
        columnId,
        refresh: !!opts.refresh,
        noCache: !opts.cache,
      });
      if (opts.json) {
        renderJson(tasks);
      } else {
        if (tasks.length === 0) {
          console.log(chalk.dim("No tasks found."));
        } else {
          renderTable(tasks, config.trustedNpubs, columnName, resolvedBoardEntry?.columns);
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- upcoming ----
program
  .command("upcoming")
  .description("Show open tasks due within N days")
  .option("--days <n>", "Number of days ahead (default: 14)")
  .option("--board <id|name>", "Filter to a specific board")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const days = opts.days ? parseInt(opts.days, 10) : 14;
      const resolvedBoardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const allTasks = await runtime.listTasks({ boardId: resolvedBoardId, status: "open" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const upcoming = allTasks.filter(
        (t) => t.dueDateEnabled === true && t.dueISO && t.dueISO >= todayStr && t.dueISO <= cutoffStr,
      );

      // Sort: primary = dueISO asc, secondary = priority asc (1=highest)
      upcoming.sort((a, b) => {
        if (a.dueISO < b.dueISO) return -1;
        if (a.dueISO > b.dueISO) return 1;
        return (a.priority ?? 99) - (b.priority ?? 99);
      });

      if (opts.json) {
        renderJson(upcoming);
      } else if (upcoming.length === 0) {
        console.log(chalk.dim(`No tasks due in the next ${days} days.`));
      } else {
        // Group by dueISO date prefix
        const groups = new Map<string, typeof upcoming>();
        for (const t of upcoming) {
          const day = t.dueISO.slice(0, 10);
          if (!groups.has(day)) groups.set(day, []);
          groups.get(day)!.push(t);
        }
        for (const [day, tasks] of groups) {
          console.log(chalk.bold(`\n${day}`));
          renderTable(tasks, config.trustedNpubs);
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- show ----
program
  .command("show <taskId>")
  .description("Show full task details (accepts 8-char prefix or full UUID)")
  .option("--board <id|name>", "Board to search in (optional; scans all if omitted)")
  .option("--json", "Output raw task fields as JSON")
  .action(async (taskId: string, opts) => {
    warnShortTaskId(taskId);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const task = await runtime.getTask(taskId, opts.board);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else if (opts.json) {
        renderJson(task);
      } else {
        const localReminders = runtime.getLocalReminders(task.id);
        renderTaskCard(task, config.trustedNpubs, localReminders);
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- search ----
program
  .command("search <query>")
  .description("Full-text search tasks by title or note across all configured boards")
  .option("--board <id|name>", "Limit to a specific board")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const allTasks = await runtime.listTasks({
        boardId: opts.board,
        status: "any",
      });
      const q = query.toLowerCase();
      const matched = allTasks.filter((t) => {
        const inTitle = t.title.toLowerCase().includes(q);
        const inNote = t.note ? t.note.toLowerCase().includes(q) : false;
        return inTitle || inNote;
      });
      if (opts.json) {
        renderJson(matched);
      } else {
        if (matched.length === 0) {
          console.log(chalk.dim(`No tasks matching "${query}".`));
        } else {
          renderTable(matched, config.trustedNpubs);
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- remind ----
program
  .command("remind <taskId> <presets...>")
  .description("Set device-local reminders on a task. Presets: 0h, 5m, 15m, 30m, 1h, 1d, 1w")
  .option("--board <id|name>", "Board the task belongs to")
  .action(async (taskId: string, presets: string[], opts) => {
    warnShortTaskId(taskId);
    const invalid = presets.filter((p) => !VALID_REMINDER_PRESETS.has(p));
    if (invalid.length > 0) {
      console.error(
        chalk.red(
          `Invalid reminder preset(s): ${invalid.join(", ")}. Valid: ${[...VALID_REMINDER_PRESETS].join(", ")}`,
        ),
      );
      process.exit(1);
    }
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      // Try to fetch task title for a nicer success message
      let title = taskId.slice(0, 8);
      try {
        const hasSingleOrSpecifiedBoard = opts.board || config.boards.length === 1;
        if (hasSingleOrSpecifiedBoard) {
          const boardId = await resolveBoardId(opts.board, config);
          const task = await runtime.getTask(taskId, boardId);
          if (task?.title) title = task.title;
        }
      } catch { /* title lookup is best-effort */ }
      await runtime.remindTask(taskId, presets as Parameters<typeof runtime.remindTask>[1]);
      console.log(
        chalk.green(`✓ Reminders set for ${title}: ${presets.join(", ")} (device-local only, will not sync)`),
      );
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- add ----
program
  .command("add <title>")
  .description("Create a new task")
  .option("--board <id|name>", "Board to add to (required if multiple boards configured)")
  .option("--due <YYYY-MM-DD>", "Due date")
  .option("--priority <1|2|3>", "Priority (1=low, 3=high)")
  .option("--note <text>", "Note")
  .option(
    "--subtask <text>",
    "Add a subtask (repeatable)",
    (val: string, arr: string[]) => [...arr, val],
    [] as string[],
  )
  .option("--column <id|name>", "Column to place task in")
  .option("--recurrence-json <json>", "Recurrence object JSON (shared contract shape)")
  .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
  .option("--assignee <npubOrHex>", "Assign to pubkey/npub (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--documents-json <json>", "Documents/attachments array JSON")
  .option("--attach <path>", "Attach local file/image (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
  .option("--due-time <HH:MM>", "Due time (combine with --due to form ISO datetime, sets dueTimeEnabled)")
  .option("--timezone <iana>", "IANA timezone for due time (e.g. America/New_York)")
  .option("--hidden-until <ISO>", "Hide task until this ISO datetime")
  .option("--json", "Output created task as JSON")
  .action(async (title: string, opts) => {
    validateDue(opts.due);
    validatePriority(opts.priority);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const boardEntry = config.boards.find((b) => b.id === boardId)!;

    // Block add on compound boards
    if (boardEntry.kind === "compound") {
      const childNames = (boardEntry.children ?? []).map((cid) => {
        const ce = config.boards.find((b) => b.id === cid);
        return ce ? `  ${ce.name} (${cid})` : `  ${cid}`;
      }).join("\n");
      console.error(chalk.red("Cannot add tasks directly to a compound board. Use one of its child boards:"));
      if (childNames) console.error(childNames);
      process.exit(1);
    }

    if (boardEntry.kind === "lists" && (!boardEntry.columns || boardEntry.columns.length === 0)) {
      console.error(chalk.red(`Board "${boardEntry.name}" has no columns/lists yet.`));
      console.error(chalk.dim("Add a list first (PWA or `taskify board column-add`) then retry."));
      process.exit(1);
    }

    if (boardEntry.kind === "week" && !opts.due) {
      console.error(chalk.red(`Week board "${boardEntry.name}" requires --due <YYYY-MM-DD>.`));
      process.exit(1);
    }

    // Resolve --column
    let resolvedColumnId: string | undefined;
    let resolvedColumnName: string | undefined;
    if (opts.column) {
      const col = resolveColumnOrExit(boardEntry, opts.column);
      resolvedColumnId = col.id;
      resolvedColumnName = col.name;
    }

    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const subtasks = (opts.subtask as string[]).map((text) => ({
        id: crypto.randomUUID(),
        title: text,
        completed: false,
      }));
      const recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson));
      const reminders = normalizeTaskReminders(parseReminderOption(opts.reminders));
      const documents = await resolveAttachmentDocuments({ files: opts.attach as string[], boardId, config, fileServer: opts.fileServer, documentsJson: opts.documentsJson });
      const assignees = normalizeAssigneeArgs(opts.assignee as string[]);
      let dueISO = opts.due as string | undefined;
      let dueTimeEnabled: boolean | undefined;
      if (opts.dueTime) {
        if (dueISO) {
          dueISO = `${dueISO}T${opts.dueTime}:00`;
        }
        dueTimeEnabled = true;
      }
      const task = await runtime.createTaskFull({
        title,
        note: opts.note ?? "",
        boardId,
        dueISO,
        priority: opts.priority ? (parseInt(opts.priority, 10) as 1 | 2 | 3) : undefined,
        subtasks: subtasks.length > 0 ? subtasks : undefined,
        columnId: resolvedColumnId,
        recurrence,
        reminders: reminders as any,
        documents: documents as any,
        assignees,
        dueTimeEnabled,
        dueTimeZone: opts.timezone,
        hiddenUntilISO: opts.hiddenUntil,
      });
      if (opts.json) {
        renderJson(task);
      } else {
        const colStr = task.column
          ? chalk.dim(`  [col: ${task.column}${resolvedColumnName ? ` (${resolvedColumnName})` : ""}]`)
          : "";
        console.log(
          chalk.green(`✓ Created: ${task.title}`) + colStr,
        );
        if (subtasks.length > 0) {
          console.log(chalk.dim(`  Subtasks: ${subtasks.map((s) => s.title).join(", ")}`));
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- done ----
program
  .command("done [taskId]")
  .description("Mark a task as done (accepts 8-char prefix, full UUID, or full recurring instance ID)")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--title <title>", "Resolve task by title match (use with --due for recurring instances)")
  .option("--due <YYYY-MM-DD>", "Filter by due date when resolving by title")
  .option("--json", "Output updated task as JSON")
  .action(async (taskId: string | undefined, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      let resolvedId = taskId;
      if (!resolvedId) {
        if (!opts.title) {
          console.error(chalk.red("Provide a taskId or --title to identify the task."));
          process.exit(1);
        }
        resolvedId = await resolveTaskIdByTitle(runtime, opts.title, opts.due, boardId, config);
      } else {
        warnShortTaskId(resolvedId);
      }
      const task = await runtime.setTaskStatus(resolvedId, "done", boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${resolvedId}`));
        exitCode = 1;
      } else if (opts.json) {
        renderJson(task);
      } else {
        console.log(chalk.green(`✓ Marked done: ${task.title}`));
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- reopen ----
program
  .command("reopen [taskId]")
  .description("Reopen a completed task (accepts 8-char prefix, full UUID, or full recurring instance ID)")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--title <title>", "Resolve task by title match (use with --due for recurring instances)")
  .option("--due <YYYY-MM-DD>", "Filter by due date when resolving by title")
  .option("--json", "Output updated task as JSON")
  .action(async (taskId: string | undefined, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      let resolvedId = taskId;
      if (!resolvedId) {
        if (!opts.title) {
          console.error(chalk.red("Provide a taskId or --title to identify the task."));
          process.exit(1);
        }
        resolvedId = await resolveTaskIdByTitle(runtime, opts.title, opts.due, boardId, config);
      } else {
        warnShortTaskId(resolvedId);
      }
      const task = await runtime.setTaskStatus(resolvedId, "open", boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${resolvedId}`));
        exitCode = 1;
      } else if (opts.json) {
        renderJson(task);
      } else {
        console.log(chalk.green(`✓ Reopened: ${task.title}`));
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- delete ----
program
  .command("delete <taskId>")
  .description("Delete a task (publishes status=deleted to Nostr; accepts 8-char prefix or full UUID)")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--force", "Skip confirmation prompt")
  .option("--json", "Output deleted task as JSON")
  .action(async (taskId: string, opts) => {
    warnShortTaskId(taskId);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      // Fetch task first so we can show the title in the prompt
      const task = await runtime.getTask(taskId, boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else {
        if (!opts.force) {
          const { createInterface } = await import("readline");
          const confirmed = await new Promise<boolean>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(
              `Delete task: ${task.title} (${task.id.slice(0, 8)})? [y/N] `,
              (ans: string) => {
                rl.close();
                resolve(ans === "y" || ans === "Y");
              },
            );
          });
          if (!confirmed) {
            console.log("Aborted.");
            await runtime.disconnect();
            process.exit(0);
          }
        }
        const deleted = await runtime.deleteTask(taskId, boardId);
        if (!deleted) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          exitCode = 1;
        } else if (opts.json) {
          renderJson(deleted);
        } else {
          console.log(chalk.green(`✓ Deleted: ${deleted.title}`));
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- subtask ----
program
  .command("subtask <taskId> <subtaskRef>")
  .description(
    "Toggle a subtask done/incomplete. subtaskRef can be a 1-based index or partial title match.",
  )
  .option("--board <id|name>", "Board the task belongs to")
  .option("--done", "Mark subtask completed")
  .option("--reopen", "Mark subtask incomplete")
  .option("--json", "Output updated full task as JSON")
  .action(async (taskId: string, subtaskRef: string, opts) => {
    if (!opts.done && !opts.reopen) {
      console.error(chalk.red("Specify --done or --reopen."));
      process.exit(1);
    }
    if (opts.done && opts.reopen) {
      console.error(chalk.red("Specify only one of --done or --reopen."));
      process.exit(1);
    }
    warnShortTaskId(taskId);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const completed = !!opts.done;
      const task = await runtime.toggleSubtask(taskId, boardId, subtaskRef, completed);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else if (opts.json) {
        renderJson(task);
      } else {
        // Find the subtask that was toggled (by ref) to display its title
        const subtasks = task.subtasks ?? [];
        const indexNum = parseInt(subtaskRef, 10);
        let found: { title: string; completed?: boolean } | undefined;
        if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= subtasks.length) {
          found = subtasks[indexNum - 1];
        } else {
          const lower = subtaskRef.toLowerCase();
          found = subtasks.find((s) => s.title.toLowerCase().includes(lower));
        }
        const check = completed ? "x" : " ";
        const stitle = found?.title ?? subtaskRef;
        console.log(chalk.green(`✓ Subtask [${check}] ${stitle}  (task: ${task.title})`));
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- update ----
program
  .command("update <taskId>")
  .description("Update task fields (accepts 8-char prefix or full UUID)")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--title <t>", "New title")
  .option("--due <d>", "New due date")
  .option("--priority <p>", "New priority")
  .option("--note <n>", "New note")
  .option("--column <id|name>", "Move task to a different column")
  .option("--recurrence-json <json>", "Recurrence object JSON (shared contract shape)")
  .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
  .option("--assignee <npubOrHex>", "Replace assignees with pubkey/npub values (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--documents-json <json>", "Replace documents/attachments with array JSON")
  .option("--attach <path>", "Append local file/image attachment (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--remove-attachment <ref>", "Remove attachment by 1-based index or partial name (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option("--replace-attachments", "Replace all existing attachments with provided attachment inputs")
  .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
  .option("--due-time <HH:MM>", "Due time (combine with --due to form ISO datetime, sets dueTimeEnabled)")
  .option("--timezone <iana>", "IANA timezone for due time (e.g. America/New_York)")
  .option("--hidden-until <ISO>", "Hide task until this ISO datetime")
  .option("--json", "Output updated task as JSON")
  .action(async (taskId: string, opts) => {
    warnShortTaskId(taskId);
    validateDue(opts.due);
    validatePriority(opts.priority);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const patch: Record<string, unknown> = {};
      if (opts.title !== undefined) patch.title = opts.title;
      if (opts.priority !== undefined) patch.priority = parseInt(opts.priority, 10);
      if (opts.note !== undefined) patch.note = opts.note;
      if (opts.recurrenceJson !== undefined) patch.recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson)) ?? null;
      if (opts.reminders !== undefined) patch.reminders = normalizeTaskReminders(parseReminderOption(opts.reminders)) ?? null;
      if (opts.documentsJson !== undefined || ((opts.attach as string[]).length > 0) || ((opts.removeAttachment as string[]).length > 0) || opts.replaceAttachments) {
        const existingTask = await runtime.getTask(taskId, boardId);
        if (!existingTask) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }
        patch.documents = await mergeAttachmentDocuments({
          existing: existingTask.documents as Record<string, unknown>[] | undefined,
          files: opts.attach as string[],
          boardId,
          config,
          fileServer: opts.fileServer,
          documentsJson: opts.documentsJson,
          removeRefs: opts.removeAttachment as string[],
          replace: !!opts.replaceAttachments,
        }) ?? null;
      }
      if ((opts.assignee as string[]).length > 0) patch.assignees = normalizeAssigneeArgs(opts.assignee as string[]) ?? [];
      if (opts.column !== undefined) {
        const bEntry = config.boards.find((b) => b.id === boardId);
        if (bEntry) {
          const col = resolveColumnOrExit(bEntry, opts.column);
          patch.columnId = col.id;
        }
      }
      // due / due-time combination
      let dueISO = opts.due as string | undefined;
      if (opts.dueTime) {
        if (dueISO) {
          dueISO = `${dueISO}T${opts.dueTime}:00`;
        }
        patch.dueTimeEnabled = true;
      }
      if (dueISO !== undefined) patch.dueISO = dueISO;
      if (opts.timezone !== undefined) patch.dueTimeZone = opts.timezone;
      if (opts.hiddenUntil !== undefined) patch.hiddenUntilISO = opts.hiddenUntil;
      const task = await runtime.updateTask(taskId, boardId, patch);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else if (opts.json) {
        renderJson(task);
      } else {
        console.log(chalk.green(`✓ Updated: ${task.id.slice(0, 8)}  ${task.title}  ${task.boardId}`));
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });


const attachmentCmd = program.command("attachment").description("Inspect, decrypt, and download task/event attachments");

attachmentCmd
  .command("task-show <taskId> <attachmentRef>")
  .description("Alias for attachment show")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--json", "Output attachment as JSON")
  .action(async (taskId: string, attachmentRef: string, opts) => {
    await program.parseAsync(["node", "taskify", "attachment", "show", taskId, attachmentRef, ...(opts.board ? ["--board", opts.board] : []), ...(opts.json ? ["--json"] : [])], { from: "user" });
  });

attachmentCmd
  .command("task-download <taskId> <attachmentRef>")
  .description("Alias for attachment download")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--out <path>", "Output path")
  .action(async (taskId: string, attachmentRef: string, opts) => {
    await program.parseAsync(["node", "taskify", "attachment", "download", taskId, attachmentRef, ...(opts.board ? ["--board", opts.board] : []), ...(opts.out ? ["--out", opts.out] : [])], { from: "user" });
  });

attachmentCmd
  .command("show <taskId> <attachmentRef>")
  .description("Show a task attachment by 1-based index or partial name")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--json", "Output attachment as JSON")
  .action(async (taskId: string, attachmentRef: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    try {
      const task = await runtime.getTask(taskId, boardId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const hit = resolveDocumentByRef(task.documents as Record<string, unknown>[] | undefined, attachmentRef);
      if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
      if (opts.json) renderJson(hit.doc);
      else {
        const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
        const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
        const kind = typeof hit.doc.kind === "string" ? hit.doc.kind : "unknown";
        const remoteUrl = extractDocumentUrl(hit.doc);
        console.log(chalk.bold(name));
        console.log(`index: ${hit.index + 1}`);
        console.log(`kind: ${kind}`);
        console.log(`mime: ${mime}`);
        if (typeof hit.doc.encrypted === "boolean") console.log(`encrypted: ${hit.doc.encrypted}`);
        if (typeof hit.doc.encryptionBoardId === "string") console.log(`encryptionBoardId: ${hit.doc.encryptionBoardId}`);
        if (remoteUrl) console.log(`remoteUrl: ${remoteUrl}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

attachmentCmd
  .command("download <taskId> <attachmentRef>")
  .description("Download a task attachment, decrypting if needed")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--out <path>", "Output path")
  .action(async (taskId: string, attachmentRef: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    try {
      const task = await runtime.getTask(taskId, boardId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const hit = resolveDocumentByRef(task.documents as Record<string, unknown>[] | undefined, attachmentRef);
      if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
      const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
      const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
      const outPath = opts.out || name;
      let dataUrl = typeof hit.doc.dataUrl === "string" ? hit.doc.dataUrl : "";
      const remoteUrl = extractDocumentUrl(hit.doc);
      if ((!dataUrl || dataUrl.startsWith("data:application/octet-stream;base64,")) && remoteUrl) {
        if (hit.doc.encrypted === true) {
          dataUrl = await decryptAttachmentToDataUrl(typeof hit.doc.encryptionBoardId === "string" ? hit.doc.encryptionBoardId : boardId, remoteUrl, mime);
        } else {
          const res = await fetch(remoteUrl);
          if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
          const bytes = Buffer.from(await res.arrayBuffer());
          dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
        }
      }
      if (!dataUrl.startsWith("data:")) throw new Error("Attachment has no retrievable data.");
      const base64 = dataUrl.split(",", 2)[1] || "";
      await writeFile(outPath, Buffer.from(base64, "base64"));
      console.log(chalk.green(`✓ Saved attachment to ${outPath}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

attachmentCmd
  .command("event-show <eventId> <attachmentRef>")
  .description("Show an event attachment by 1-based index or partial name")
  .option("--board <id|name>", "Board the event belongs to")
  .option("--json", "Output attachment as JSON")
  .action(async (eventId: string, attachmentRef: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const event = await runtime.getEvent(eventId, boardId);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      const hit = resolveDocumentByRef(event.documents as Record<string, unknown>[] | undefined, attachmentRef);
      if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
      if (opts.json) renderJson(hit.doc);
      else {
        const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
        const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
        const remoteUrl = extractDocumentUrl(hit.doc);
        console.log(chalk.bold(name));
        console.log(`index: ${hit.index + 1}`);
        console.log(`event: ${event.title}`);
        console.log(`mime: ${mime}`);
        if (typeof hit.doc.encrypted === "boolean") console.log(`encrypted: ${hit.doc.encrypted}`);
        if (typeof hit.doc.encryptionBoardId === "string") console.log(`encryptionBoardId: ${hit.doc.encryptionBoardId}`);
        if (remoteUrl) console.log(`remoteUrl: ${remoteUrl}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

attachmentCmd
  .command("event-download <eventId> <attachmentRef>")
  .description("Download an event attachment, decrypting if needed")
  .option("--board <id|name>", "Board the event belongs to")
  .option("--out <path>", "Output path")
  .action(async (eventId: string, attachmentRef: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    try {
      const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
      const event = await runtime.getEvent(eventId, boardId);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      const hit = resolveDocumentByRef(event.documents as Record<string, unknown>[] | undefined, attachmentRef);
      if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
      const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
      const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
      const outPath = opts.out || name;
      let dataUrl = typeof hit.doc.dataUrl === "string" ? hit.doc.dataUrl : "";
      const remoteUrl = extractDocumentUrl(hit.doc);
      if ((!dataUrl || dataUrl.startsWith("data:application/octet-stream;base64,")) && remoteUrl) {
        if (hit.doc.encrypted === true) {
          dataUrl = await decryptAttachmentToDataUrl(typeof hit.doc.encryptionBoardId === "string" ? hit.doc.encryptionBoardId : event.boardId, remoteUrl, mime);
        } else {
          const res = await fetch(remoteUrl);
          if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
          const bytes = Buffer.from(await res.arrayBuffer());
          dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
        }
      }
      if (!dataUrl.startsWith("data:")) throw new Error("Attachment has no retrievable data.");
      const base64 = dataUrl.split(",", 2)[1] || "";
      await writeFile(outPath, Buffer.from(base64, "base64"));
      console.log(chalk.green(`✓ Saved attachment to ${outPath}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
  });

// ---- trust ----
const trust = program.command("trust").description("Manage trusted npubs");

trust
  .command("add <npub>")
  .description("Add a trusted npub")
  .action(async (npub: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.trustedNpubs.includes(npub)) {
      config.trustedNpubs.push(npub);
    }
    await saveConfig(config);
    console.log(chalk.green("✓ Added"));
    process.exit(0);
  });

trust
  .command("remove <npub>")
  .description("Remove a trusted npub")
  .action(async (npub: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    config.trustedNpubs = config.trustedNpubs.filter((n) => n !== npub);
    await saveConfig(config);
    console.log(chalk.green("✓ Removed"));
    process.exit(0);
  });

trust
  .command("list")
  .description("List trusted npubs")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.trustedNpubs.length === 0) {
      console.log(chalk.dim("No trusted npubs."));
    } else {
      for (const npub of config.trustedNpubs) {
        console.log(npub);
      }
    }
    process.exit(0);
  });

// ---- relay command group ----
const relayCmd = program.command("relay").description("Manage relay connections");

relayCmd
  .command("status")
  .description("Show connection status of relays in the NDK pool")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const statuses = await runtime.getRelayStatus();
      if (statuses.length === 0) {
        console.log(chalk.dim("No relays configured."));
      } else {
        for (const { url, connected } of statuses) {
          if (connected) {
            console.log(chalk.green(`✓ ${url}`) + chalk.dim("  connected"));
          } else {
            console.log(chalk.red(`✗ ${url}`) + chalk.dim("  disconnected"));
          }
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

relayCmd
  .command("list")
  .description("Show configured relays with live connection check")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.relays.length === 0) {
      console.log(chalk.dim("No relays configured."));
      process.exit(0);
    }
    console.log(chalk.dim(`Checking ${config.relays.length} relay(s)...`));
    for (const relay of config.relays) {
      const ok = await checkRelay(relay);
      if (ok) {
        console.log(chalk.green(`✓ ${relay}`) + chalk.dim("  connected"));
      } else {
        console.log(chalk.red(`✗ ${relay}`) + chalk.dim("  disconnected"));
      }
    }
    process.exit(0);
  });

relayCmd
  .command("add <url>")
  .description("Add a relay URL to config")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.relays.includes(url)) {
      config.relays.push(url);
      await saveConfig(config);
      console.log(chalk.green(`✓ Relay added: ${url}`));
    } else {
      console.log(chalk.dim(`Relay already configured: ${url}`));
    }
    process.exit(0);
  });

relayCmd
  .command("remove <url>")
  .description("Remove a relay URL from config")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const before = config.relays.length;
    config.relays = config.relays.filter((r) => r !== url);
    if (config.relays.length === before) {
      console.error(chalk.red(`Relay not found in config: ${url}`));
      process.exit(1);
    }
    await saveConfig(config);
    console.log(chalk.green(`✓ Relay removed: ${url}`));
    process.exit(0);
  });

// ---- cache command group ----
const cacheCmd = program.command("cache").description("Manage task cache");

cacheCmd
  .command("clear")
  .description("Delete the task cache file")
  .action(() => {
    clearCache();
    console.log(chalk.green("✓ Cache cleared"));
    process.exit(0);
  });

cacheCmd
  .command("status")
  .description("Show per-board cache age and task count")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const cache = readCache();
    const now = Date.now();
    if (Object.keys(cache.boards).length === 0) {
      console.log(chalk.dim("No cache."));
      process.exit(0);
    }
    for (const board of config.boards) {
      const bc = cache.boards[board.id];
      if (!bc) {
        console.log(`${board.name}: ${chalk.dim("No cache")}`);
        continue;
      }
      const ageMs = now - bc.fetchedAt;
      const ageSec = Math.floor(ageMs / 1000);
      let ageStr: string;
      if (ageSec < 60) {
        ageStr = `${ageSec}s ago`;
      } else if (ageSec < 3600) {
        ageStr = `${Math.floor(ageSec / 60)}m ago`;
      } else {
        ageStr = `${Math.floor(ageSec / 3600)}h ago`;
      }
      const stale = ageMs > CACHE_TTL_MS ? chalk.yellow(" (stale)") : "";
      const openCount = bc.tasks.filter((t) => t.status === "open").length;
      console.log(`${chalk.bold(board.name)}: ${bc.tasks.length} tasks (${openCount} open), cached ${ageStr}${stale}`);
    }
    // Show boards in cache that aren't in config
    for (const [boardId, bc] of Object.entries(cache.boards)) {
      if (!config.boards.find((b) => b.id === boardId)) {
        console.log(chalk.dim(`  [orphan ${boardId.slice(0, 8)}]: ${bc.tasks.length} tasks`));
      }
    }
    process.exit(0);
  });

// ---- config ----
const configCmd = program.command("config").description("Manage CLI config");

const configSet = configCmd.command("set").description("Set config values");

configSet
  .command("nsec <nsec>")
  .description("Set your nsec private key")
  .action(async (nsec: string) => {
    if (!nsec.startsWith("nsec1")) {
      console.error(chalk.red(`Invalid nsec: must start with "nsec1".`));
      process.exit(1);
    }
    const config = await loadConfig(program.opts().profile as string | undefined);
    config.nsec = nsec;
    await saveConfig(config);
    console.log(chalk.green("✓ nsec saved"));
    process.exit(0);
  });

configSet
  .command("relay <url>")
  .description("Add a relay URL")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.relays.includes(url)) {
      config.relays.push(url);
    }
    await saveConfig(config);
    console.log(chalk.green("✓ Relay added"));
    process.exit(0);
  });

configSet
  .command("file-server <url>")
  .description("Set default public file server URL")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    config.fileStorageServer = url.trim();
    await saveConfig(config);
    console.log(chalk.green(`✓ Public file server set to ${config.fileStorageServer}`));
    process.exit(0);
  });

configSet
  .command("encrypted-file-server <url>")
  .description("Set default encrypted file server URL")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    config.encryptedFileStorageServer = url.trim();
    await saveConfig(config);
    console.log(chalk.green(`✓ Encrypted file server set to ${config.encryptedFileStorageServer}`));
    process.exit(0);
  });


async function checkRelay(url: string, timeoutMs: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const timer = setTimeout(() => {
      ws.close();
      done(false);
    }, timeoutMs);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        done(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        done(false);
      };
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

configCmd
  .command("show")
  .description("Show current config")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const display = {
      ...config,
      nsec: config.nsec ? "nsec1****" : undefined,
    };
    console.log(JSON.stringify(display, null, 2));

    console.log("\nChecking relays...");
    for (const relay of config.relays) {
      const ok = await checkRelay(relay);
      if (ok) {
        console.log(chalk.green(`✓ ${relay}`) + chalk.dim("  (connected)"));
      } else {
        console.log(chalk.red(`✗ ${relay}`) + chalk.dim("  (timeout)"));
      }
    }
    process.exit(0);
  });

// ---- completions ----
program
  .command("completions")
  .description("Generate shell completion scripts")
  .option("--shell <zsh|bash|fish>", "Shell type (defaults to current shell)")
  .action((opts) => {
    let shell = opts.shell as string | undefined;
    if (!shell) {
      const envShell = process.env.SHELL ?? "";
      if (envShell.includes("zsh")) shell = "zsh";
      else if (envShell.includes("bash")) shell = "bash";
      else {
        // Print all three if shell cannot be determined
        process.stdout.write(zshCompletion());
        process.stdout.write("\n");
        process.stdout.write(bashCompletion());
        process.stdout.write("\n");
        process.stdout.write(fishCompletion());
        process.exit(0);
      }
    }
    switch (shell) {
      case "zsh":
        process.stdout.write(zshCompletion());
        break;
      case "bash":
        process.stdout.write(bashCompletion());
        break;
      case "fish":
        process.stdout.write(fishCompletion());
        break;
      default:
        console.error(chalk.red(`Unknown shell: "${shell}". Use: zsh, bash, or fish`));
        process.exit(1);
    }
    process.exit(0);
  });

// ---- agent command group ----
const agentCmd = program
  .command("agent")
  .description("AI-powered task commands");

const agentConfigCmd = agentCmd
  .command("config")
  .description("Manage agent AI configuration");

agentConfigCmd
  .command("set-key <key>")
  .description("Set the AI API key")
  .action(async (key: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.agent) config.agent = {};
    config.agent.apiKey = key;
    await saveConfig(config);
    console.log(chalk.green("✓ Agent API key saved"));
    process.exit(0);
  });

agentConfigCmd
  .command("set-model <model>")
  .description("Set the AI model")
  .action(async (model: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.agent) config.agent = {};
    config.agent.model = model;
    await saveConfig(config);
    console.log(chalk.green(`✓ Agent model set to: ${model}`));
    process.exit(0);
  });

agentConfigCmd
  .command("set-url <url>")
  .description("Set the AI base URL (OpenAI-compatible)")
  .action(async (url: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.agent) config.agent = {};
    config.agent.baseUrl = url;
    await saveConfig(config);
    console.log(chalk.green(`✓ Agent base URL set to: ${url}`));
    process.exit(0);
  });

agentConfigCmd
  .command("show")
  .description("Show current agent config (masks API key)")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const ag = config.agent ?? {};
    const rawKey = ag.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
    let maskedKey = "(not set)";
    if (rawKey.length > 7) {
      maskedKey = rawKey.slice(0, 3) + "..." + rawKey.slice(-3);
    } else if (rawKey.length > 0) {
      maskedKey = "***";
    }
    console.log(`  apiKey:         ${maskedKey}`);
    console.log(`  baseUrl:        ${ag.baseUrl ?? "https://api.openai.com/v1"}`);
    console.log(`  model:          ${ag.model ?? "gpt-4o-mini"}`);
    console.log(`  defaultBoardId: ${ag.defaultBoardId ?? "(not set)"}`);
    process.exit(0);
  });

agentCmd
  .command("add <description>")
  .description("AI-powered task creation from natural language")
  .option("--board <id|name>", "Target board")
  .option("--yes", "Skip confirmation prompt")
  .option("--dry-run", "Show extracted fields without creating")
  .option("--json", "Output created task as JSON")
  .action(async (description: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const apiKey = config.agent?.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
    if (!apiKey) {
      console.error(chalk.red("No AI API key configured. Run: taskify agent config set-key <key>"));
      console.error(chalk.dim("  or set TASKIFY_AGENT_API_KEY environment variable"));
      process.exit(1);
    }
    const baseUrl = config.agent?.baseUrl ?? "https://api.openai.com/v1";
    const model = config.agent?.model ?? "gpt-4o-mini";
    const boardId = await resolveBoardId(opts.board ?? config.agent?.defaultBoardId, config);
    const boardEntry = config.boards.find((b) => b.id === boardId)!;

    if (boardEntry.kind === "compound") {
      const childNames = (boardEntry.children ?? []).map((cid) => {
        const ce = config.boards.find((b) => b.id === cid);
        return ce ? `  ${ce.name} (${cid})` : `  ${cid}`;
      }).join("\n");
      console.error(chalk.red("Cannot add tasks directly to a compound board. Use one of its child boards:"));
      if (childNames) console.error(childNames);
      process.exit(1);
    }

    const today = new Date().toISOString().slice(0, 10);
    const { callAI } = await import("./aiClient.js");

    const SYSTEM_PROMPT = `You are a task extraction assistant. Extract fields from the description.
Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "concise task title (max 80 chars)",
  "note": "additional detail or empty string",
  "priority": 1|2|3|null,
  "dueISO": "YYYY-MM-DD"|null,
  "column": "column name/id hint or null",
  "subtasks": ["subtask 1", "subtask 2"] or []
}
Today is ${today}.`;

    let extracted: {
      title: string;
      note: string;
      priority: 1 | 2 | 3 | null;
      dueISO: string | null;
      column: string | null;
      subtasks: string[];
    };

    console.log(chalk.dim("Calling AI..."));
    try {
      const raw = await callAI({ apiKey, baseUrl, model, systemPrompt: SYSTEM_PROMPT, userMessage: description });
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      extracted = JSON.parse(cleaned);
    } catch (err) {
      console.error(chalk.red(`AI extraction failed: ${String(err)}`));
      process.exit(1);
    }

    // Resolve column hint
    let resolvedColumnId: string | undefined;
    let resolvedColumnName: string | undefined;
    if (extracted.column) {
      const col = resolveColumnOrExit(boardEntry, extracted.column);
      if (col) {
        resolvedColumnId = col.id;
        resolvedColumnName = col.name;
      }
    }

    // Print extracted fields
    console.log(chalk.bold("\nExtracted task:"));
    console.log(`  title:    ${extracted.title}`);
    if (extracted.note) console.log(`  note:     ${extracted.note}`);
    if (extracted.priority) console.log(`  priority: ${extracted.priority}`);
    if (extracted.dueISO) console.log(`  due:      ${extracted.dueISO}`);
    if (resolvedColumnName) console.log(`  column:   ${resolvedColumnName}`);
    if (extracted.subtasks?.length > 0) {
      console.log(`  subtasks: ${extracted.subtasks.join(", ")}`);
    }

    if (opts.dryRun) {
      console.log(chalk.dim("\n[dry-run] No task created."));
      process.exit(0);
    }

    if (!opts.yes) {
      const { createInterface } = await import("readline");
      const confirmed = await new Promise<boolean>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("\nCreate this task? [Y/n] ", (ans: string) => {
          rl.close();
          resolve(ans === "" || ans.toLowerCase() === "y");
        });
      });
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    const runtime = initRuntime(config);
    try {
      const subtasks = (extracted.subtasks ?? []).map((text) => ({
        id: crypto.randomUUID(),
        title: text,
        completed: false,
      }));
      const task = await runtime.createTaskFull({
        title: extracted.title,
        note: extracted.note ?? "",
        boardId,
        dueISO: extracted.dueISO ?? undefined,
        priority: extracted.priority ?? undefined,
        columnId: resolvedColumnId,
        subtasks: subtasks.length > 0 ? subtasks : undefined,
      });
      if (opts.json) {
        renderJson(task);
      } else {
        const colStr = task.column ? chalk.dim(`  [col: ${resolvedColumnName ?? task.column}]`) : "";
        console.log(chalk.green(`✓ Created: ${task.title}`) + colStr);
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
    process.exit(0);
  });

agentCmd
  .command("triage")
  .description("AI-powered task prioritization suggestions")
  .option("--board <id|name>", "Target board")
  .option("--yes", "Apply changes without confirmation")
  .option("--dry-run", "Show suggestions without applying")
  .option("--json", "Output suggestions as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const apiKey = config.agent?.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
    if (!apiKey) {
      console.error(chalk.red("No AI API key configured. Run: taskify agent config set-key <key>"));
      process.exit(1);
    }
    const baseUrl = config.agent?.baseUrl ?? "https://api.openai.com/v1";
    const model = config.agent?.model ?? "gpt-4o-mini";
    const boardId = await resolveBoardId(opts.board ?? config.agent?.defaultBoardId, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const tasks = await runtime.listTasks({ boardId, status: "open" });
      if (tasks.length === 0) {
        console.log(chalk.dim("No open tasks to triage."));
        process.exit(0);
      }

      const { callAI } = await import("./aiClient.js");

      const SYSTEM_PROMPT = `You are a task prioritization assistant. Given open tasks, suggest priority (1=low, 2=medium, 3=high) for each.
Return ONLY a valid JSON array (no markdown):
[{"id":"<taskId>","priority":1|2|3,"reason":"one sentence"}]`;

      const taskList = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        note: t.note || undefined,
        dueISO: t.dueISO || undefined,
        currentPriority: t.priority,
      }));

      console.log(chalk.dim(`Analyzing ${tasks.length} tasks...`));
      let suggestions: Array<{ id: string; priority: 1 | 2 | 3; reason: string }>;
      try {
        const raw = await callAI({
          apiKey, baseUrl, model,
          systemPrompt: SYSTEM_PROMPT,
          userMessage: `Tasks: ${JSON.stringify(taskList)}`,
        });
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        suggestions = JSON.parse(cleaned);
      } catch (err) {
        console.error(chalk.red(`AI triage failed: ${String(err)}`));
        process.exit(1);
      }

      // Filter to only changes
      const changes = suggestions.filter((s) => {
        const task = tasks.find((t) => t.id === s.id);
        return task && task.priority !== s.priority;
      });

      if (opts.json) {
        renderJson(suggestions);
        process.exit(0);
      }

      if (changes.length === 0) {
        console.log(chalk.dim("No priority changes suggested."));
        process.exit(0);
      }

      console.log(chalk.bold("\nSuggested priority changes:"));
      const PRIO_LABELS: Record<number, string> = { 1: "low", 2: "medium", 3: "high" };
      for (const s of changes) {
        const task = tasks.find((t) => t.id === s.id);
        const oldPrio = task?.priority ? PRIO_LABELS[task.priority] : "none";
        const newPrio = PRIO_LABELS[s.priority] ?? String(s.priority);
        console.log(`  ${s.id.slice(0, 8)}  ${(task?.title ?? "").slice(0, 40).padEnd(40)}  ${oldPrio} → ${newPrio}`);
        console.log(chalk.dim(`           ${s.reason}`));
      }

      if (opts.dryRun) {
        console.log(chalk.dim("\n[dry-run] No changes applied."));
        process.exit(0);
      }

      if (!opts.yes) {
        const { createInterface } = await import("readline");
        const confirmed = await new Promise<boolean>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("\nApply these priority changes? [Y/n] ", (ans: string) => {
            rl.close();
            resolve(ans === "" || ans.toLowerCase() === "y");
          });
        });
        if (!confirmed) {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      for (const s of changes) {
        await runtime.updateTask(s.id, boardId, { priority: s.priority });
      }
      console.log(chalk.green(`✓ Applied ${changes.length} priority update(s)`));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- CSV helpers ----

function csvEscape(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(""); break; }
    if (line[i] === '"') {
      let field = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      else { fields.push(line.slice(i, end)); i = end + 1; }
    }
  }
  return fields;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] ?? "").trim(); });
    return row;
  });
}

function npubOrHexToHex(val: string): string {
  if (val.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(val);
      if (decoded.type === "npub") return decoded.data as string;
    } catch { /* fall through */ }
  }
  return val;
}

function nsecToHexOrThrow(nsec: string | undefined): string {
  if (!nsec) throw new Error("No nsec configured for active profile.");
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec for active profile.");
  return bytesToHex(decoded.data as Uint8Array);
}

// ---- export ----
program
  .command("export")
  .description("Export tasks to JSON, CSV, or Markdown")
  .option("--board <id|name>", "Board to export from")
  .option("--format <json|csv|md>", "Output format (default: json)", "json")
  .option("--status <open|done|any>", "Status filter (default: open)", "open")
  .option("--output <file>", "Write to file instead of stdout")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const tasks = await runtime.listTasks({
        boardId,
        status: opts.status as "open" | "done" | "any",
        refresh: false,
      });
      const boardEntry = config.boards.find((b) => b.id === boardId);

      let output = "";

      if (opts.format === "json") {
        output = JSON.stringify(tasks, null, 2);
      } else if (opts.format === "csv") {
        const CSV_HEADER = "id,title,status,priority,dueISO,column,boardName,note,subtasks,createdAt";
        const rows = tasks.map((t) => {
          const subtaskStr = (t.subtasks ?? []).map((s) => s.title).join("|");
          return [
            csvEscape(t.id),
            csvEscape(t.title),
            csvEscape(t.completed ? "done" : "open"),
            csvEscape(t.priority ? String(t.priority) : ""),
            csvEscape(t.dueISO ? t.dueISO.slice(0, 10) : ""),
            csvEscape(t.column ?? ""),
            csvEscape(t.boardName ?? ""),
            csvEscape(t.note ?? ""),
            csvEscape(subtaskStr),
            csvEscape(t.createdAt ? String(t.createdAt) : ""),
          ].join(",");
        });
        output = [CSV_HEADER, ...rows].join("\n") + "\n";
      } else if (opts.format === "md") {
        const boardName = boardEntry?.name ?? boardId.slice(0, 8);
        const statusLabel = opts.status === "done" ? "Done Tasks" : opts.status === "any" ? "All Tasks" : "Open Tasks";
        const lines: string[] = [`## ${statusLabel} — ${boardName}`, ""];
        // Group by column
        const byColumn = new Map<string, typeof tasks>();
        for (const t of tasks) {
          const colId = t.column ?? "";
          const group = byColumn.get(colId) ?? [];
          group.push(t);
          byColumn.set(colId, group);
        }
        for (const [colId, colTasks] of byColumn) {
          let colName = colId;
          if (boardEntry?.columns) {
            const col = boardEntry.columns.find((c) => c.id === colId);
            if (col) colName = col.name;
          }
          if (!colId) colName = "No Column";
          lines.push(`### ${colName}`, "");
          for (const t of colTasks) {
            const check = t.completed ? "x" : " ";
            const meta: string[] = [];
            if (t.priority) meta.push(`priority: ${t.priority === 3 ? "high" : t.priority === 2 ? "medium" : "low"}`);
            if (t.dueISO) meta.push(`due: ${t.dueISO.slice(0, 10)}`);
            const metaStr = meta.length > 0 ? ` *(${meta.join(", ")})*` : "";
            lines.push(`- [${check}] ${t.title}${metaStr}`);
            for (const s of t.subtasks ?? []) {
              const sc = s.completed ? "x" : " ";
              lines.push(`    - [${sc}] ${s.title}`);
            }
          }
          lines.push("");
        }
        output = lines.join("\n");
      } else {
        console.error(chalk.red(`Unknown format: "${opts.format}". Use: json, csv, md`));
        exitCode = 1;
      }

      if (exitCode === 0) {
        if (opts.output) {
          await writeFile(opts.output, output, "utf-8");
          process.stderr.write(`✓ Exported ${tasks.length} tasks → ${opts.output}\n`);
        } else {
          process.stdout.write(output);
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- import ----
program
  .command("import <file>")
  .description("Import tasks from a JSON or CSV file")
  .option("--board <id|name>", "Board to import into")
  .option("--dry-run", "Print preview but do not create tasks")
  .option("--yes", "Skip confirmation prompt")
  .action(async (file: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);

    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      console.error(chalk.red(`Cannot read file: ${file}`));
      process.exit(1);
    }

    type ImportRow = {
      title: string;
      note?: string;
      priority?: 1 | 2 | 3;
      dueISO?: string;
      column?: string;
      subtasks?: string[];
    };

    let rows: ImportRow[] = [];
    const ext = file.split(".").pop()?.toLowerCase();

    if (ext === "json") {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        console.error(chalk.red("Invalid JSON file")); process.exit(1);
      }
      if (!Array.isArray(parsed)) {
        console.error(chalk.red("JSON file must be an array of objects")); process.exit(1);
      }
      rows = (parsed as Record<string, unknown>[]).map((obj) => ({
        title: String(obj.title ?? ""),
        note: obj.note ? String(obj.note) : undefined,
        priority: [1, 2, 3].includes(Number(obj.priority)) ? Number(obj.priority) as 1 | 2 | 3 : undefined,
        dueISO: obj.dueISO ? String(obj.dueISO) : undefined,
        column: obj.column ? String(obj.column) : undefined,
        subtasks: Array.isArray(obj.subtasks)
          ? (obj.subtasks as unknown[]).map((s) => typeof s === "string" ? s : (s as Record<string, unknown>).title ? String((s as Record<string, unknown>).title) : "").filter(Boolean)
          : undefined,
      }));
    } else if (ext === "csv") {
      const csvRows = parseCSV(raw);
      rows = csvRows.map((r) => ({
        title: r.title ?? "",
        note: r.note || undefined,
        priority: [1, 2, 3].includes(Number(r.priority)) ? Number(r.priority) as 1 | 2 | 3 : undefined,
        dueISO: r.dueISO || undefined,
        column: r.column || undefined,
        subtasks: r.subtasks ? r.subtasks.split("|").map((s) => s.trim()).filter(Boolean) : undefined,
      }));
    } else {
      console.error(chalk.red(`Unsupported file extension: .${ext}. Use .json or .csv`));
      process.exit(1);
    }

    // Validate: check for missing titles
    const invalid = rows.map((r, i) => ({ i, r })).filter(({ r }) => !r.title.trim());
    if (invalid.length > 0) {
      console.error(chalk.red(`Invalid rows (missing title): ${invalid.map(({ i }) => i + 1).join(", ")}`));
      process.exit(1);
    }

    if (rows.length === 0) {
      console.log(chalk.dim("No rows to import."));
      process.exit(0);
    }

    // Print preview table
    console.log(chalk.bold(`\nImport preview (${rows.length} tasks):`));
    console.log(chalk.dim(`  ${"TITLE".padEnd(36)}  ${"PRI".padEnd(4)}  ${"DUE".padEnd(12)}  COLUMN`));
    for (const r of rows) {
      const t = (r.title.length > 36 ? r.title.slice(0, 35) + "…" : r.title).padEnd(36);
      const p = (r.priority ? String(r.priority) : "-").padEnd(4);
      const d = (r.dueISO ? r.dueISO.slice(0, 10) : "").padEnd(12);
      const c = r.column ?? "";
      console.log(`  ${t}  ${p}  ${d}  ${c}`);
    }

    if (opts.dryRun) {
      console.log(chalk.dim("\n[dry-run] No tasks created."));
      process.exit(0);
    }

    if (!opts.yes) {
      const { createInterface } = await import("readline");
      const confirmed = await new Promise<boolean>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("\nProceed? [Y/n] ", (ans: string) => {
          rl.close();
          resolve(ans === "" || ans.toLowerCase() === "y");
        });
      });
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    const runtime = initRuntime(config);
    const boardEntry = config.boards.find((b) => b.id === boardId)!;
    let exitCode = 0;
    try {
      // Check existing tasks to detect duplicates
      const existing = await runtime.listTasks({ boardId, status: "any" });
      const existingTitles = new Set(existing.map((t) => t.title.toLowerCase()));

      let created = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (existingTitles.has(r.title.toLowerCase())) {
          console.log(chalk.yellow(`⚠ Skipping duplicate: ${r.title}`));
          continue;
        }
        // Resolve column
        let colId: string | undefined;
        if (r.column) {
          const col = resolveColumnOrExit(boardEntry, r.column);
          if (col) colId = col.id;
        }
        const subtasks = (r.subtasks ?? []).map((text) => ({
          id: crypto.randomUUID(),
          title: text,
          completed: false,
        }));
        await runtime.createTaskFull({
          title: r.title,
          note: r.note ?? "",
          boardId,
          dueISO: r.dueISO,
          priority: r.priority,
          columnId: colId,
          subtasks: subtasks.length > 0 ? subtasks : undefined,
        });
        created++;
        console.log(chalk.green(`  [${created}/${rows.length}] ✓ ${r.title}`));
      }
      console.log(chalk.green(`✓ Imported ${created}/${rows.length} tasks`));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- backup snapshot ----
const backupCmd = program
  .command("backup")
  .description("Inspect and apply Taskify backup snapshot metadata");

backupCmd
  .command("inspect <file>")
  .description("Inspect snapshot metadata (boards/default relays/settings keys)")
  .action(async (file: string) => {
    let raw = "";
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      console.error(chalk.red(`Cannot read file: ${file}`));
      process.exit(1);
    }

    try {
      const snapshot = parseBackupSnapshot(raw);
      console.log(chalk.bold("Backup snapshot summary"));
      console.log(`  boards:         ${snapshot.boards.length}`);
      console.log(`  default relays: ${snapshot.defaultRelays.length}`);
      console.log(`  settings keys:  ${Object.keys(snapshot.settings).length}`);
      console.log(`  wallet seed:    ${Object.keys(snapshot.walletSeed).length > 0 ? "present" : "empty"}`);
      if (snapshot.defaultRelays.length > 0) {
        console.log(chalk.dim(`  relays: ${snapshot.defaultRelays.join(", ")}`));
      }
      if (snapshot.boards.length > 0) {
        console.log(chalk.bold("\nBoards:"));
        for (const board of snapshot.boards) {
          const boardKind = board.kind ?? "lists";
          const relayCount = Array.isArray(board.relays) ? board.relays.length : 0;
          console.log(`  - ${board.name ?? board.id} (${boardKind}) [nostrId: ${board.nostrId}] relays=${relayCount}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

backupCmd
  .command("merge-boards <file>")
  .description("Merge backup board metadata into local CLI board config")
  .option("--dry-run", "Preview merge without saving")
  .action(async (file: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);

    let raw = "";
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      console.error(chalk.red(`Cannot read file: ${file}`));
      process.exit(1);
    }

    try {
      const snapshot = parseBackupSnapshot(raw);
      const merged = mergeBoardsFromBackup(config.boards, snapshot.boards, snapshot.defaultRelays);
      const changedCount = merged.filter((board, idx) => JSON.stringify(board) !== JSON.stringify(config.boards[idx])).length;
      if (changedCount === 0 && merged.length === config.boards.length) {
        console.log(chalk.dim("No board changes to apply."));
        process.exit(0);
      }

      console.log(chalk.bold(`Board merge preview: ${config.boards.length} → ${merged.length}`));
      console.log(`  changed/new boards: ${changedCount}`);

      if (opts.dryRun) {
        console.log(chalk.dim("[dry-run] No config written."));
        process.exit(0);
      }

      config.boards = merged;
      await saveConfig(config);
      console.log(chalk.green(`✓ Applied board merge (${changedCount} changed/new)`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

backupCmd
  .command("merge-relays <file>")
  .description("Apply backup default relays to local CLI relay config")
  .option("--dry-run", "Preview relay changes without saving")
  .action(async (file: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);

    let raw = "";
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      console.error(chalk.red(`Cannot read file: ${file}`));
      process.exit(1);
    }

    try {
      const snapshot = parseBackupSnapshot(raw);
      const mergedRelays = mergeRelaysFromBackup(config.relays, snapshot.defaultRelays);
      const changed = JSON.stringify(mergedRelays) !== JSON.stringify(config.relays);
      if (!changed) {
        console.log(chalk.dim("No relay changes to apply."));
        process.exit(0);
      }

      console.log(chalk.bold("Relay merge preview"));
      console.log(`  current relays: ${config.relays.length}`);
      console.log(`  backup relays:  ${snapshot.defaultRelays.length}`);
      console.log(`  merged relays:  ${mergedRelays.length}`);

      if (opts.dryRun) {
        console.log(chalk.dim("[dry-run] No config written."));
        process.exit(0);
      }

      config.relays = mergeRelaysFromBackup(config.relays, snapshot.defaultRelays);
      await saveConfig(config);
      console.log(chalk.green(`✓ Applied relay merge (${config.relays.length} relay${config.relays.length === 1 ? "" : "s"})`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

// ---- inbox ----
const inboxCmd = program
  .command("inbox")
  .description("Manage inbox tasks (quick capture and triage)");

inboxCmd
  .command("list")
  .description("List inbox tasks (inboxItem: true)")
  .option("--board <id|name>", "Board to list from")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const tasks = await runtime.listTasks({ boardId, status: "open" });
      const inboxTasks = tasks.filter((t) => t.inboxItem === true);
      if (inboxTasks.length === 0) {
        console.log(chalk.dim("No inbox tasks."));
      } else {
        renderTable(inboxTasks, config.trustedNpubs);
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

inboxCmd
  .command("add <title>")
  .description("Capture a task to inbox (inboxItem: true)")
  .option("--board <id|name>", "Board to add to")
  .action(async (title: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const boardEntry = config.boards.find((b) => b.id === boardId)!;
    if (boardEntry.kind === "compound") {
      console.error(chalk.red("Cannot add tasks to a compound board."));
      process.exit(1);
    }
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      await runtime.createTaskFull({
        title,
        note: "",
        boardId,
        inboxItem: true,
      });
      console.log(chalk.green(`✓ Inbox: ${title}`));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

inboxCmd
  .command("triage <taskId>")
  .description("Triage an inbox task: assign column, priority, due date")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--column <id|name>", "Column to assign")
  .option("--priority <1|2|3>", "Priority")
  .option("--due <YYYY-MM-DD>", "Due date")
  .option("--yes", "Apply flags directly without prompting")
  .action(async (taskId: string, opts) => {
    validateDue(opts.due);
    validatePriority(opts.priority);
    warnShortTaskId(taskId);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const boardEntry = config.boards.find((b) => b.id === boardId)!;
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const task = await runtime.getTask(taskId, boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else {
        // Show task details
        console.log(chalk.bold(`\nTask: ${task.title}`));
        if (task.note) console.log(`  Note:     ${task.note}`);
        if (task.priority) console.log(`  Priority: ${task.priority}`);
        if (task.dueISO) console.log(`  Due:      ${task.dueISO.slice(0, 10)}`);
        console.log();

        let colId: string | null = null;
        let colName: string | null = null;
        let priority: 1 | 2 | 3 | null = null;
        let dueISO: string | null = null;

        if (opts.yes) {
          // Apply flags directly
          if (opts.column) {
            const col = resolveColumnOrExit(boardEntry, opts.column);
            if (col) { colId = col.id; colName = col.name; }
          }
          if (opts.priority) priority = parseInt(opts.priority, 10) as 1 | 2 | 3;
          if (opts.due) dueISO = opts.due;
        } else {
          const { createInterface } = await import("readline");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q: string): Promise<string> =>
            new Promise((resolve) => rl.question(q, (ans: string) => resolve(ans.trim())));

          const currentCol = task.column
            ? (boardEntry.columns?.find((c) => c.id === task.column)?.name ?? task.column)
            : "none";
          const colAns = await ask(`Column [${currentCol}]: `);
          if (colAns) {
            const col = resolveColumnOrExit(boardEntry, colAns);
            if (col) { colId = col.id; colName = col.name; }
            else process.stderr.write(`⚠ Column not found — skipping column change\n`);
          }

          const priAns = await ask(`Priority [${task.priority ?? "none"}]: `);
          if (priAns && ["1", "2", "3"].includes(priAns)) {
            priority = parseInt(priAns, 10) as 1 | 2 | 3;
          }

          const dueAns = await ask(`Due date [${task.dueISO ? task.dueISO.slice(0, 10) : "none"}]: `);
          if (dueAns && /^\d{4}-\d{2}-\d{2}$/.test(dueAns)) {
            dueISO = dueAns;
          } else if (dueAns) {
            process.stderr.write(`⚠ Invalid due date format — skipping\n`);
          }

          rl.close();
        }

        const patch: Record<string, unknown> = { inboxItem: false };
        if (colId !== null) patch.columnId = colId;
        if (priority !== null) patch.priority = priority;
        if (dueISO !== null) patch.dueISO = dueISO;

        const updated = await runtime.updateTask(taskId, boardId, patch);
        if (!updated) {
          console.error(chalk.red("Failed to update task"));
          exitCode = 1;
        } else {
          const parts: string[] = [];
          if (colName) parts.push(`column: ${colName}`);
          if (priority) parts.push(`priority: ${priority}`);
          if (dueISO) parts.push(`due: ${dueISO}`);
          const detail = parts.length > 0 ? `  → ${parts.join(", ")}` : "";
          console.log(chalk.green(`✓ Triaged: ${updated.title}${detail}`));
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- board create ----
boardCmd
  .command("create <name>")
  .description("Create and publish a new board")
  .option("--kind <lists|week|compound>", "Board kind (default: lists)", "lists")
  .option("--child <id|name>", "Child board id/name (repeatable for compound boards)")
  .option("--relay <url>", "Relay URL hint (informational)")
  .action(async (name: string, opts) => {
    if (!["lists", "week", "compound"].includes(opts.kind)) {
      console.error(chalk.red(`Invalid --kind: "${opts.kind}". Use: lists, week, or compound`));
      process.exit(1);
    }
    const kind = opts.kind as "lists" | "week" | "compound";
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      let columns: { id: string; name: string }[] = [];
      let children: string[] = [];
      if (kind === "lists") {
        const { createInterface } = await import("readline");
        const answer = await new Promise<string>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("Column names (comma-separated, or blank for none): ", (ans: string) => {
            rl.close();
            resolve(ans.trim());
          });
        });
        if (answer) {
          columns = answer.split(",").map((n) => n.trim()).filter(Boolean).map((n) => ({
            id: crypto.randomUUID(),
            name: n,
          }));
        }
      } else if (kind === "compound") {
        const providedChildren = Array.isArray(opts.child) ? opts.child : (opts.child ? [opts.child] : []);
        children = providedChildren.map((ref: string) => resolveBoardReference(config.boards, ref)?.id ?? ref);
      }
      const { boardId } = await runtime.createBoard({ name, kind, columns, children });
      console.log(chalk.green(`✓ Created board: ${name}  [id: ${boardId}]  [kind: ${kind}]`));
      console.log(chalk.dim("  Joined automatically. Run: taskify board sync to confirm."));
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- assign ----
program
  .command("assign <taskId> <npubOrHex>")
  .description("Assign a task to a user (npub or hex pubkey)")
  .option("--board <id|name>", "Board the task belongs to")
  .option("--notify", "Send assignment DM over NIP-17")
  .action(async (taskId: string, npubOrHex: string, opts) => {
    warnShortTaskId(taskId);
    const hex = npubOrHexToHex(npubOrHex);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const task = await runtime.getTask(taskId, boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else {
        const existing = task.assignees ?? [];
        if (existing.some((a) => a.pubkey === hex)) {
          console.log(chalk.dim(`Already assigned: ${npubOrHex}`));
        } else {
          const updated = await runtime.updateTask(taskId, boardId, {
            assignees: [...existing, { pubkey: hex }],
          });
          if (!updated) {
            console.error(chalk.red("Failed to update task"));
            exitCode = 1;
          } else {
            console.log(chalk.green(`✓ Assigned to: ${updated.title}`));
            if (opts.notify) {
              const senderHex = nsecToHexOrThrow(config.nsec);
              const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
              const envelope = buildTaskShareEnvelope({
                type: "task",
                title: updated.title,
                note: updated.note,
                priority: updated.priority,
                dueISO: updated.dueISO,
                dueDateEnabled: updated.dueDateEnabled,
                dueTimeEnabled: updated.dueTimeEnabled,
                sourceTaskId: updated.id,
                assignment: true,
                assignees: (updated.assignees ?? []).map((a) => ({ pubkey: a.pubkey })),
                relays: config.relays,
              }, { npub: senderNpub });
              await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: hex, relays: config.relays });
              console.log(chalk.dim("  ↳ assignment request DM sent"));
            }
          }
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- unassign ----
program
  .command("unassign <taskId> <npubOrHex>")
  .description("Remove an assignee from a task")
  .option("--board <id|name>", "Board the task belongs to")
  .action(async (taskId: string, npubOrHex: string, opts) => {
    warnShortTaskId(taskId);
    const hex = npubOrHexToHex(npubOrHex);
    const config = await loadConfig(program.opts().profile as string | undefined);
    const boardId = await resolveBoardId(opts.board, config);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const task = await runtime.getTask(taskId, boardId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        exitCode = 1;
      } else {
        const filtered = (task.assignees ?? []).filter((a) => a.pubkey !== hex);
        const updated = await runtime.updateTask(taskId, boardId, {
          assignees: filtered,
        });
        if (!updated) {
          console.error(chalk.red("Failed to update task"));
          exitCode = 1;
        } else {
          console.log(chalk.green(`✓ Unassigned from: ${updated.title}`));
        }
      }
    } catch (err) {
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exit(exitCode);
    }
  });

// ---- Helper: readline queue (handles piped stdin correctly) ----
function makeLineQueue(rl: ReturnType<typeof createInterface>): (prompt: string) => Promise<string> {
  const lineQueue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on("line", (line: string) => {
    if (waiters.length > 0) {
      waiters.shift()!(line);
    } else {
      lineQueue.push(line);
    }
  });
  return (prompt: string) => {
    process.stdout.write(prompt);
    return new Promise<string>((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift()!);
      } else {
        waiters.push(resolve);
      }
    });
  };
}

// ---- profile command group ----
const profileCmd = program
  .command("profile")
  .description("Manage named Nostr identity profiles");

// Helper to get npub string from nsec
function nsecToNpub(nsec: string): string | null {
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type === "nsec") {
      const pk = getPublicKey(decoded.data as Uint8Array);
      return nip19.npubEncode(pk);
    }
  } catch { /* ignore */ }
  return null;
}

profileCmd
  .command("list")
  .description("List all profiles (► marks active)")
  .action(async () => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    for (const [name, profile] of Object.entries(config.profiles)) {
      const isActive = name === config.activeProfile;
      const marker = isActive ? "►" : " ";
      let npubStr = "(no key)";
      if (profile.nsec) {
        const npub = nsecToNpub(profile.nsec);
        if (npub) npubStr = npub.slice(0, 12) + "..." + npub.slice(-4);
      }
      const boardCount = profile.boards?.length ?? 0;
      console.log(
        `  ${marker} ${name.padEnd(14)} ${npubStr.padEnd(22)} ${boardCount} board${boardCount !== 1 ? "s" : ""}`,
      );
    }
    process.exit(0);
  });

profileCmd
  .command("add <name>")
  .description("Add a new profile (runs mini onboarding for the new identity)")
  .option("--nsec <key>", "Nostr private key (skips interactive prompt)")
  .option("--relay <url>", "Add a relay (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action(async (name: string, opts: { nsec?: string; relay: string[] }) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (config.profiles[name]) {
      console.error(chalk.red(`Profile already exists: "${name}"`));
      process.exit(1);
    }

    // Non-interactive mode when --nsec is provided
    if (opts.nsec !== undefined) {
      const nsecInput = opts.nsec.trim();
      if (!nsecInput.startsWith("nsec1")) {
        console.error(chalk.red("Invalid nsec key"));
        process.exit(1);
      }
      try {
        nip19.decode(nsecInput);
      } catch {
        console.error(chalk.red("Invalid nsec key"));
        process.exit(1);
      }
      const relays = opts.relay.length > 0 ? opts.relay : [...DEFAULT_RELAYS];
      const newProfile: ProfileConfig = {
        nsec: nsecInput,
        relays,
        boards: [],
        trustedNpubs: [],
        securityMode: "moderate",
        securityEnabled: true,
        defaultBoard: "Personal",
        taskReminders: {},
      };
      const newProfiles = { ...config.profiles, [name]: newProfile };
      await saveProfiles(config.activeProfile, newProfiles);
      console.log(chalk.green(`✓ Profile '${name}' created.`));
      process.exit(0);
    }

    // Interactive mode
    console.log();
    console.log(chalk.bold(`Setting up profile: ${name}`));
    console.log();

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = makeLineQueue(rl);

    // Key setup
    const hasKey = await ask("Do you have a Nostr private key (nsec)? [Y/n] ");
    let nsec: string | undefined;

    if (hasKey.trim().toLowerCase() !== "n") {
      while (true) {
        const input = (await ask("Paste your nsec: ")).trim();
        if (input.startsWith("nsec1")) {
          try {
            nip19.decode(input);
            nsec = input;
            break;
          } catch { /* invalid */ }
        }
        console.log("Invalid nsec. Try again or press Ctrl+C to abort.");
      }
    } else {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      nsec = nip19.nsecEncode(sk);
      const npub = nip19.npubEncode(pk);
      console.log();
      console.log("✓ Generated new Nostr identity");
      console.log(`  npub: ${npub}`);
      console.log(`  nsec: ${nsec}  ← KEEP THIS SECRET — it is your password`);
      console.log();
      console.log("Save this nsec somewhere safe. It cannot be recovered if lost.");
      const cont = await ask("Continue? [Y/n] ");
      if (cont.trim().toLowerCase() === "n") {
        rl.close();
        process.exit(0);
      }
    }

    // Relays setup
    console.log();
    let relays = [...DEFAULT_RELAYS];
    const useDefaults = await ask("Use default relays? [Y/n] ");
    if (useDefaults.trim().toLowerCase() === "n") {
      relays = [];
      while (true) {
        const relay = (await ask("Add relay URL (blank to finish): ")).trim();
        if (!relay) break;
        relays.push(relay);
      }
      if (relays.length === 0) relays = [...DEFAULT_RELAYS];
    }

    rl.close();

    const newProfile: ProfileConfig = {
      nsec,
      relays,
      boards: [],
      trustedNpubs: [],
      securityMode: "moderate",
      securityEnabled: true,
      defaultBoard: "Personal",
      taskReminders: {},
    };

    const newProfiles = { ...config.profiles, [name]: newProfile };
    await saveProfiles(config.activeProfile, newProfiles);
    console.log();
    console.log(chalk.green(`✓ Profile '${name}' created. Run: taskify profile use ${name}`));
    process.exit(0);
  });

profileCmd
  .command("use <name>")
  .description("Switch the active profile")
  .action(async (name: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.profiles[name]) {
      console.error(
        chalk.red(`Profile not found: "${name}". Available: ${Object.keys(config.profiles).join(", ")}`),
      );
      process.exit(1);
    }
    await saveProfiles(name, config.profiles);
    console.log(chalk.green(`✓ Switched to profile: ${name}`));
    process.exit(0);
  });

profileCmd
  .command("show [name]")
  .description("Show profile details (defaults to active profile)")
  .action(async (name?: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const profileName = name ?? config.activeProfile;
    const profile = config.profiles[profileName];
    if (!profile) {
      console.error(
        chalk.red(`Profile not found: "${profileName}". Available: ${Object.keys(config.profiles).join(", ")}`),
      );
      process.exit(1);
    }
    const isActive = profileName === config.activeProfile;

    console.log(chalk.bold(`Profile: ${profileName}${isActive ? "  ◄ active" : ""}`));

    let npubStr = "(no key)";
    if (profile.nsec) {
      const npub = nsecToNpub(profile.nsec);
      if (npub) npubStr = npub;
    }
    const maskedNsec = profile.nsec ? profile.nsec.slice(0, 8) + "..." : "(not set)";

    console.log(`  nsec:         ${maskedNsec}`);
    console.log(`  npub:         ${npubStr}`);
    console.log(`  relays:       ${(profile.relays ?? []).join(", ")}`);
    console.log(`  boards:       ${profile.boards?.length ?? 0}`);
    console.log(`  trustedNpubs: ${profile.trustedNpubs?.length ?? 0}`);
    process.exit(0);
  });

profileCmd
  .command("remove <name>")
  .description("Remove a profile")
  .option("--force", "Skip confirmation prompt")
  .action(async (name: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.profiles[name]) {
      console.error(chalk.red(`Profile not found: "${name}"`));
      process.exit(1);
    }
    if (name === config.activeProfile) {
      console.error(
        chalk.red(`Cannot remove active profile: "${name}". Switch first with: taskify profile use <other>`),
      );
      process.exit(1);
    }
    if (Object.keys(config.profiles).length === 1) {
      console.error(chalk.red("Cannot remove the only profile."));
      process.exit(1);
    }

    if (!opts.force) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(`Remove profile '${name}'? [y/N] `, (ans: string) => {
          rl.close();
          resolve(ans.toLowerCase() === "y");
        });
      });
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    const { [name]: _removed, ...rest } = config.profiles;
    await saveProfiles(config.activeProfile, rest);
    console.log(chalk.green(`✓ Profile '${name}' removed.`));
    process.exit(0);
  });

profileCmd
  .command("rename <old> <new>")
  .description("Rename a profile")
  .action(async (oldName: string, newName: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.profiles[oldName]) {
      console.error(chalk.red(`Profile not found: "${oldName}"`));
      process.exit(1);
    }
    if (config.profiles[newName]) {
      console.error(chalk.red(`Profile already exists: "${newName}"`));
      process.exit(1);
    }
    const { [oldName]: profileData, ...rest } = config.profiles;
    const newProfiles = { ...rest, [newName]: profileData };
    const newActive = config.activeProfile === oldName ? newName : config.activeProfile;
    await saveProfiles(newActive, newProfiles);
    console.log(chalk.green(`✓ Renamed profile '${oldName}' → '${newName}'`));
    process.exit(0);
  });

profileCmd
  .command("set-meta")
  .description("Update your Nostr profile metadata (kind:0) — only provided fields are updated")
  .option("--name <n>", "Username / handle (name field)")
  .option("--display-name <n>", "Display name (display_name field)")
  .option("--about <text>", "Bio / about")
  .option("--picture <url-or-path>", "Profile picture — URL or local file path (uploaded via NIP-96)")
  .option("--banner <url-or-path>", "Banner image — URL or local file path (uploaded via NIP-96)")
  .option("--nip05 <addr>", "NIP-05 verification address (user@domain.com)")
  .option("--website <url>", "Website URL")
  .option("--lud16 <addr>", "Lightning address (lud16)")
  .option("--nip96-server <url>", "NIP-96 server for image uploads (default: nostr.build)", "https://nostr.build")
  .option("--json", "Output published event as JSON")
  .action(async (opts: {
    name?: string;
    displayName?: string;
    about?: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    website?: string;
    lud16?: string;
    nip96Server: string;
    json?: boolean;
  }) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.nsec) {
      console.error(chalk.red("No nsec configured for this profile. Run: taskify setup"));
      process.exit(1);
    }

    // If no fields provided, show current metadata
    const hasChanges = [opts.name, opts.displayName, opts.about, opts.picture, opts.banner, opts.nip05, opts.website, opts.lud16].some(v => v !== undefined);
    if (!hasChanges) {
      console.error(chalk.yellow("No fields specified. Use --name, --display-name, --about, --picture, --banner, --nip05, --website, --lud16"));
      console.error(chalk.dim("  Example: taskify profile set-meta --display-name \"Nathan\" --picture ./avatar.png"));
      process.exit(1);
    }

    // Upload local files via NIP-96 if needed
    const resolveMedia = async (value: string | undefined, label: string): Promise<string | undefined> => {
      if (!value) return undefined;
      if (value.startsWith("http://") || value.startsWith("https://")) return value;
      // Treat as local file path — upload to NIP-96
      console.log(chalk.dim(`  Uploading ${label} via NIP-96...`));
      try {
        const url = await uploadImageToNip96({
          serverUrl: opts.nip96Server,
          filePath: value,
          nsec: config.nsec!,
        });
        console.log(chalk.dim(`  ✓ Uploaded: ${url}`));
        return url;
      } catch (err) {
        console.error(chalk.red(`Failed to upload ${label}: ${String(err)}`));
        process.exit(1);
      }
    };

    const pictureUrl = await resolveMedia(opts.picture, "profile picture");
    const bannerUrl = await resolveMedia(opts.banner, "banner");

    const draft = {
      name: opts.name,
      displayName: opts.displayName,
      about: opts.about,
      picture: pictureUrl,
      banner: bannerUrl,
      nip05: opts.nip05,
      website: opts.website,
      lud16: opts.lud16,
    };

    // Strip undefined so we only update provided fields
    const cleanDraft = Object.fromEntries(
      Object.entries(draft).filter(([, v]) => v !== undefined)
    ) as typeof draft;

    console.log(chalk.dim("  Publishing profile metadata..."));

    try {
      const result = await publishProfile(config.nsec, cleanDraft, config.relays);
      if (opts.json) {
        console.log(JSON.stringify(result.event, null, 2));
      } else {
        console.log(chalk.green(`✓ Profile updated (event: ${result.event.id?.slice(0, 8)}...)`));
        const content = JSON.parse(result.event.content ?? "{}");
        if (content.name) console.log(`  name:         ${content.name}`);
        if (content.display_name) console.log(`  display_name: ${content.display_name}`);
        if (content.about) console.log(`  about:        ${content.about}`);
        if (content.picture) console.log(`  picture:      ${content.picture}`);
        if (content.banner) console.log(`  banner:       ${content.banner}`);
        if (content.nip05) console.log(`  nip05:        ${content.nip05}`);
        if (content.website) console.log(`  website:      ${content.website}`);
        if (content.lud16) console.log(`  lud16:        ${content.lud16}`);
        if (result.deletedIds.length) console.log(chalk.dim(`  (deleted superseded event: ${result.deletedIds[0]?.slice(0, 8)}...)`));
      }
    } catch (err) {
      console.error(chalk.red(`Failed to publish profile: ${String(err)}`));
      process.exit(1);
    }
    process.exit(0);
  });

profileCmd
  .command("fetch-meta [name]")
  .description("Fetch and display current Nostr profile metadata from relays (defaults to active profile)")
  .option("--json", "Output raw kind:0 event as JSON")
  .action(async (name: string | undefined, opts: { json?: boolean }) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const profileName = name ?? config.activeProfile;
    const profile = config.profiles[profileName];
    if (!profile) {
      console.error(chalk.red(`Profile not found: "${profileName}"`));
      process.exit(1);
    }
    if (!profile.nsec) {
      console.error(chalk.red("No nsec configured for this profile."));
      process.exit(1);
    }
    const decoded = nip19.decode(profile.nsec);
    if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exit(1); }
    const pubkeyHex = getPublicKey(decoded.data as Uint8Array);

    console.log(chalk.dim("  Fetching profile metadata from relays..."));
    const { event, metadata } = await fetchLatestProfileEvent(pubkeyHex, profile.relays ?? []);

    if (!event) {
      console.log(chalk.yellow("No kind:0 profile event found on relays."));
      process.exit(0);
    }

    if (opts.json) {
      console.log(JSON.stringify(event, null, 2));
    } else {
      const npub = nip19.npubEncode(pubkeyHex);
      console.log(chalk.bold(`Profile: ${profileName}`));
      console.log(`  npub:         ${npub}`);
      if (metadata.name) console.log(`  name:         ${metadata.name}`);
      if (metadata.displayName || (metadata as any).display_name) console.log(`  display_name: ${metadata.displayName ?? (metadata as any).display_name}`);
      if (metadata.about) console.log(`  about:        ${metadata.about}`);
      if (metadata.picture) console.log(`  picture:      ${metadata.picture}`);
      if (metadata.banner) console.log(`  banner:       ${metadata.banner}`);
      if (metadata.nip05) console.log(`  nip05:        ${metadata.nip05}`);
      if (metadata.website) console.log(`  website:      ${metadata.website}`);
      if (metadata.lud16) console.log(`  lud16:        ${metadata.lud16}`);
      console.log(chalk.dim(`  (event id: ${event.id?.slice(0, 8)}..., created_at: ${new Date((event.created_at ?? 0) * 1000).toISOString()})`));
    }
    process.exit(0);
  });

// ---- contact command group ----
const contactCmd = program
  .command("contact")
  .description("Manage contacts");

function resolveContact(contacts: Contact[], ref: string): Contact | undefined {
  const lower = ref.toLowerCase();
  return contacts.find(
    (c) =>
      c.npub === ref ||
      c.pubkey === ref ||
      c.pubkey.startsWith(lower) ||
      (c.name?.toLowerCase() === lower),
  );
}

contactCmd
  .command("list")
  .description("List local contacts")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const contacts = config.contacts ?? [];
    if (opts.json) { renderJson(contacts); process.exit(0); }
    if (contacts.length === 0) { console.log(chalk.dim("No contacts.")); process.exit(0); }
    for (const c of contacts) {
      const key = c.npub ?? c.pubkey.slice(0, 12) + "...";
      const label = [c.name, c.nip05].filter(Boolean).join(" / ");
      console.log(`  ${chalk.bold(key)}  ${chalk.dim(label)}`);
    }
    process.exit(0);
  });

contactCmd
  .command("show <npubOrId>")
  .description("Show contact details")
  .option("--json", "Output as JSON")
  .action(async (ref: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const contact = resolveContact(config.contacts ?? [], ref);
    if (!contact) { console.error(chalk.red(`Contact not found: ${ref}`)); process.exit(1); }
    if (opts.json) { renderJson(contact); process.exit(0); }
    console.log(chalk.bold("Contact"));
    for (const [k, v] of Object.entries(contact)) {
      if (v !== undefined && v !== null) console.log(`  ${chalk.dim(k + ":")} ${v}`);
    }
    process.exit(0);
  });

contactCmd
  .command("add <npub>")
  .description("Add a contact locally")
  .option("--name <name>", "Display name")
  .option("--nip05 <nip05>", "NIP-05 identifier")
  .action(async (npubArg: string, opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    let pubkeyHex: string;
    let npub: string;
    try {
      const decoded = nip19.decode(npubArg);
      if (decoded.type !== "npub") throw new Error("Expected npub");
      pubkeyHex = decoded.data as string;
      npub = npubArg;
    } catch {
      console.error(chalk.red("Invalid npub: " + npubArg));
      process.exit(1);
    }
    const contacts = config.contacts ?? [];
    if (contacts.find((c) => c.pubkey === pubkeyHex)) {
      console.log(chalk.yellow("Contact already exists."));
      process.exit(0);
    }
    const contact: Contact = {
      pubkey: pubkeyHex,
      npub,
      name: opts.name,
      nip05: opts.nip05,
      addedAt: Math.floor(Date.now() / 1000),
    };
    config.contacts = [...contacts, contact];
    await saveConfig(config);
    console.log(chalk.green(`✓ Added contact: ${opts.name ?? npub}`));
    process.exit(0);
  });

contactCmd
  .command("remove <npubOrId>")
  .description("Remove a contact")
  .action(async (ref: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const contacts = config.contacts ?? [];
    const contact = resolveContact(contacts, ref);
    if (!contact) { console.error(chalk.red(`Contact not found: ${ref}`)); process.exit(1); }
    config.contacts = contacts.filter((c) => c.pubkey !== contact.pubkey);
    await saveConfig(config);
    console.log(chalk.green(`✓ Removed contact: ${contact.name ?? contact.npub ?? contact.pubkey}`));
    process.exit(0);
  });

contactCmd
  .command("fetch <npub>")
  .description("Fetch/refresh NIP-01 kind 0 profile for a contact from relays")
  .action(async (npubArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    let pubkeyHex: string;
    let npub: string;
    try {
      const decoded = nip19.decode(npubArg);
      if (decoded.type !== "npub") throw new Error("Expected npub");
      pubkeyHex = decoded.data as string;
      npub = npubArg;
    } catch {
      console.error(chalk.red("Invalid npub: " + npubArg));
      process.exit(1);
    }
    const runtime = initRuntime(config);
    try {
      process.stderr.write("Fetching kind 0 profile from relays...\n");
      const NDKMod = await import("@nostr-dev-kit/ndk");
      const ndk = new NDKMod.default({ explicitRelayUrls: config.relays });
      await ndk.connect();
      const events = await ndk.fetchEvents(
        { kinds: [0], authors: [pubkeyHex], limit: 1 } as Parameters<typeof ndk.fetchEvents>[0],
        { closeOnEose: true },
      );
      let profileData: Record<string, unknown> = {};
      if (events.size > 0) {
        const [evt] = events;
        try { profileData = JSON.parse(evt.content); } catch { /* ignore */ }
      }
      const contacts = config.contacts ?? [];
      const idx = contacts.findIndex((c) => c.pubkey === pubkeyHex);
      const existing: Contact = idx >= 0 ? contacts[idx] : { pubkey: pubkeyHex, npub, addedAt: Math.floor(Date.now() / 1000) };
      const updated: Contact = {
        ...existing,
        name: (profileData.name as string | undefined) ?? existing.name,
        displayName: (profileData.display_name as string | undefined) ?? existing.displayName,
        nip05: (profileData.nip05 as string | undefined) ?? existing.nip05,
        about: (profileData.about as string | undefined) ?? existing.about,
        picture: (profileData.picture as string | undefined) ?? existing.picture,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      if (idx >= 0) contacts[idx] = updated;
      else contacts.push(updated);
      config.contacts = contacts;
      await saveConfig(config);
      console.log(chalk.green(`✓ Fetched profile for ${updated.name ?? npub}`));
      try { (ndk.pool as unknown as { destroy?(): void })?.destroy?.(); } catch { /* ignore */ }
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      await runtime.disconnect();
    }
    process.exit(0);
  });

contactCmd
  .command("sync")
  .description("Publish/restore NIP-51 kind 30000 encrypted private contacts list to/from relays")
  .option("--pull", "Only pull from relays (default: push and pull)")
  .option("--json", "Output merged contacts as JSON after sync")
  .action(async (opts) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    if (!config.nsec) {
      console.error(chalk.red("No nsec configured — cannot sync contacts"));
      process.exit(1);
    }
    const decoded = nip19.decode(config.nsec);
    if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exit(1); }
    const userSk = decoded.data as Uint8Array;
    const userPk = getPublicKey(userSk);
    const NDKMod = await import("@nostr-dev-kit/ndk");
    const NDKPrivateKeySigner = (await import("@nostr-dev-kit/ndk")).NDKPrivateKeySigner;
    const ndk = new NDKMod.default({ explicitRelayUrls: config.relays, signer: new NDKPrivateKeySigner(bytesToHex(userSk)) });
    await ndk.connect();
    const contacts = config.contacts ?? [];
    try {
      // Fetch existing kind 30000 from relay
      const existing = await ndk.fetchEvents(
        { kinds: [30000], authors: [userPk], "#d": ["taskify-contacts"], limit: 1 } as Parameters<typeof ndk.fetchEvents>[0],
        { closeOnEose: true },
      );
      if (existing.size > 0) {
        const [evt] = existing;
        const pTags = evt.tags.filter((t: string[]) => t[0] === "p");
        for (const pTag of pTags) {
          const pk = pTag[1];
          if (pk && !contacts.find((c) => c.pubkey === pk)) {
            contacts.push({
              pubkey: pk,
              npub: nip19.npubEncode(pk),
              addedAt: evt.created_at ?? Math.floor(Date.now() / 1000),
            });
          }
        }
      }
      if (!opts.pull && contacts.length > 0) {
        const NDKEventMod = await import("@nostr-dev-kit/ndk");
        const syncEvent = new NDKEventMod.NDKEvent(ndk);
        syncEvent.kind = 30000;
        syncEvent.content = "";
        syncEvent.tags = [
          ["d", "taskify-contacts"],
          ...contacts.map((c): string[] => ["p", c.pubkey, ...(c.relays?.[0] ? [c.relays[0]] : [])]),
        ];
        await syncEvent.sign();
        await syncEvent.publish();
        console.log(chalk.green(`✓ Published ${contacts.length} contacts to relay`));
      }
      config.contacts = contacts;
      await saveConfig(config);
      if (opts.json) renderJson(contacts);
      else console.log(chalk.green(`✓ Synced ${contacts.length} contacts`));
    } catch (err) {
      console.error(chalk.red(String(err)));
      process.exit(1);
    } finally {
      try { (ndk.pool as unknown as { destroy?(): void })?.destroy?.(); } catch { /* ignore */ }
    }
    process.exit(0);
  });

// ---- setup ----
program
  .command("setup")
  .description("Run the first-run onboarding wizard (re-configure a profile)")
  .option("--profile <name>", "Profile to configure (defaults to active profile)")
  .action(async (opts) => {
    // --profile on setup subcommand takes precedence over global --profile
    const targetProfile = opts.profile ?? (program.opts().profile as string | undefined);
    const existing = await loadConfig(targetProfile);
    if (existing.nsec) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise<string>((resolve) => {
        rl.question(
          `⚠ Profile "${existing.activeProfile}" already has a private key. This will replace it.\nContinue? [Y/n] `,
          resolve,
        );
      });
      rl.close();
      if (ans.trim().toLowerCase() === "n") {
        process.exit(0);
      }
    }
    await runOnboarding(targetProfile ?? existing.activeProfile);
  });

// ---- auto-onboarding trigger + parse ----
const cfg = await loadConfig(program.opts().profile as string | undefined);
// Trigger onboarding if no profiles have an nsec and no command was given
const hasAnyNsec = Object.values(cfg.profiles).some((p) => p.nsec);
if (!hasAnyNsec && process.argv.length <= 2) {
  await runOnboarding();
} else {
  program.parse(process.argv);
}
