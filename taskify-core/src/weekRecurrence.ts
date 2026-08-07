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

function stableRecurrenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableRecurrenceValue);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableRecurrenceValue(entry)]),
  );
}

function recurrenceSeriesFingerprint(rule: RecurrenceLike | undefined): string {
  if (!rule) return "";
  const seriesRule = { ...rule };
  delete seriesRule.untilISO;
  return JSON.stringify(stableRecurrenceValue(seriesRule));
}

/**
 * Return the stable root id for a recurring series.
 *
 * Older generated tasks can be missing `seriesId`, but their deterministic id
 * still contains the root as `recurrence:<root>:<date-or-datetime>`. Parse the
 * suffix from the right so roots containing colons continue to work.
 */
export function recurringSeriesId(task: Pick<SeriesTaskLike, "id" | "seriesId">): string {
  const recoverRoot = (value: string): string => {
    let current = value.trim();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const generated = /^recurrence:(.+):(\d{4}-\d{2}-\d{2}(?:T.*)?)$/.exec(current);
      const parent = generated?.[1]?.trim() ?? "";
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const explicit = typeof task.seriesId === "string" ? recoverRoot(task.seriesId) : "";
  if (explicit) return explicit;
  return typeof task.id === "string" ? recoverRoot(task.id) : "";
}

export function tasksInSameSeries<TTask extends SeriesTaskLike>(a: TTask, b: TTask): boolean {
  if (a.boardId !== b.boardId) return false;
  const aSeriesId = recurringSeriesId(a);
  const bSeriesId = recurringSeriesId(b);
  if (aSeriesId && aSeriesId === bSeriesId) return true;
  return (
    a.title === b.title &&
    (a.note || "") === (b.note || "") &&
    !!a.recurrence &&
    !!b.recurrence &&
    recurrenceSeriesFingerprint(a.recurrence) === recurrenceSeriesFingerprint(b.recurrence)
  );
}

type EnsureWeekRecurrencesOptions<TTask extends SeriesTaskLike> = {
  tasks: TTask[];
  sources?: TTask[];
  weekStart: number;
  newTaskPosition: "top" | "bottom";
  dedupeRecurringInstances: (tasks: TTask[]) => TTask[];
  isFrequentRecurrence: (rule: TTask["recurrence"]) => boolean;
  nextOccurrence: (
    dueISO: string,
    rule: NonNullable<TTask["recurrence"]>,
    dueTimeEnabled: boolean,
    dueTimeZone?: string,
  ) => string | null | undefined;
  startOfWeek: (date: Date, weekStart: number) => Date;
  recurringInstanceId: (
    seriesId: string,
    dueISO: string,
    rule?: TTask["recurrence"],
    dueTimeZone?: string,
  ) => string;
  isoDatePart: (iso: string, timeZone?: string) => string;
  taskDateKey: (task: TTask) => string;
  nextOrderForBoard: (boardId: string, tasks: TTask[], position: "top" | "bottom") => number;
  maybePublishTask: (task: TTask) => Promise<unknown> | void;
  now?: () => number;
};

export function ensureWeekRecurrencesForCurrentWeek<TTask extends SeriesTaskLike>(
  options: EnsureWeekRecurrencesOptions<TTask>,
): TTask[] {
  const {
    tasks,
    sources,
    weekStart,
    newTaskPosition,
    dedupeRecurringInstances,
    isFrequentRecurrence,
    nextOccurrence,
    startOfWeek,
    recurringInstanceId,
    isoDatePart,
    taskDateKey,
    nextOrderForBoard,
    maybePublishTask,
    now = () => Date.now(),
  } = options;

  const sow = startOfWeek(new Date(), weekStart).getTime();
  const out = dedupeRecurringInstances(tasks);
  let changed = out !== tasks;
  const src = sources ?? out;

  for (const task of src) {
    if (!task.recurrence || !isFrequentRecurrence(task.recurrence)) continue;

    const seriesId = recurringSeriesId(task);
    if (!task.seriesId) {
      const index = out.findIndex((candidate) => candidate.id === task.id);
      if (index >= 0 && out[index].seriesId !== seriesId) {
        out[index] = { ...out[index], seriesId };
        changed = true;
      }
    }

    const seriesSeed = task.seriesId ? task : ({ ...task, seriesId } as TTask);
    let nextISO = nextOccurrence(task.dueISO, task.recurrence, !!task.dueTimeEnabled, task.dueTimeZone);
    let previousOccurrenceMs = Date.parse(task.dueISO);
    let generatedOccurrences = 0;

    while (nextISO) {
      const nextDate = new Date(nextISO);
      const nextOccurrenceMs = nextDate.getTime();
      generatedOccurrences += 1;
      if (
        generatedOccurrences > 10_000 ||
        Number.isNaN(nextOccurrenceMs) ||
        (!Number.isNaN(previousOccurrenceMs) && nextOccurrenceMs <= previousOccurrenceMs)
      ) {
        break;
      }
      const nextStartOfWeek = startOfWeek(nextDate, weekStart).getTime();
      if (nextStartOfWeek > sow) break;

      if (nextStartOfWeek === sow) {
        const cloneId = recurringInstanceId(seriesId, nextISO, task.recurrence, task.dueTimeZone);
        const nextDateKey = isoDatePart(nextISO, task.dueTimeZone);
        const exists = out.some(
          (candidate) =>
            candidate.id === cloneId ||
            (tasksInSameSeries(candidate, seriesSeed) && taskDateKey(candidate) === nextDateKey),
        );

        if (!exists) {
          const clone = {
            ...task,
            id: cloneId,
            seriesId,
            createdAt: now(),
            completed: false,
            completedAt: undefined,
            completedBy: undefined,
            dueISO: nextISO,
            hiddenUntilISO: undefined,
            order: nextOrderForBoard(task.boardId, out, newTaskPosition),
            subtasks: task.subtasks?.map((subtask) => ({ ...subtask, completed: false })),
            dueTimeEnabled: typeof task.dueTimeEnabled === "boolean" ? task.dueTimeEnabled : undefined,
            reminders: Array.isArray(task.reminders) ? [...task.reminders] : undefined,
          } as TTask;

          const publishTaskResult = maybePublishTask(clone);
          if (publishTaskResult && typeof (publishTaskResult as Promise<unknown>).catch === "function") {
            (publishTaskResult as Promise<unknown>).catch(() => {});
          }

          out.push(clone);
          changed = true;
        }
      }

      previousOccurrenceMs = nextOccurrenceMs;
      nextISO = nextOccurrence(nextISO, task.recurrence, !!task.dueTimeEnabled, task.dueTimeZone);
    }
  }

  return changed ? out : tasks;
}
