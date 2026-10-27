import type { ReminderPreset } from "./reminderUtils.js";
import type { Recurrence, Subtask } from "./taskContracts.js";
import { type Weekday } from "./weekDate.js";
/**
 * The due instant of the occurrence after `currentISO`, or null when the rule has ended.
 * With a valid `timeZone`, days are counted in that zone, so a series keeps its wall-clock day
 * across DST changes and travel. Matches native `TaskRecurrence.nextOccurrence`.
 */
export declare function nextOccurrence(currentISO: string, rule: Recurrence, keepTime?: boolean, timeZone?: string): string | null;
/** Daily, weekly and every-N-days/weeks series: one instance is shown at a time, on its due day. */
export declare function isFrequentRecurrence(rule?: Recurrence | null): boolean;
export declare function revealsOnDueDate(rule: Recurrence): boolean;
/** When the next instance re-appears: its due day for frequent series, else the start of its week. */
export declare function hiddenUntilForNext(nextISO: string, rule: Recurrence, weekStart: Weekday): string | undefined;
/**
 * The id every client gives an occurrence, so two devices completing the same instance converge
 * on one next task: `recurrence:<series>:<date>`, plus `T<HH:mm>` (UTC) for hourly series.
 * Matches native `TaskifySnapshot.recurringInstanceID`.
 */
export declare function recurringInstanceId(seriesId: string, dueISO: string, rule?: Recurrence, timeZone?: string): string;
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
export declare function buildNextRecurringTask<T extends RecurringTaskLike>(task: T, options: NextRecurringTaskOptions): T | null;
