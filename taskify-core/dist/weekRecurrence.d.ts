export type RecurrenceLike = {
    type?: string;
} & Record<string, unknown>;
export type SeriesTaskLike = {
    id: string;
    boardId: string;
    title: string;
    note?: string;
    dueISO: string;
    dueTimeEnabled?: boolean;
    dueTimeZone?: string;
    recurrence?: RecurrenceLike;
    seriesId?: string;
    createdAt?: number;
    completed?: boolean;
    completedAt?: string;
    completedBy?: string;
    hiddenUntilISO?: string;
    order?: number;
    subtasks?: Array<Record<string, unknown>>;
    reminders?: unknown[];
};
/**
 * Return the stable root id for a recurring series.
 *
 * Older generated tasks can be missing `seriesId`, but their deterministic id
 * still contains the root as `recurrence:<root>:<date-or-datetime>`. Parse the
 * suffix from the right so roots containing colons continue to work.
 */
export declare function recurringSeriesId(task: Pick<SeriesTaskLike, "id" | "seriesId">): string;
export declare function tasksInSameSeries<TTask extends SeriesTaskLike>(a: TTask, b: TTask): boolean;
type EnsureWeekRecurrencesOptions<TTask extends SeriesTaskLike> = {
    tasks: TTask[];
    sources?: TTask[];
    weekStart: number;
    newTaskPosition: "top" | "bottom";
    dedupeRecurringInstances: (tasks: TTask[]) => TTask[];
    isFrequentRecurrence: (rule: TTask["recurrence"]) => boolean;
    nextOccurrence: (dueISO: string, rule: NonNullable<TTask["recurrence"]>, dueTimeEnabled: boolean, dueTimeZone?: string) => string | null | undefined;
    startOfWeek: (date: Date, weekStart: number) => Date;
    recurringInstanceId: (seriesId: string, dueISO: string, rule?: TTask["recurrence"], dueTimeZone?: string) => string;
    isoDatePart: (iso: string, timeZone?: string) => string;
    taskDateKey: (task: TTask) => string;
    nextOrderForBoard: (boardId: string, tasks: TTask[], position: "top" | "bottom") => number;
    maybePublishTask: (task: TTask) => Promise<unknown> | void;
    now?: () => number;
    /**
     * False while a shared board's initial relay sync is still running. Instances are only
     * generated for boards that have synced: generating earlier would republish an instance another
     * device already completed (same id, newer timestamp) and reopen it.
     */
    canGenerateForBoard?: (boardId: string) => boolean;
    /**
     * Whether an occurrence id was deleted on this board. Clients that drop deleted tasks from their
     * list (the PWA) must say so, or the occurrence is recreated, and republished open.
     */
    isDeletedOccurrence?: (boardId: string, taskId: string) => boolean;
};
export declare function ensureWeekRecurrencesForCurrentWeek<TTask extends SeriesTaskLike>(options: EnsureWeekRecurrencesOptions<TTask>): TTask[];
type StreakTaskLike = {
    id: string;
    seriesId?: string;
    dueISO: string;
    completed?: boolean;
    streak?: number;
};
/**
 * Streaks are carried from one instance of a recurring series to the next. An open instance's
 * running streak is the streak of the latest completed instance due before it (or its own,
 * whichever is higher), so instances generated ahead of time (full-week mode) don't need to be
 * rewritten, and republished, every time an earlier one is completed. Completing an instance
 * sets its streak to its running streak + 1.
 */
export declare function buildRunningStreakLookup<TTask extends StreakTaskLike>(tasks: readonly TTask[]): (task: TTask) => number;
export {};
