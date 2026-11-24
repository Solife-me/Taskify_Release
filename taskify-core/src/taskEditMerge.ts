/**
 * What a task editor's save writes (C8-2). The editor records the task as it built it when it
 * opened; on save, a field the user changed takes the edited value, and a field the user left
 * alone takes the task's current value, which may have changed meanwhile on another device.
 * Fields that only make sense together move as one group, and subtasks merge item by item.
 * Swift has the same rule in `TaskEditorFields`.
 */
import type { Subtask, Task } from "./taskContracts.js";

/** Fields saved together: a date with another device's time zone is a time nobody chose. */
const FIELD_GROUPS: ReadonlyArray<ReadonlyArray<keyof Task>> = [
  ["dueISO", "dueDateEnabled", "dueTimeEnabled", "dueTimeZone", "recurrence", "hiddenUntilISO"],
  ["reminders", "reminderTime"],
  ["images", "documents"],
  ["boardId", "columnId", "column"],
];

/** Device-local bookkeeping, never taken from the editor. */
const LOCAL_FIELDS = new Set<string>(["order", "_nostrAt", "_nostrId"]);

function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** Merge subtask edits by ID, retaining current order when the editor leaves the order alone. */
export function mergeSubtaskEdit(
  opened: readonly Subtask[] | undefined,
  edited: readonly Subtask[] | undefined,
  current: readonly Subtask[] | undefined,
): Subtask[] {
  const openedById = new Map((opened ?? []).map((subtask) => [subtask.id, subtask]));
  const currentById = new Map((current ?? []).map((subtask) => [subtask.id, subtask]));
  const editedIds = (edited ?? []).map((subtask) => subtask.id);
  const editedIdSet = new Set(editedIds);
  const openedIdsStillPresent = (opened ?? []).filter(({ id }) => editedIdSet.has(id)).map(({ id }) => id);
  const merged: Subtask[] = [];
  for (const subtask of edited ?? []) {
    const before = openedById.get(subtask.id);
    if (!before || !same(subtask, before)) {
      merged.push(subtask);
      continue;
    }
    const now = currentById.get(subtask.id);
    if (now) merged.push(now);
  }
  for (const subtask of current ?? []) {
    if (!openedById.has(subtask.id) && !editedIdSet.has(subtask.id)) merged.push(subtask);
  }
  if (editedIds.length === openedIdsStillPresent.length && editedIds.every((id, index) => id === openedIdsStillPresent[index])) {
    const currentOrder = new Map((current ?? []).map(({ id }, index) => [id, index]));
    const order = ({ id }: Subtask) => currentOrder.get(id) ?? currentOrder.size;
    merged.sort((a, b) => order(a) - order(b));
  }
  return merged;
}

/** The task to save: `edited` where the user changed something since `opened`, `current` elsewhere. */
export function mergeTaskEdit<T extends Task>(opened: T, edited: T, current: T): T {
  const result: Record<string, unknown> = { ...current };
  const take = (keys: ReadonlyArray<string>, from: Record<string, unknown>) => {
    for (const key of keys) {
      if (from[key] === undefined) delete result[key];
      else result[key] = from[key];
    }
  };
  const o = opened as Record<string, unknown>;
  const e = edited as Record<string, unknown>;
  const grouped = new Set<string>(["subtasks", ...LOCAL_FIELDS]);
  for (const group of FIELD_GROUPS) {
    group.forEach((key) => grouped.add(key));
    if (group.some((key) => !same(e[key], o[key]))) take(group, e);
  }
  for (const key of new Set([...Object.keys(o), ...Object.keys(e)])) {
    if (grouped.has(key) || same(e[key], o[key])) continue;
    take([key], e);
  }
  const subtasks = mergeSubtaskEdit(opened.subtasks, edited.subtasks, current.subtasks);
  if (subtasks.length) result.subtasks = subtasks;
  else delete result.subtasks;
  return result as T;
}
