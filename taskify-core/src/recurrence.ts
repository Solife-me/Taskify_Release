import {
  formatDateKeyFromParts,
  isoDatePart,
  isoFromDateTime,
  isoTimePart,
  isoTimePartUtc,
  normalizeTimeZone,
  parseDateKey,
  startOfDay,
  type DateKeyParts,
} from "./dateTime.js";
import type { ReminderPreset } from "./reminderUtils.js";
import type { Recurrence, Subtask } from "./taskContracts.js";
import { startOfWeekLocal, type Weekday } from "./weekDate.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * The due instant of the occurrence after `currentISO`, or null when the rule has ended.
 * With a valid `timeZone`, days are counted in that zone, so a series keeps its wall-clock day
 * across DST changes and travel. Matches native `TaskRecurrence.nextOccurrence`.
 */
export function nextOccurrence(
  currentISO: string,
  rule: Recurrence,
  keepTime = false,
  timeZone?: string,
): string | null {
  rule = clampRecurrence(rule);
  const safeZone = normalizeTimeZone(timeZone);
  const zonedParts = safeZone ? parseDateKey(isoDatePart(currentISO, safeZone)) : null;
  if (safeZone && zonedParts) return nextZonedOccurrence(currentISO, rule, keepTime, safeZone, zonedParts);

  const currentDate = new Date(currentISO);
  const curDay = startOfDay(currentDate);
  const timeOffset = currentDate.getTime() - curDay.getTime();
  const baseTime = keepTime ? isoTimePart(currentISO) : "";
  const applyTime = (day: Date): string => {
    if (keepTime && baseTime) {
      const datePart = isoDatePart(day.toISOString());
      return isoFromDateTime(datePart, baseTime);
    }
    return new Date(day.getTime() + timeOffset).toISOString();
  };
  const addDays = (d: number) => {
    const nextDay = startOfDay(new Date(curDay.getTime() + d * MS_PER_DAY));
    return applyTime(nextDay);
  };
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null;
      break;
    case "daily":
      next = addDays(1);
      break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) {
          next = cand;
          break;
        }
      }
      break;
    }
    case "every": {
      if (rule.unit === "hour") {
        next = new Date(new Date(currentISO).getTime() + rule.n * MS_PER_HOUR).toISOString();
      } else {
        next = addDays(rule.unit === "day" ? rule.n : rule.n * 7);
      }
      break;
    }
    case "monthlyDay": {
      const y = curDay.getFullYear();
      const m = curDay.getMonth();
      const interval = Math.max(1, rule.interval ?? 1);
      next = applyTime(startOfDay(new Date(y, m + interval, Math.min(rule.day, 28))));
      break;
    }
  }
  if (next && rule.untilISO) {
    const limit = startOfDay(new Date(rule.untilISO)).getTime();
    const n = startOfDay(new Date(next)).getTime();
    if (n > limit) return null;
  }
  return next;
}

/** Out-of-range counts are read as native clients decode them: every ≥ 1, monthly day 1–28. */
function clampRecurrence(rule: Recurrence): Recurrence {
  if (rule.type === "every") return { ...rule, n: Math.max(1, Math.floor(rule.n) || 1) };
  if (rule.type === "monthlyDay") return { ...rule, day: Math.min(28, Math.max(1, Math.floor(rule.day) || 1)) };
  return rule;
}

function nextZonedOccurrence(
  currentISO: string,
  rule: Recurrence,
  keepTime: boolean,
  zone: string,
  dateParts: DateKeyParts,
): string | null {
  const baseTime = keepTime ? isoTimePart(currentISO, zone) : "";
  const applyDate = (parts: DateKeyParts): string =>
    isoFromDateTime(formatDateKeyFromParts(parts.year, parts.month, parts.day), baseTime || undefined, zone);
  const addDays = (d: number): DateKeyParts => {
    const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
    base.setUTCDate(base.getUTCDate() + d);
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
  };
  const weekdayForParts = (parts: DateKeyParts) =>
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() as Weekday;
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null;
      break;
    case "daily":
      next = applyDate(addDays(1));
      break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        if (rule.days.includes(weekdayForParts(cand))) {
          next = applyDate(cand);
          break;
        }
      }
      break;
    }
    case "every": {
      if (rule.unit === "hour") {
        next = new Date(new Date(currentISO).getTime() + rule.n * MS_PER_HOUR).toISOString();
      } else {
        next = applyDate(addDays(rule.unit === "day" ? rule.n : rule.n * 7));
      }
      break;
    }
    case "monthlyDay": {
      const interval = Math.max(1, rule.interval ?? 1);
      const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1 + interval, 1));
      next = applyDate({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: rule.day });
      break;
    }
  }
  if (next && rule.untilISO) {
    if (isoDatePart(next, zone) > isoDatePart(rule.untilISO, zone)) return null;
  }
  return next;
}

/** Daily, weekly and every-N-days/weeks series: one instance is shown at a time, on its due day. */
export function isFrequentRecurrence(rule?: Recurrence | null): boolean {
  if (!rule) return false;
  if (rule.type === "daily" || rule.type === "weekly") return true;
  if (rule.type === "every") return rule.unit === "day" || rule.unit === "week";
  return false;
}

export function revealsOnDueDate(rule: Recurrence): boolean {
  return isFrequentRecurrence(rule);
}

/** When the next instance re-appears: its due day for frequent series, else the start of its week. */
export function hiddenUntilForNext(nextISO: string, rule: Recurrence, weekStart: Weekday): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (revealsOnDueDate(rule)) return nextMidnight.toISOString();
  return startOfWeekLocal(nextMidnight, weekStart).toISOString();
}

/**
 * The id every client gives an occurrence, so two devices completing the same instance converge
 * on one next task: `recurrence:<series>:<date>`, plus `T<HH:mm>` (UTC) for hourly series.
 * Matches native `TaskifySnapshot.recurringInstanceID`.
 */
export function recurringInstanceId(seriesId: string, dueISO: string, rule?: Recurrence, timeZone?: string): string {
  const datePart = isoDatePart(dueISO, timeZone);
  const timePart = rule && rule.type === "every" && rule.unit === "hour" ? isoTimePartUtc(dueISO) : "";
  const suffix = timePart ? `${datePart}T${timePart}` : datePart;
  return `recurrence:${seriesId}:${suffix}`;
}

export type RecurringTaskLike = {
  id: string;
  dueISO: string;
  recurrence?: Recurrence | null;
  seriesId?: string | null;
  dueTimeEnabled?: boolean | null;
  dueTimeZone?: string | null;
  subtasks?: Subtask[] | null;
  reminders?: ReminderPreset[] | null;
};

export type NextRecurringTaskOptions = {
  weekStart: Weekday;
  /** The rule to schedule by; defaults to the task's own. */
  recurrence?: Recurrence;
  /** The instant the next occurrence is counted from; defaults to the task's due date. */
  scheduledFromISO?: string;
  /** Creation time in milliseconds; defaults to now. */
  now?: number;
};

/**
 * The open task that follows `task` in its series, or null when the series has ended. Completion
 * state is cleared, subtasks are unticked, and the id is the shared occurrence id. Board-specific
 * fields (order, column, streaks) are left for the caller.
 */
export function buildNextRecurringTask<T extends RecurringTaskLike>(task: T, options: NextRecurringTaskOptions): T | null {
  const rule = options.recurrence ?? task.recurrence ?? undefined;
  if (!rule || !task.dueISO) return null;
  const timeZone = task.dueTimeZone ?? undefined;
  const nextISO = nextOccurrence(options.scheduledFromISO ?? task.dueISO, rule, !!task.dueTimeEnabled, timeZone);
  if (!nextISO) return null;
  const seriesId = task.seriesId || task.id;
  return {
    ...task,
    id: recurringInstanceId(seriesId, nextISO, rule, timeZone),
    seriesId,
    recurrence: rule,
    createdAt: options.now ?? Date.now(),
    completed: false,
    completedAt: undefined,
    completedBy: undefined,
    bountyDeletedAt: undefined,
    dueISO: nextISO,
    hiddenUntilISO: hiddenUntilForNext(nextISO, rule, options.weekStart),
    subtasks: task.subtasks ? task.subtasks.map((s) => ({ ...s, completed: false })) : undefined,
    reminders: Array.isArray(task.reminders) ? [...task.reminders] : undefined,
  };
}
