/**
 * How tasks are ordered on boards, in Upcoming and in the bounty list. Pure comparators: each
 * takes the sort direction and returns the usual negative/zero/positive.
 */
import { isoDatePart } from "taskify-core";
import type { Task } from "./taskTypes";
import {
  DEFAULT_BOARD_SORT_DIRECTION,
  normalizeTaskPriority,
  type BoardSortDirection,
  type BoardSortMode,
} from "./taskUtils";

export type TaskSort = { mode: BoardSortMode; direction: BoardSortDirection };

/** Title order as people read it: case-insensitive, with "Task 2" before "Task 10". */
export const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNumber(a: number, b: number, direction: BoardSortDirection): number {
  const diff = a - b;
  return direction === "asc" ? diff : -diff;
}

function dueDateKey(task: Task): string | null {
  if (task.dueDateEnabled === false) return null;
  return isoDatePart(task.dueISO, task.dueTimeZone);
}

function dueTimestamp(task: Task): number | null {
  if (task.dueDateEnabled === false) return null;
  const ts = Date.parse(task.dueISO);
  return Number.isNaN(ts) ? null : ts;
}

/** By due day; within a day, timed tasks first and in time order. Undated tasks go last. */
export function compareDue(a: Task, b: Task, direction: BoardSortDirection): number {
  const aDate = dueDateKey(a);
  const bDate = dueDateKey(b);
  if (aDate == null && bDate == null) return 0;
  if (aDate == null) return 1;
  if (bDate == null) return -1;
  if (aDate !== bDate) {
    const result = aDate.localeCompare(bDate);
    return direction === "asc" ? result : -result;
  }
  const aHasTime = !!a.dueTimeEnabled;
  const bHasTime = !!b.dueTimeEnabled;
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
  if (aHasTime && bHasTime) {
    const aDue = dueTimestamp(a);
    const bDue = dueTimestamp(b);
    if (aDue == null && bDue == null) return 0;
    if (aDue == null) return 1;
    if (bDue == null) return -1;
    return compareNumber(aDue, bDue, direction);
  }
  return 0;
}

export function comparePriority(a: Task, b: Task, direction: BoardSortDirection): number {
  return compareNumber(normalizeTaskPriority(a.priority) ?? 0, normalizeTaskPriority(b.priority) ?? 0, direction);
}

export function taskCreatedAt(task: Task): number {
  return typeof task.createdAt === "number" ? task.createdAt : 0;
}

export function compareCreatedAt(a: Task, b: Task, direction: BoardSortDirection): number {
  return compareNumber(taskCreatedAt(a), taskCreatedAt(b), direction);
}

export function compareAlpha(a: Task, b: Task, direction: BoardSortDirection): number {
  const result = titleCollator.compare(a.title?.trim() || "", b.title?.trim() || "");
  return direction === "asc" ? result : -result;
}

/** The tie-breaking order every sort falls back to: due, priority, newest, title, manual order, id. */
export function compareDefault(a: Task, b: Task): number {
  let result = compareDue(a, b, DEFAULT_BOARD_SORT_DIRECTION.due);
  if (result !== 0) return result;
  result = comparePriority(a, b, DEFAULT_BOARD_SORT_DIRECTION.priority);
  if (result !== 0) return result;
  result = compareCreatedAt(a, b, DEFAULT_BOARD_SORT_DIRECTION.created);
  if (result !== 0) return result;
  result = compareAlpha(a, b, DEFAULT_BOARD_SORT_DIRECTION.alpha);
  if (result !== 0) return result;
  const orderDiff = (a.order ?? 0) - (b.order ?? 0);
  if (orderDiff !== 0) return orderDiff;
  return a.id.localeCompare(b.id);
}

/** The primary comparison for a sort mode other than manual (0 for manual). */
export function compareBySortMode(a: Task, b: Task, sort: TaskSort, compareTime = compareDue): number {
  switch (sort.mode) {
    case "due":
      return compareTime(a, b, sort.direction);
    case "priority":
      return comparePriority(a, b, sort.direction);
    case "created":
      return compareCreatedAt(a, b, sort.direction);
    case "alpha":
      return compareAlpha(a, b, sort.direction);
    default:
      return 0;
  }
}

/** Sorts a board's tasks in place: open tasks first, then by the board's sort. */
export function sortBoardTasks(tasks: Task[], sort: TaskSort): Task[] {
  return tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (sort.mode === "manual") {
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return compareDefault(a, b);
    }
    return compareBySortMode(a, b, sort) || compareDefault(a, b);
  });
}
