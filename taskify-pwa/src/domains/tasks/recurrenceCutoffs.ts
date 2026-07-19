import { recurringSeriesId } from "../../lib/app/weekRecurrenceDomain";
import { isoDatePart, isoFromDateTime } from "../dateTime/dateUtils";
import type { Task } from "./taskTypes";

export const RECURRING_SERIES_CUTOFFS_KEY = "taskify_recurring_series_cutoffs_v1";

/** Board id -> recurring series id -> last allowed occurrence ISO. */
export type RecurringSeriesCutoffs = Record<string, Record<string, string>>;

function normalizeISO(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key === "__proto__" || key === "prototype" || key === "constructor") return null;
  return key;
}

function sanitizeRecurringSeriesCutoffs(value: unknown): RecurringSeriesCutoffs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: RecurringSeriesCutoffs = {};
  for (const [rawBoardId, rawSeries] of Object.entries(value as Record<string, unknown>)) {
    const boardId = safeKey(rawBoardId);
    if (!boardId || !rawSeries || typeof rawSeries !== "object" || Array.isArray(rawSeries)) continue;
    const seriesOut: Record<string, string> = {};
    for (const [rawSeriesId, rawCutoff] of Object.entries(rawSeries as Record<string, unknown>)) {
      const seriesId = safeKey(rawSeriesId);
      const cutoff = normalizeISO(rawCutoff);
      if (seriesId && cutoff) seriesOut[seriesId] = cutoff;
    }
    if (Object.keys(seriesOut).length) out[boardId] = seriesOut;
  }
  return out;
}

export function parseRecurringSeriesCutoffs(raw: unknown): RecurringSeriesCutoffs {
  if (typeof raw !== "string") return sanitizeRecurringSeriesCutoffs(raw);
  if (!raw.trim()) return {};
  try {
    return sanitizeRecurringSeriesCutoffs(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function serializeRecurringSeriesCutoffs(value: RecurringSeriesCutoffs): string {
  const sanitized = sanitizeRecurringSeriesCutoffs(value);
  const sorted: RecurringSeriesCutoffs = {};
  for (const boardId of Object.keys(sanitized).sort()) {
    sorted[boardId] = {};
    for (const seriesId of Object.keys(sanitized[boardId]).sort()) {
      sorted[boardId][seriesId] = sanitized[boardId][seriesId];
    }
  }
  return JSON.stringify(sorted);
}

function cutoffForTask(task: Task, cutoffs: RecurringSeriesCutoffs): string | null {
  const boardId = safeKey(task.boardId);
  const seriesId = safeKey(recurringSeriesId(task));
  if (!boardId || !seriesId) return null;
  return normalizeISO(cutoffs[boardId]?.[seriesId]);
}

function dateKey(value: string, timeZone?: string): string | null {
  if (!normalizeISO(value)) return null;
  return isoDatePart(value, timeZone);
}

export function recurringSeriesCutoffBefore(task: Pick<Task, "dueISO" | "dueTimeZone">): string | null {
  if (!normalizeISO(task.dueISO)) return null;
  const currentKey = isoDatePart(task.dueISO, task.dueTimeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentKey);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  const previousKey = [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return isoFromDateTime(previousKey, undefined, task.dueTimeZone);
}

export function updateRecurringSeriesCutoff(
  current: RecurringSeriesCutoffs,
  task: Task,
  cutoffISO: string,
): RecurringSeriesCutoffs {
  const boardId = safeKey(task.boardId);
  const seriesId = safeKey(recurringSeriesId(task));
  const cutoff = normalizeISO(cutoffISO);
  if (!boardId || !seriesId || !cutoff) return current;

  const existing = normalizeISO(current[boardId]?.[seriesId]);
  const existingKey = existing ? dateKey(existing, task.dueTimeZone) : null;
  const nextKey = dateKey(cutoff, task.dueTimeZone);
  if (existing && existingKey && nextKey && existingKey <= nextKey) return current;

  return {
    ...current,
    [boardId]: {
      ...(current[boardId] ?? {}),
      [seriesId]: cutoff,
    },
  };
}

export function capRecurringTaskAt<TTask extends Task>(task: TTask, cutoffISO: string): TTask {
  if (!task.recurrence) return task;
  const cutoff = normalizeISO(cutoffISO);
  if (!cutoff) return task;

  const seriesId = recurringSeriesId(task);
  const existing = normalizeISO(task.recurrence.untilISO);
  const existingKey = existing ? dateKey(existing, task.dueTimeZone) : null;
  const cutoffKey = dateKey(cutoff, task.dueTimeZone);
  const untilISO = existing && existingKey && cutoffKey && existingKey <= cutoffKey ? existing : cutoff;
  if (task.seriesId === seriesId && task.recurrence.untilISO === untilISO) return task;
  return {
    ...task,
    seriesId,
    recurrence: { ...task.recurrence, untilISO },
  };
}

export function applyRecurringSeriesCutoff<TTask extends Task>(
  task: TTask,
  cutoffs: RecurringSeriesCutoffs,
): TTask | null {
  if (!task.recurrence) return task;
  const cutoff = cutoffForTask(task, cutoffs);
  if (!cutoff) return task;

  const dueKey = dateKey(task.dueISO, task.dueTimeZone);
  const cutoffKey = dateKey(cutoff, task.dueTimeZone);
  if (dueKey && cutoffKey && dueKey > cutoffKey) {
    const isRecoverableBounty = Boolean(
      task.completed &&
      task.bounty &&
      typeof task.bountyDeletedAt === "string" &&
      task.bountyDeletedAt.trim(),
    );
    return isRecoverableBounty ? capRecurringTaskAt(task, cutoff) : null;
  }
  return capRecurringTaskAt(task, cutoff);
}

export function applyRecurringSeriesCutoffs<TTask extends Task>(
  tasks: TTask[],
  cutoffs: RecurringSeriesCutoffs,
): TTask[] {
  const next: TTask[] = [];
  let changed = false;
  for (const task of tasks) {
    const applied = applyRecurringSeriesCutoff(task, cutoffs);
    if (!applied) {
      changed = true;
      continue;
    }
    if (applied !== task) changed = true;
    next.push(applied);
  }
  return changed ? next : tasks;
}

export function detachCancelledRecurringTask<TTask extends Task>(
  task: TTask,
  cutoffs: RecurringSeriesCutoffs,
): TTask {
  if (!task.recurrence) return task;
  if (applyRecurringSeriesCutoff(task, cutoffs)) return task;
  return {
    ...task,
    recurrence: undefined,
    seriesId: undefined,
    hiddenUntilISO: undefined,
  };
}
