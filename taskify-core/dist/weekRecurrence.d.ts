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
};
export declare function ensureWeekRecurrencesForCurrentWeek<TTask extends SeriesTaskLike>(options: EnsureWeekRecurrencesOptions<TTask>): TTask[];
export {};
