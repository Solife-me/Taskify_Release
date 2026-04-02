import chalk from "chalk";
import type { FullTaskRecord } from "./nostrRuntime.js";
import { nip19 } from "nostr-tools";
import { TASK_PRIORITY_MARKS } from "./shared/taskTypes.js";
import type { ReminderPreset } from "./shared/taskTypes.js";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toNpubSafe(hex: string): string | null {
  // hex must be raw 32-byte (64-char) — encode directly, no prefix stripping
  try { return nip19.npubEncode(hex); } catch { return null; }
}

function truncateNpub(raw: string | undefined): string {
  if (!raw) return "unknown";
  const npub = toNpubSafe(raw) ?? raw;
  if (npub.length <= 16) return npub;
  return npub.slice(0, 12) + "...";
}

function npubToHex(npubOrHex: string): string {
  if (npubOrHex.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(npubOrHex);
      if (decoded.type === "npub") return decoded.data as string;
    } catch { /* fall through */ }
  }
  return npubOrHex;
}

export function trustLabel(lastEditedBy: string | undefined, trustedNpubs: string[]): string {
  if (!lastEditedBy) return chalk.yellow("? unknown");
  // Normalize all trusted entries to raw hex for comparison
  const trustedHexSet = new Set(trustedNpubs.map(npubToHex));
  if (trustedHexSet.has(lastEditedBy)) return chalk.green("✓ trusted");
  return chalk.red("✗ untrusted");
}

function truncateWithSubtasks(task: FullTaskRecord, titleLen: number): string {
  const subtasks = task.subtasks;
  let suffix = "";
  if (Array.isArray(subtasks) && subtasks.length > 0) {
    const done = subtasks.filter((s) => s.completed).length;
    suffix = ` (${done}/${subtasks.length})`;
  }
  const available = titleLen - suffix.length;
  let base = task.title;
  if (base.length > available) {
    base = base.slice(0, available - 1) + "…";
  }
  return (base + suffix).padEnd(titleLen);
}

function formatDue(dueISO: string): string {
  if (!dueISO) return "".padEnd(12);
  return dueISO.slice(0, 10).padEnd(12);
}

function formatPri(priority: number | undefined): string {
  if (!priority) return "-".padEnd(4);
  return String(priority).padEnd(4);
}

function formatRec(task: FullTaskRecord): string {
  const rec = task.recurrence;
  if (!rec || rec.type === "none") return "".padEnd(5);
  switch (rec.type) {
    case "daily": return "DAY  ";
    case "weekly": return "WKL  ";
    case "every": return "EVR  ";
    case "monthlyDay": return "MON  ";
    default: return "".padEnd(5);
  }
}

function formatBounty(task: FullTaskRecord): string {
  const b = task.bounty as Record<string, unknown> | undefined;
  if (!b || b.amount === undefined) return "";
  const amt = String(b.amount);
  switch (b.state) {
    case "claimed": return amt + "✓";
    case "locked": return amt + "⏳";
    case "revoked": return amt + "✗";
    default: return amt;
  }
}

function formatRecurrenceFull(task: FullTaskRecord): string {
  const rec = task.recurrence;
  if (!rec || rec.type === "none") return "";
  switch (rec.type) {
    case "daily": return "daily";
    case "weekly": {
      const days = (rec.days ?? []).map((d) => WEEKDAY_NAMES[d] ?? d).join(" ");
      return `weekly ${days}`.trim();
    }
    case "every": return `every ${rec.n} ${rec.unit}`;
    case "monthlyDay": return `monthlyDay ${rec.day}${rec.interval ? ` (every ${rec.interval})` : ""}`;
    default: return "";
  }
}

function formatAssignee(task: FullTaskRecord): string {
  const assignees = task.assignees;
  if (!Array.isArray(assignees) || assignees.length === 0) return "".padEnd(12);
  const first = assignees[0]?.pubkey;
  if (!first) return "".padEnd(12);
  const npub = toNpubSafe(first) ?? first;
  const truncated = npub.length > 12 ? npub.slice(0, 9) + "..." : npub;
  return truncated.padEnd(12);
}

/**
 * Return a short, human-useful display ID for a task.
 * For recurring instances (id starts with "recurrence:"), the full ID is
 * "recurrence:<seriesKey>:<datePart>". We show "~YYYY-MM-DD" (9 chars max)
 * so agents can clearly distinguish instances.
 * For regular tasks we use the standard 8-char UUID prefix.
 */
export function shortTaskId(id: string): string {
  if (id.startsWith("recurrence:")) {
    // Last segment after final ":" is the date/time part
    const lastColon = id.lastIndexOf(":");
    const datePart = id.slice(lastColon + 1); // e.g. "2026-03-14"
    return ("~" + datePart).slice(0, 11).padEnd(11);
  }
  return id.slice(0, 8).padEnd(8);
}

const COL_HEADER = `${"ID".padEnd(11)}  ${"TITLE".padEnd(40)}  ${"LIST".padEnd(12)}  ${"DUE".padEnd(12)}  ${"PRI".padEnd(4)}  ${"REC".padEnd(5)}  ${"BOUNTY".padEnd(8)}  ${"ASSIGN".padEnd(12)}  TRUST`;

export function renderTable(
  tasks: FullTaskRecord[],
  trustedNpubs: string[],
  columnName?: string,
  columns?: Array<{ id: string; name: string }>,
): void {
  // Build a quick id→name lookup for column resolution
  const colMap = new Map<string, string>(
    (columns ?? []).map((c) => [c.id, c.name]),
  );

  const byBoard = new Map<string, FullTaskRecord[]>();
  for (const task of tasks) {
    const group = byBoard.get(task.boardId) ?? [];
    group.push(task);
    byBoard.set(task.boardId, group);
  }

  for (const [boardId, boardTasks] of byBoard) {
    const boardName = boardTasks[0]?.boardName;
    let boardHeader = boardName
      ? `Board: ${boardName}  (${boardId.slice(0, 8)}...)`
      : `Board: ${boardId}`;
    if (columnName) {
      boardHeader += `  •  Column: ${columnName}`;
    }
    console.log("\n" + chalk.bold(boardHeader));
    console.log(chalk.dim(COL_HEADER));
    for (const task of boardTasks) {
      const id = shortTaskId(task.id);
      const title = truncateWithSubtasks(task, 40);
      // Resolve column UUID → name, fall back to short ID, blank if no column
      const colLabel = task.column
        ? (colMap.get(task.column) ?? task.column.slice(0, 8))
        : "";
      const list = colLabel.slice(0, 12).padEnd(12);
      const due = formatDue(task.dueISO);
      const pri = formatPri(task.priority);
      const rec = formatRec(task);
      const bounty = formatBounty(task).padEnd(8);
      const assign = formatAssignee(task);
      const trust = trustLabel(task.lastEditedBy, trustedNpubs);
      console.log(`${id}  ${title}  ${list}  ${due}  ${pri}  ${rec}  ${bounty}  ${assign}  ${trust}`);
    }
  }
}

export function renderTaskCard(task: FullTaskRecord, trustedNpubs: string[], localReminders?: ReminderPreset[]): void {
  const lbl = (s: string) => chalk.dim(s.padEnd(14));

  console.log();
  console.log(`${lbl("ID:")}${task.id.slice(0, 8)}`);
  console.log(`${lbl("Board:")}${task.boardId}`);
  console.log(`${lbl("Title:")}${task.title}`);
  if (task.note) {
    console.log(`${lbl("Note:")}${task.note}`);
  }
  if (task.dueISO) {
    console.log(`${lbl("Due:")}${task.dueISO.slice(0, 10)}`);
  }
  if (task.priority) {
    const mark = TASK_PRIORITY_MARKS[task.priority] ?? String(task.priority);
    console.log(`${lbl("Priority:")}${mark} (${task.priority})`);
  }
  const statusStr = task.completed
    ? `done  (completed ${task.completedAt ? task.completedAt.slice(0, 10) : "?"})`
    : "open";
  console.log(`${lbl("Status:")}${task.completed ? chalk.green(statusStr) : statusStr}`);

  const recStr = formatRecurrenceFull(task);
  if (recStr) {
    console.log(`${lbl("Recurrence:")}${recStr}`);
  }

  if (localReminders && localReminders.length > 0) {
    console.log(`${lbl("Reminders:")}(device-local) ${localReminders.join(", ")}`);
  }

  if (task.subtasks && task.subtasks.length > 0) {
    console.log(`${lbl("Subtasks:")}`);
    task.subtasks.forEach((s, i) => {
      const check = s.completed ? "x" : " ";
      console.log(`  [${i + 1}] [${check}] ${s.title}`);
    });
  }

  if (Array.isArray(task.documents) && task.documents.length > 0) {
    console.log(`${lbl("Documents:")}${task.documents.length}`);
    task.documents.forEach((doc, idx) => {
      const name = typeof doc.name === "string" ? doc.name : `document-${idx + 1}`;
      const url = typeof doc.remoteUrl === "string" ? doc.remoteUrl : (typeof doc.url === "string" ? doc.url : "");
      const flags = [doc.encrypted === true ? "encrypted" : null, typeof doc.kind === "string" ? doc.kind : null].filter(Boolean).join(", ");
      console.log(`  - ${name}${flags ? ` [${flags}]` : ""}${url ? ` (${url})` : ""}`);
    });
  }

  if (Array.isArray(task.assignees) && task.assignees.length > 0) {
    console.log(`${lbl("Assignment states:")}`);
    task.assignees.forEach((a) => {
      const short = truncateNpub(a.pubkey);
      const status = a.status ?? "pending";
      console.log(`  - ${short}: ${status}`);
    });
  }

  if (task.bounty) {
    const b = task.bounty as Record<string, unknown>;
    console.log(`${lbl("Bounty:")}`);
    if (b.amount !== undefined) console.log(`  ${lbl("Amount:")}${b.amount}`);
    console.log(`  ${lbl("State:")}${b.state}`);
    if (b.lock) console.log(`  ${lbl("Lock:")}${b.lock}`);
    if (b.mint) {
      const mint = String(b.mint);
      const mintDisplay = mint.length > 40 ? mint.slice(0, 37) + "..." : mint;
      console.log(`  ${lbl("Mint:")}${mintDisplay}`);
    }
  }

  const createdByDisplay = truncateNpub(task.createdBy);
  console.log(`${lbl("Created by:")}${createdByDisplay}`);

  const editedByDisplay = truncateNpub(task.lastEditedBy);
  const trust = trustLabel(task.lastEditedBy, trustedNpubs);
  console.log(`${lbl("Edited by:")}${editedByDisplay}  ${trust}`);

  if (task.createdAt) {
    const d = new Date(task.createdAt * 1000);
    const dateStr = d.toISOString().slice(0, 16).replace("T", " ");
    console.log(`${lbl("Created at:")}${dateStr}`);
  }
  console.log();
}

export function renderJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
