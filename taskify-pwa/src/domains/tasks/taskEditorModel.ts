/**
 * The task editor's form, without React: the values it starts from for a task, and the task it
 * saves from what was edited. A schedule left untouched keeps the task's exact due instant, so
 * opening and saving a task never shifts it.
 */
import { normalizeTaskAssignmentStatus } from "taskify-core";
import { isoDatePart, isoFromDateTime, isoTimePart, normalizeTimeZone } from "../dateTime/dateUtils";
import { DEFAULT_DATE_REMINDER_TIME, normalizeReminderTime } from "../dateTime/reminderUtils";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { compressedToRawHex } from "./contactUtils";
import { hiddenUntilForBoard } from "./boardUtils";
import type {
  Board,
  Recurrence,
  ReminderPreset,
  Subtask,
  Task,
  TaskAssignee,
  TaskPriority,
  Weekday,
} from "./taskTypes";
import type { TaskDocument } from "../../lib/documents";

/** An assignee's key as 64-char lowercase hex, or null. */
export function normalizeAssigneePubkey(value: string | null | undefined): string | null {
  const normalized = normalizeNostrPubkey(value);
  const raw = compressedToRawHex(normalized ?? (value || "")).toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

/** Valid, de-duplicated assignees, keeping relay, status and response time. */
export function normalizeAssigneeList(value: Task["assignees"] | undefined): TaskAssignee[] {
  if (!Array.isArray(value)) return [];
  const normalized: TaskAssignee[] = [];
  const seen = new Set<string>();
  value.forEach((assignee) => {
    const pubkey = normalizeAssigneePubkey(assignee?.pubkey);
    if (!pubkey || seen.has(pubkey)) return;
    seen.add(pubkey);
    const relay = typeof assignee?.relay === "string" ? assignee.relay.trim() : "";
    const status = normalizeTaskAssignmentStatus(assignee?.status) as TaskAssignee["status"] | undefined;
    const respondedAtRaw = Number(assignee?.respondedAt);
    const respondedAt = Number.isFinite(respondedAtRaw) && respondedAtRaw > 0 ? Math.round(respondedAtRaw) : undefined;
    normalized.push({
      pubkey,
      ...(relay ? { relay } : {}),
      ...(status ? { status } : {}),
      ...(respondedAt ? { respondedAt } : {}),
    });
  });
  return normalized;
}

/** Where the editor's schedule starts for a task. */
export type TaskEditorStart = {
  dateEnabled: boolean;
  /** YYYY-MM-DD in `timeZone`, or "" without a date. */
  date: string;
  /** HH:MM when the task has a due time, else "". */
  time: string;
  /** The task had its due time switched on. */
  hadTime: boolean;
  timeZone: string;
  reminders: ReminderPreset[];
  reminderTime: string;
  /** The task's time even when its time is off (what the time picker reopens at). */
  storedTime: string;
};

export function taskEditorStart(task: Task, systemTimeZone: string): TaskEditorStart {
  const hasDate = task.dueDateEnabled !== false;
  const timeZone = normalizeTimeZone(task.dueTimeEnabled ? task.dueTimeZone : undefined) ?? systemTimeZone;
  const date = hasDate ? isoDatePart(task.dueISO, timeZone) : "";
  const storedTime = hasDate ? isoTimePart(task.dueISO, timeZone) : "";
  const hasTime = hasDate && (task.dueTimeEnabled ?? false);
  return {
    dateEnabled: hasDate && !!date,
    date,
    time: hasTime ? storedTime : "",
    hadTime: hasTime,
    timeZone,
    reminders: task.reminders ?? [],
    reminderTime: normalizeReminderTime(task.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME,
    storedTime,
  };
}

/** What the editor holds when it saves. */
export type TaskEditorDraft = {
  title: string;
  note: string;
  priority: TaskPriority | 0;
  images: string[];
  documents: TaskDocument[];
  subtasks: Subtask[];
  assignees: TaskAssignee[];
  rule: Recurrence;
  boardId: string;
  /** The chosen board, if known; `boardKind` applies when it is not. */
  board: Board | null;
  boardKind: Board["kind"];
  columnId: string;
  dateEnabled: boolean;
  date: string;
  time: string;
  timeZone: string;
  reminders: ReminderPreset[];
  reminderTime: string;
};

export function buildTaskFromEditor(
  task: Task,
  start: TaskEditorStart,
  draft: TaskEditorDraft,
  weekStart: Weekday,
): Task {
  const boardKind = draft.board?.kind ?? draft.boardKind;
  // Week boards place tasks by date, so a task there always has one.
  const dateEnabled = boardKind === "week" ? true : draft.dateEnabled;
  const baseDate = draft.date || start.date || isoDatePart(task.dueISO, start.timeZone);
  const hasTime = dateEnabled && draft.time.trim().length > 0;
  const unchanged =
    baseDate === start.date &&
    hasTime === start.hadTime &&
    (!hasTime || draft.time === start.storedTime) &&
    (!hasTime || draft.timeZone === start.timeZone);
  const dueISO = dateEnabled
    ? unchanged
      ? task.dueISO
      : isoFromDateTime(baseDate, hasTime ? draft.time : undefined, hasTime ? draft.timeZone : undefined)
    : task.dueISO;
  const listColumnId =
    boardKind === "lists"
      ? draft.columnId || (draft.board?.kind === "lists" ? draft.board.columns[0]?.id : undefined)
      : undefined;
  return {
    ...task,
    boardId: draft.boardId,
    columnId: boardKind === "lists" ? listColumnId : undefined,
    column: boardKind === "week" ? "day" : undefined,
    title: draft.title,
    priority: draft.priority === 0 ? undefined : draft.priority,
    note: draft.note || undefined,
    images: draft.images.length ? draft.images : undefined,
    documents: draft.documents.length ? draft.documents : undefined,
    subtasks: draft.subtasks.length ? draft.subtasks : undefined,
    assignees: draft.assignees.length ? normalizeAssigneeList(draft.assignees) : undefined,
    recurrence: draft.rule.type === "none" ? undefined : draft.rule,
    dueISO,
    dueDateEnabled: dateEnabled,
    hiddenUntilISO: dateEnabled ? hiddenUntilForBoard(dueISO, boardKind, weekStart) : undefined,
    dueTimeEnabled: hasTime ? true : undefined,
    dueTimeZone: hasTime ? draft.timeZone : undefined,
    reminders: dateEnabled ? [...draft.reminders] : [],
    reminderTime: dateEnabled && !hasTime ? normalizeReminderTime(draft.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME : undefined,
  };
}
