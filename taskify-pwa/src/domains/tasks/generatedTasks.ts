/**
 * Tasks Taskify creates for built-in features: the Scripture Memory review task and fasting
 * reminders. Each planner reconciles the task list with the feature's settings and returns the
 * next list plus what to publish. Ids are date-derived on every client, so devices that generate
 * the same task converge on one.
 */
import {
  FASTING_REMINDER_SERIES_ID,
  SCRIPTURE_MEMORY_SERIES_ID,
  hiddenUntilForNext,
  recurringInstanceId,
} from "taskify-core";
import {
  fastingReminderDueTimesForMonth,
  fastingReminderTaskId,
} from "../calendar/holidayUtils";
import { monthKeyFromYearMonth, startOfDay } from "../dateTime/dateUtils";
import type { ScriptureMemoryEntry } from "../scripture/scriptureTypes";
import {
  chooseNextScriptureEntry,
  formatScriptureReference,
  recurrencesEqual,
  scriptureFrequencyToRecurrence,
} from "../scripture/scriptureUtils";
import { applyHiddenForFuture, nextOrderForBoard } from "./boardUtils";
import {
  applyRecurringSeriesCutoff,
  applyRecurringSeriesCutoffs,
  type RecurringSeriesCutoffs,
} from "./recurrenceCutoffs";
import type { Settings } from "./settingsTypes";
import type { Board, Task } from "./taskTypes";

const MS_PER_DAY = 86_400_000;

export type ScriptureReviewPlan = {
  tasks: Task[];
  /** The review task created because none was open; publish it and mark its passage scheduled. */
  created: Task | null;
  scheduledEntryId: string | null;
};

/**
 * Keeps one open Scripture Memory review task on the chosen board: existing review tasks follow
 * the board and frequency (locally; history is not republished), and a review for the most due
 * passage is created when none is open. Returns null when nothing changes.
 */
export function planScriptureReviewTask(
  tasks: Task[],
  cutoffs: RecurringSeriesCutoffs,
  input: {
    targetBoard: Board;
    entries: ScriptureMemoryEntry[];
    baseDays: number;
    now: Date;
    settings: Pick<Settings, "weekStart" | "newTaskPosition">;
  },
): ScriptureReviewPlan | null {
  const { targetBoard, now, settings } = input;
  if (targetBoard.kind === "bible") return null;
  const firstColumn = targetBoard.kind === "lists" ? targetBoard.columns?.[0] : undefined;
  if (targetBoard.kind === "lists" && !firstColumn) return null;
  const recurrence = scriptureFrequencyToRecurrence(input.baseDays);
  const selection = chooseNextScriptureEntry(input.entries, input.baseDays, now);
  if (!selection) return null;

  let changed = false;
  const followed = tasks.map((task) => {
    if (task.seriesId !== SCRIPTURE_MEMORY_SERIES_ID && !task.scriptureMemoryId) return task;
    let updated = task;
    if (updated.seriesId !== SCRIPTURE_MEMORY_SERIES_ID) updated = { ...updated, seriesId: SCRIPTURE_MEMORY_SERIES_ID };
    if (!recurrencesEqual(updated.recurrence, recurrence)) updated = { ...updated, recurrence };
    if (updated.boardId !== targetBoard.id) {
      updated = { ...updated, boardId: targetBoard.id };
      if (targetBoard.kind === "week") updated = { ...updated, column: "day" as const };
      else if (firstColumn) updated = { ...updated, columnId: firstColumn.id };
    } else if (
      firstColumn &&
      updated.columnId !== firstColumn.id &&
      !(targetBoard.kind === "lists" && targetBoard.columns.some((col) => col.id === updated.columnId))
    ) {
      updated = { ...updated, columnId: firstColumn.id };
    }
    if (updated !== task) changed = true;
    return updated;
  });
  const bounded = applyRecurringSeriesCutoffs(followed, cutoffs);
  if (bounded !== followed) changed = true;
  const unchanged = (): ScriptureReviewPlan | null =>
    changed ? { tasks: bounded, created: null, scheduledEntryId: null } : null;

  if (bounded.some((task) => !task.completed && task.seriesId === SCRIPTURE_MEMORY_SERIES_ID)) return unchanged();

  const dueDays = Number.isFinite(selection.stats.dueInDays) && selection.stats.dueInDays > 0
    ? Math.ceil(selection.stats.dueInDays)
    : 0;
  const dueDate = startOfDay(new Date(now.getTime() + dueDays * MS_PER_DAY));
  const dueISO = dueDate.toISOString();
  // A date-derived id, like every later occurrence: two devices that each find no open review
  // (say, one whose passages synced before its tasks did) create the same task.
  const id = recurringInstanceId(SCRIPTURE_MEMORY_SERIES_ID, dueISO, recurrence);
  if (bounded.some((task) => task.id === id)) return unchanged();

  let hiddenUntilISO: string | undefined;
  const todayMidnight = startOfDay(now).getTime();
  if (dueDate.getTime() > todayMidnight) {
    const candidate = hiddenUntilForNext(dueISO, recurrence, settings.weekStart);
    if (candidate && startOfDay(new Date(candidate)).getTime() > todayMidnight) hiddenUntilISO = candidate;
  }
  const nowISO = now.toISOString();
  const review: Task = {
    id,
    boardId: targetBoard.id,
    title: `Review ${formatScriptureReference(selection.entry)}`,
    createdAt: now.getTime(),
    dueISO,
    completed: false,
    order: nextOrderForBoard(targetBoard.id, bounded, settings.newTaskPosition),
    recurrence,
    seriesId: SCRIPTURE_MEMORY_SERIES_ID,
    scriptureMemoryId: selection.entry.id,
    scriptureMemoryStage: selection.entry.stage ?? 0,
    scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
    scriptureMemoryScheduledAt: nowISO,
    ...(hiddenUntilISO ? { hiddenUntilISO } : {}),
    ...(targetBoard.kind === "week" ? { column: "day" as const } : {}),
    ...(firstColumn ? { columnId: firstColumn.id } : {}),
  };
  const created = applyRecurringSeriesCutoff(review, cutoffs);
  if (!created) return unchanged();
  return { tasks: [...bounded, created], created, scheduledEntryId: selection.entry.id };
}

export type FastingReminderSettings = Pick<
  Settings,
  | "fastingRemindersEnabled"
  | "fastingRemindersMode"
  | "fastingRemindersWeekday"
  | "fastingRemindersPerMonth"
  | "fastingRemindersRandomSeed"
  | "weekStart"
  | "newTaskPosition"
>;

export type FastingRemindersPlan = {
  tasks: Task[];
  /** New reminders and open ones moved to the reminder board. */
  publish: Task[];
  /** Open future reminders no longer wanted; deleted on every device, as native does. */
  publishDeleted: Task[];
};

/**
 * Reconciles open fasting reminders for this month and next with the settings: removes ones no
 * longer wanted, moves the rest to the reminder board, and creates missing ones. Turning
 * reminders off removes every open one. Matches native `reconcileFastingReminders`.
 */
export function planFastingReminders(
  tasks: Task[],
  input: { targetBoard: Board | undefined; now: Date; settings: FastingReminderSettings },
): FastingRemindersPlan | null {
  const { targetBoard, now, settings } = input;
  const isOpenReminder = (task: Task) => task.seriesId === FASTING_REMINDER_SERIES_ID && !task.completed;

  if (!settings.fastingRemindersEnabled) {
    const removed = tasks.filter(isOpenReminder);
    return removed.length ? { tasks: tasks.filter((task) => !isOpenReminder(task)), publish: [], publishDeleted: removed } : null;
  }
  if (!targetBoard) return null;

  const months = [0, 1].map((offset) => {
    const anchor = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { year: anchor.getFullYear(), monthIndex: anchor.getMonth() };
  });
  const windowMonthKeys = new Set(months.map((m) => monthKeyFromYearMonth(m.year, m.monthIndex)));
  const desired = new Set<number>();
  for (const m of months) {
    fastingReminderDueTimesForMonth(m.year, m.monthIndex, {
      mode: settings.fastingRemindersMode,
      weekday: settings.fastingRemindersWeekday,
      perMonth: settings.fastingRemindersPerMonth,
      seed: settings.fastingRemindersRandomSeed,
    }).forEach((time) => desired.add(time));
  }

  const todayMidnight = startOfDay(now).getTime();
  const firstColumn = targetBoard.kind === "lists" ? targetBoard.columns?.[0] : undefined;
  const next: Task[] = [];
  const publish: Task[] = [];
  const publishDeleted: Task[] = [];
  const satisfied = new Set<number>();

  for (const task of tasks) {
    if (!isOpenReminder(task)) {
      next.push(task);
      continue;
    }
    const dueDate = new Date(task.dueISO);
    const dueTime = startOfDay(dueDate).getTime();
    if (!Number.isFinite(dueTime)) {
      next.push(task);
      continue;
    }
    const inWindow = windowMonthKeys.has(monthKeyFromYearMonth(dueDate.getFullYear(), dueDate.getMonth()));
    const isFuture = dueTime >= todayMidnight;
    const isDesired = desired.has(dueTime);
    if (inWindow && isFuture && !isDesired) {
      publishDeleted.push(task);
      continue;
    }
    if (isFuture && isDesired) satisfied.add(dueTime);
    let updated = task;
    if (updated.boardId !== targetBoard.id) updated = { ...updated, boardId: targetBoard.id };
    if (targetBoard.kind === "week" && updated.column !== "day") updated = { ...updated, column: "day" };
    if (firstColumn && updated.columnId !== firstColumn.id) updated = { ...updated, columnId: firstColumn.id };
    if (updated !== task) publish.push(updated);
    next.push(updated);
  }

  const existingIds = new Set(tasks.map((task) => task.id));
  const toCreate = [...desired].filter((time) => time >= todayMidnight && !satisfied.has(time)).sort((a, b) => a - b);
  for (const dueTime of toCreate) {
    // Date-derived, like native: devices generating the same reminder make one task.
    const id = fastingReminderTaskId(FASTING_REMINDER_SERIES_ID, dueTime);
    if (existingIds.has(id)) continue;
    if (targetBoard.kind === "lists" && !firstColumn) continue;
    const reminder: Task = {
      id,
      boardId: targetBoard.id,
      title: "Fasting",
      note: "Fasting reminder",
      createdAt: now.getTime(),
      dueISO: new Date(dueTime).toISOString(),
      completed: false,
      order: nextOrderForBoard(targetBoard.id, next, settings.newTaskPosition),
      seriesId: FASTING_REMINDER_SERIES_ID,
      ...(targetBoard.kind === "week" ? { column: "day" as const } : {}),
      ...(firstColumn ? { columnId: firstColumn.id } : {}),
    };
    applyHiddenForFuture(reminder, settings.weekStart, targetBoard.kind);
    next.push(reminder);
    publish.push(reminder);
  }

  return publish.length || publishDeleted.length ? { tasks: next, publish, publishDeleted } : null;
}
