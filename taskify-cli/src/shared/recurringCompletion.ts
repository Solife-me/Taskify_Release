import {
  buildNextRecurringTask,
  normalizeTaskRecurrence,
  type Recurrence,
  type ReminderPreset,
  type Subtask,
  type Weekday,
} from "taskify-core";

export type NextRecurringTaskPayload = {
  /** The occurrence id every client derives, so concurrent completions converge on one task. */
  taskId: string;
  dueISO: string;
  /** The wire payload to publish with status "open". */
  payload: Record<string, unknown>;
};

/**
 * The next occurrence to publish when a recurring task's wire payload is marked done, matching
 * what the PWA and iOS create on completion. The CLI has no week-start setting, so non-daily
 * series reappear from Sunday's start of week unless `weekStart` is given.
 */
export function nextRecurringTaskPayload(
  taskId: string,
  payload: Record<string, unknown>,
  options: { weekStart?: Weekday; now?: number } = {},
): NextRecurringTaskPayload | null {
  // The normalizer validates every field the rule's type needs; its return type is just looser.
  const recurrence = normalizeTaskRecurrence(payload.recurrence) as Recurrence | undefined;
  if (!recurrence || recurrence.type === "none") return null;
  const next = buildNextRecurringTask(
    {
      ...payload,
      id: taskId,
      dueISO: typeof payload.dueISO === "string" ? payload.dueISO : "",
      recurrence,
      seriesId: typeof payload.seriesId === "string" ? payload.seriesId : undefined,
      dueTimeEnabled: payload.dueTimeEnabled === true,
      dueTimeZone: typeof payload.dueTimeZone === "string" ? payload.dueTimeZone : undefined,
      subtasks: Array.isArray(payload.subtasks) ? (payload.subtasks as Subtask[]) : undefined,
      reminders: Array.isArray(payload.reminders) ? (payload.reminders as ReminderPreset[]) : undefined,
    },
    { weekStart: options.weekStart ?? 0, now: options.now },
  );
  if (!next) return null;
  const { id, completed: _completed, ...fields } = next as typeof next & { completed?: boolean };
  return {
    taskId: id,
    dueISO: next.dueISO,
    payload: {
      ...fields,
      dueTimeEnabled: payload.dueTimeEnabled ?? null,
      completedAt: null,
      completedBy: null,
      subtasks: fields.subtasks ?? null,
      reminders: fields.reminders ?? null,
    },
  };
}
