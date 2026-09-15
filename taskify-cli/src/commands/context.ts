import { bytesToHex,hexToBytes } from "@noble/hashes/utils.js";
import chalk from "chalk";
import type { Command } from "commander";
import { getPublicKey,nip19 } from "nostr-tools";
import {
normalizeTaskAssignees,
normalizeTaskDocuments
} from "taskify-core";
import { buildAttachmentDocuments } from "../attachmentCrypto.js";
import { loadConfig } from "../config.js";
import { createNostrRuntime,type NostrRuntime } from "../nostrRuntime.js";
import { agentFailure,writeAgentJson } from "../shared/agentOutput.js";
import { CliLocationError } from "../shared/cliLocation.js";
import { formatAvailableColumns,resolveBoardColumn } from "../shared/columnResolution.js";
import { resolveBoardForCommand } from "../shared/commandResolution.js";
import {
secretKeyHexFromNsec
} from "../shared/nodeRuntimeSession.js";

export type CoreErrorDetails = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
};
export function createCommandContext(program: Command) {
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
   * Returns the matched taskId or throws a structured error if ambiguous / not found.
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
      throw new CliCommandError(
        "NOT_FOUND",
        `No task found matching title "${title}"${hint}.`,
        { details: { hint: "Use taskify search to find the exact task first." } },
      );
    }
    if (matches.length > 1) {
      throw new CliCommandError(
        "AMBIGUOUS_TASK",
        `${matches.length} tasks match "${title}"${duePart ? ` on ${duePart}` : ""}.`,
        {
          details: {
            hint: "Add --due YYYY-MM-DD to narrow the match, or pass the full task ID.",
            candidates: matches.slice(0, 20).map((task) => ({
              id: task.id,
              title: task.title,
              due: (task.dueISO ?? "").slice(0, 10) || null,
            })),
          },
        },
      );
    }
    return matches[0].id;
  }

  const VALID_REMINDER_PRESETS = new Set(["0h", "5m", "15m", "30m", "1h", "1d", "1w"]);

  function parseJsonOption(label: string, raw: string | undefined): unknown {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new CliCommandError("VALIDATION_ERROR", `Invalid ${label} JSON.`);
    }
  }

  function parseReminderOption(raw: string | undefined): string[] | undefined {
    if (!raw) return undefined;
    const parsed = raw.split(",").map((v) => v.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : undefined;
  }

  function normalizeAssigneeArgs(values: string[] | undefined): Array<{ pubkey: string; relay?: string; status?: "pending" | "accepted" | "declined" | "tentative"; respondedAt?: number }> | undefined {
    if (!values || values.length === 0) return undefined;
    const normalized = normalizeTaskAssignees(values.map((value) => ({ pubkey: npubOrHexToHex(value) })));
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
    const resolved = resolveBoardForCommand(config.boards, boardOpt, config.defaultLocation);
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

  function useHumanOutput(localOptions?: { human?: boolean }): boolean {
    return Boolean(localOptions?.human || program.opts().human);
  }

  class CliCommandError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;

    constructor(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
      super(message);
      this.name = "CliCommandError";
      this.code = code;
      this.retryable = options.retryable ?? false;
      this.details = options.details;
    }
  }



  function requireWriteIdentity(config: Awaited<ReturnType<typeof loadConfig>>): void {
    if (!profilePubkey(config)) {
      throw new CliCommandError(
        "CONFIG_INVALID",
        "The active profile has no valid Nostr identity. Configure an nsec before writing tasks.",
      );
    }
  }

  function validateCoreDue(due: string | undefined): void {
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      throw new CliCommandError("VALIDATION_ERROR", `Invalid --due format: "${due}". Expected YYYY-MM-DD.`);
    }
  }

  function validateCorePriority(priority: string | undefined): void {
    if (priority && !["1", "2", "3"].includes(priority)) {
      throw new CliCommandError("VALIDATION_ERROR", `Invalid --priority: "${priority}". Must be 1, 2, or 3.`);
    }
  }

  function commandErrorDetails(error: unknown): CoreErrorDetails {
    if (error instanceof CliLocationError) {
      return {
        code: error.code,
        message: error.message,
        details: error.candidates.length ? { candidates: error.candidates } : undefined,
        retryable: false,
      };
    }
    if (error instanceof CliCommandError) {
      return { code: error.code, message: error.message, details: error.details, retryable: error.retryable };
    }
    const message = error instanceof Error ? error.message : String(error);
    const typed = error as { code?: unknown; retryable?: unknown; details?: unknown };
    if (typed.code === "WRITE_QUEUED") {
      return {
        code: "WRITE_QUEUED",
        message,
        details: typeof typed.details === "object" && typed.details ? typed.details as Record<string, unknown> : undefined,
        retryable: true,
      };
    }
    if (/task not found|no task found/i.test(message)) {
      return { code: "NOT_FOUND", message, retryable: false };
    }
    if (/requires explicit confirmation/i.test(message)) {
      return { code: "CONFIRMATION_REQUIRED", message, retryable: false };
    }
    if (/no nsec|nostr identity|invalid nsec|config file is malformed|profile not found/i.test(message)) {
      return { code: "CONFIG_INVALID", message, retryable: false };
    }
    const relayFailure = /relay|connect|network|timeout|publish/i.test(message);
    return {
      code: relayFailure ? "TEMPORARY_CONNECTIVITY" : "COMMAND_FAILED",
      message,
      retryable: relayFailure,
    };
  }

  function writeCoreFailure(command: string, error: unknown, human: boolean): number {
    const failure = commandErrorDetails(error);
    if (human) {
      console.error(chalk.red(failure.message));
      if (Array.isArray(failure.details?.candidates)) {
        for (const candidate of failure.details.candidates as Array<{ path?: string; id?: string }>) {
          console.error(chalk.dim(`  ${candidate.path ?? candidate.id ?? ""}`));
        }
      }
    } else {
      writeAgentJson(agentFailure(command, failure.code, failure.message, {
        details: failure.details,
        retryable: failure.retryable,
      }));
    }
    return failure.retryable ? 75 : 1;
  }

  function profilePubkey(config: Awaited<ReturnType<typeof loadConfig>>): { hex: string; npub: string } | null {
    try {
      const secret = secretKeyHexFromNsec(config.nsec);
      const hex = getPublicKey(hexToBytes(secret));
      return { hex, npub: nip19.npubEncode(hex) };
    } catch {
      return null;
    }
  }


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


  return { validateDue, validatePriority, warnShortTaskId, resolveTaskIdByTitle, VALID_REMINDER_PRESETS, parseJsonOption, parseReminderOption, normalizeAssigneeArgs, initRuntime, resolveBoardId, mergeAttachmentDocuments, resolveAttachmentDocuments, extractDocumentUrl, resolveDocumentByRef, useHumanOutput, CliCommandError, requireWriteIdentity, validateCoreDue, validateCorePriority, commandErrorDetails, writeCoreFailure, profilePubkey, resolveColumnOrExit, npubOrHexToHex, nsecToHexOrThrow };
}
export type CommandContext = ReturnType<typeof createCommandContext>;
