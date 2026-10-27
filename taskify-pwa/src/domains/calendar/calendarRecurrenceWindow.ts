/**
 * The rolling window of a recurring Taskify event: each device generates the next occurrences
 * from the series' seed, locally (`generated: true`, never published). Every client derives the
 * same ids from the seed, so a series is one published record plus any edited or deleted
 * occurrences (exceptions). Matches native `TaskifyEvent` generation.
 */
import { ISO_DATE_PATTERN, addDaysToDateKey, nextOccurrence, recurringInstanceId } from "taskify-core";
import { isoDatePart, normalizeTimeZone, parseDateKey } from "../dateTime/dateUtils";
import { applyHiddenForCalendarEvent, nextOrderForCalendarBoard } from "../tasks/boardUtils";
import type { Settings } from "../tasks/settingsTypes";
import type { Board, CalendarEvent, CalendarEventBase, Recurrence } from "../tasks/taskTypes";
import { calendarEventEndMs, calendarEventStartISOForRecurrence } from "./calendarUtils";

const MS_PER_DAY = 86_400_000;

/** Occurrence ids replace `:` with `_`, which event addresses use as a separator. */
export function calendarRecurrenceInstanceId(seriesId: string, startISO: string, rule: Recurrence, timeZone?: string): string {
  return recurringInstanceId(seriesId, startISO, rule, timeZone).replace(/:/g, "_");
}

/** How many future occurrences each kind of series keeps generated. */
export function calendarRecurrenceLimit(rule: Recurrence): number {
  switch (rule.type) {
    case "weekly":
      return 52;
    case "monthlyDay":
      return Math.max(1, rule.interval ?? 1) >= 12 ? 5 : 18;
    case "every":
      return rule.unit === "week" ? 52 : 24;
    case "daily":
      return 24;
    default:
      return 0;
  }
}

export type CalendarWindowInput = {
  boards: Board[];
  now: Date;
  settings: Pick<Settings, "weekStart" | "newTaskPosition">;
  /** Occurrences deleted on their own; never regenerated. */
  deletedOccurrenceIds: ReadonlySet<string>;
  /** False until a shared board's deletions have synced, or a deleted occurrence would return. */
  canGenerateForBoard: (boardId: string) => boolean;
};

/**
 * Brings every series' generated occurrences in line with its seed: drops orphans and occurrences
 * the seed no longer schedules, refreshes the rest, trims generated ones beyond the window and
 * generates up to the window. Edited or published occurrences are the user's and are never
 * trimmed. Returns null when nothing changes. Nothing here needs publishing.
 */
export function planCalendarRecurrenceWindow(events: CalendarEvent[], input: CalendarWindowInput): CalendarEvent[] | null {
  const { boards, settings } = input;
  const nowMs = input.now.getTime();
  let changed = false;
  const next = events.slice();
  const existingIds = new Set(next.map((event) => event.id));
  const seriesMap = new Map<string, { seed: CalendarEvent; events: CalendarEvent[] }>();

  for (let i = 0; i < next.length; i++) {
    let ev = next[i];
    if (!ev.recurrence || ev.recurrence.type === "none") continue;
    const seriesId = ev.seriesId || ev.id;
    if (!ev.seriesId) {
      ev = { ...ev, seriesId };
      next[i] = ev;
      changed = true;
    }
    const group = seriesMap.get(seriesId) ?? { seed: ev, events: [] };
    group.events.push(ev);
    if (ev.id === seriesId) group.seed = ev;
    seriesMap.set(seriesId, group);
  }

  const remove = (id: string) => {
    const index = next.findIndex((event) => event.id === id);
    if (index < 0) return;
    next.splice(index, 1);
    existingIds.delete(id);
    changed = true;
  };

  for (const [seriesId, group] of seriesMap) {
    const seed = group.seed;
    // Generated occurrences whose seed is gone have nothing to generate them; they were never
    // published, so they are simply dropped.
    if (seed.id !== seriesId || seed.generated) {
      group.events.filter((event) => event.generated).forEach((event) => remove(event.id));
      continue;
    }
    const rule = seed.recurrence;
    if (!rule || rule.type === "none" || seed.readOnly) continue;
    if (!input.canGenerateForBoard(seed.boardId)) continue;
    const limit = calendarRecurrenceLimit(rule);
    if (limit <= 0) continue;

    const boardKind = boards.find((b) => b.id === seed.boardId)?.kind ?? "week";
    const timeZone = seed.kind === "time" ? normalizeTimeZone(seed.startTzid) ?? undefined : "UTC";
    const baseStartISO = calendarEventStartISOForRecurrence(seed);
    if (!baseStartISO) continue;
    const durationMs = seed.kind === "time" && seed.endISO
      ? Math.max(0, (Date.parse(seed.endISO) - Date.parse(seed.startISO)) || 0)
      : 0;
    const durationDays = (() => {
      if (seed.kind !== "date") return 1;
      const endDate = seed.endDate && ISO_DATE_PATTERN.test(seed.endDate) ? seed.endDate : seed.startDate;
      const start = parseDateKey(seed.startDate);
      const end = parseDateKey(endDate);
      if (!start || !end) return 1;
      const startUtc = Date.UTC(start.year, start.month - 1, start.day);
      const endUtc = Date.UTC(end.year, end.month - 1, end.day);
      if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc < startUtc) return 1;
      return Math.round((endUtc - startUtc) / MS_PER_DAY) + 1;
    })();

    const buildOccurrence = (id: string, occurrenceISO: string, order: number | undefined): CalendarEvent => {
      const base: CalendarEventBase = { ...seed, id, order, seriesId, recurrence: rule, generated: true };
      const instance: CalendarEvent = seed.kind === "time"
        ? {
            ...base,
            kind: "time",
            startISO: occurrenceISO,
            ...(durationMs ? { endISO: new Date(Date.parse(occurrenceISO) + durationMs).toISOString() } : {}),
            ...(normalizeTimeZone(seed.startTzid) ? { startTzid: seed.startTzid } : {}),
            ...(normalizeTimeZone(seed.endTzid) ? { endTzid: seed.endTzid } : {}),
          }
        : (() => {
            const startDate = isoDatePart(occurrenceISO, "UTC");
            const endDate = durationDays > 1 ? addDaysToDateKey(startDate, durationDays - 1) : null;
            return { ...base, kind: "date", startDate, ...(endDate ? { endDate } : {}) } as CalendarEvent;
          })();
      return applyHiddenForCalendarEvent(instance, settings.weekStart, boardKind);
    };

    // Bring generated occurrences in line with the seed, which may have been edited on another
    // device, and drop any the seed no longer schedules.
    const generatedInSeries = next.filter((event) => event.generated && (event.seriesId || event.id) === seriesId);
    if (generatedInSeries.length) {
      const lastMs = Math.max(...generatedInSeries.map((event) => {
        const iso = calendarEventStartISOForRecurrence(event);
        return iso ? Date.parse(iso) : 0;
      }));
      const scheduled = new Map<string, string>();
      let cursor = baseStartISO;
      for (let step = 0; step < 10_000; step += 1) {
        const occurrenceISO = nextOccurrence(cursor, rule, seed.kind === "time", timeZone);
        if (!occurrenceISO) break;
        cursor = occurrenceISO;
        scheduled.set(calendarRecurrenceInstanceId(seriesId, occurrenceISO, rule, timeZone), occurrenceISO);
        if (Date.parse(occurrenceISO) >= lastMs) break;
      }
      for (const event of generatedInSeries) {
        const index = next.findIndex((candidate) => candidate.id === event.id);
        if (index < 0) continue;
        const occurrenceISO = scheduled.get(event.id);
        if (!occurrenceISO) {
          remove(event.id);
          continue;
        }
        const refreshed = buildOccurrence(event.id, occurrenceISO, event.order);
        if (JSON.stringify(refreshed) !== JSON.stringify(event)) {
          next[index] = refreshed;
          changed = true;
        }
      }
    }

    const live = next
      .filter((event) => (event.seriesId || event.id) === seriesId && !!event.recurrence && event.recurrence.type !== "none")
      .map((event) => {
        const startISO = calendarEventStartISOForRecurrence(event);
        return { event, startISO, startMs: startISO ? Date.parse(startISO) : NaN, endMs: calendarEventEndMs(event) };
      })
      .filter((item) => item.startISO && Number.isFinite(item.startMs) && item.endMs !== null);
    if (!live.length) continue;

    const future = live.filter((item) => (item.endMs ?? 0) >= nowMs).sort((a, b) => a.startMs - b.startMs);
    let futureCount = future.length;
    if (futureCount > limit) {
      // Only occurrences this device generated are trimmed: an edited occurrence far ahead is
      // the user's, and deleting it would tombstone it on every device.
      for (const extra of future.slice(limit)) {
        if (!extra.event.generated) continue;
        remove(extra.event.id);
        futureCount -= 1;
      }
    }
    if (futureCount >= limit) continue;

    const remaining = live.filter((item) => existingIds.has(item.event.id));
    const latest = remaining.reduce((acc, item) => (item.startMs > acc.startMs ? item : acc), remaining[0] ?? live[0]);
    let cursorISO = latest.startISO || baseStartISO;
    let guard = 0;
    const maxGuard = Math.max(32, limit * 24);
    while (futureCount < limit && guard++ < maxGuard) {
      const nextISO = nextOccurrence(cursorISO, rule, seed.kind === "time", timeZone);
      if (!nextISO) break;
      cursorISO = nextISO;
      const id = calendarRecurrenceInstanceId(seriesId, nextISO, rule, timeZone);
      if (input.deletedOccurrenceIds.has(id)) continue;
      if (existingIds.has(id)) {
        const existing = next.find((event) => event.id === id);
        const endMs = existing ? calendarEventEndMs(existing) : null;
        if (endMs != null && endMs >= nowMs) futureCount += 1;
        continue;
      }
      const instance = buildOccurrence(id, nextISO, nextOrderForCalendarBoard(seed.boardId, next, settings.newTaskPosition));
      const instanceEndMs = calendarEventEndMs(instance);
      if (instanceEndMs != null && instanceEndMs < nowMs) continue;
      next.push(instance);
      existingIds.add(id);
      changed = true;
      if (instanceEndMs != null && instanceEndMs >= nowMs) futureCount += 1;
    }
  }

  return changed ? next : null;
}
