function stableRecurrenceValue(value) {
    if (Array.isArray(value)) {
        return value.map(stableRecurrenceValue);
    }
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableRecurrenceValue(entry)]));
}
function recurrenceSeriesFingerprint(rule) {
    if (!rule)
        return "";
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
export function recurringSeriesId(task) {
    const recoverRoot = (value) => {
        let current = value.trim();
        const seen = new Set();
        while (current && !seen.has(current)) {
            seen.add(current);
            const generated = /^recurrence:(.+):(\d{4}-\d{2}-\d{2}(?:T.*)?)$/.exec(current);
            const parent = generated?.[1]?.trim() ?? "";
            if (!parent)
                break;
            current = parent;
        }
        return current;
    };
    const explicit = typeof task.seriesId === "string" ? recoverRoot(task.seriesId) : "";
    if (explicit)
        return explicit;
    return typeof task.id === "string" ? recoverRoot(task.id) : "";
}
export function tasksInSameSeries(a, b) {
    if (a.boardId !== b.boardId)
        return false;
    const aSeriesId = recurringSeriesId(a);
    const bSeriesId = recurringSeriesId(b);
    if (aSeriesId && aSeriesId === bSeriesId)
        return true;
    return (a.title === b.title &&
        (a.note || "") === (b.note || "") &&
        !!a.recurrence &&
        !!b.recurrence &&
        recurrenceSeriesFingerprint(a.recurrence) === recurrenceSeriesFingerprint(b.recurrence));
}
export function ensureWeekRecurrencesForCurrentWeek(options) {
    const { tasks, sources, weekStart, newTaskPosition, dedupeRecurringInstances, isFrequentRecurrence, nextOccurrence, startOfWeek, recurringInstanceId, isoDatePart, taskDateKey, nextOrderForBoard, maybePublishTask, now = () => Date.now(), } = options;
    const sow = startOfWeek(new Date(), weekStart).getTime();
    const out = dedupeRecurringInstances(tasks);
    let changed = out !== tasks;
    const src = sources ?? out;
    for (const task of src) {
        if (!task.recurrence || !isFrequentRecurrence(task.recurrence))
            continue;
        const seriesId = recurringSeriesId(task);
        if (!task.seriesId) {
            const index = out.findIndex((candidate) => candidate.id === task.id);
            if (index >= 0 && out[index].seriesId !== seriesId) {
                out[index] = { ...out[index], seriesId };
                changed = true;
            }
        }
        const seriesSeed = task.seriesId ? task : { ...task, seriesId };
        let nextISO = nextOccurrence(task.dueISO, task.recurrence, !!task.dueTimeEnabled, task.dueTimeZone);
        while (nextISO) {
            const nextDate = new Date(nextISO);
            const nextStartOfWeek = startOfWeek(nextDate, weekStart).getTime();
            if (nextStartOfWeek > sow)
                break;
            if (nextStartOfWeek === sow) {
                const cloneId = recurringInstanceId(seriesId, nextISO, task.recurrence, task.dueTimeZone);
                const nextDateKey = isoDatePart(nextISO, task.dueTimeZone);
                const exists = out.some((candidate) => candidate.id === cloneId ||
                    (tasksInSameSeries(candidate, seriesSeed) && taskDateKey(candidate) === nextDateKey));
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
                    };
                    const publishTaskResult = maybePublishTask(clone);
                    if (publishTaskResult && typeof publishTaskResult.catch === "function") {
                        publishTaskResult.catch(() => { });
                    }
                    out.push(clone);
                    changed = true;
                }
            }
            nextISO = nextOccurrence(nextISO, task.recurrence, !!task.dueTimeEnabled, task.dueTimeZone);
        }
    }
    return changed ? out : tasks;
}
