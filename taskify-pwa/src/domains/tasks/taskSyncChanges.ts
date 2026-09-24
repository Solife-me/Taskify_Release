import type { Task } from "./taskTypes";

// Fields that never reach other devices: `order` is not part of the published task payload
// (each device orders its own lists), `lastEditedBy` only describes a publish, and `_nostrAt` /
// `updatedAt` are local bookkeeping. A change confined to these needs no publish.
const LOCAL_ONLY_TASK_FIELDS = new Set(["order", "lastEditedBy", "_nostrAt", "updatedAt"]);

function syncedFields(task: Task): string {
  const entries = Object.entries(task as Record<string, unknown>)
    .filter(([key, value]) => !LOCAL_ONLY_TASK_FIELDS.has(key) && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Whether `after` differs from `before` in anything other devices would see. */
export function hasSyncedTaskChange(before: Task, after: Task): boolean {
  return syncedFields(before) !== syncedFields(after);
}
