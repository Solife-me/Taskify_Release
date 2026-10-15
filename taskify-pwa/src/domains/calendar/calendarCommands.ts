/**
 * Calendar commands take current state and return the next state plus work for the caller.
 * They never touch React, storage or the network.
 */
import { addDaysToDateKey, ISO_DATE_PATTERN, MS_PER_DAY, nextOccurrence } from "taskify-core";
import { isoDatePart, normalizeTimeZone, parseDateKey, startOfDay } from "../dateTime/dateUtils";
import type { CalendarEvent } from "../tasks/taskTypes";
import { calendarRecurrenceInstanceId } from "./calendarRecurrenceWindow";
import { calendarEventDateKey, calendarEventStartISOForRecurrence } from "./calendarUtils";

export type CalendarEventPlan = {
  events: CalendarEvent[];
  publish: CalendarEvent[];
  publishDeleted: CalendarEvent[];
};

export type AppliedCalendarDeletePlan = CalendarEventPlan & {
  kind: "applied";
  deletedOccurrenceIds: string[];
  cutoff: { boardId: string; seriesId: string; untilISO: string } | null;
};

export type CalendarDeletePlan =
  | { kind: "none" }
  | { kind: "ask-scope"; event: CalendarEvent }
  | AppliedCalendarDeletePlan;

function appliedDeletePlan(
  events: CalendarEvent[],
  options: Partial<Omit<AppliedCalendarDeletePlan, "kind" | "events">> = {},
): AppliedCalendarDeletePlan {
  return {
    kind: "applied",
    events,
    publish: options.publish ?? [],
    publishDeleted: options.publishDeleted ?? [],
    deletedOccurrenceIds: options.deletedOccurrenceIds ?? [],
    cutoff: options.cutoff ?? null,
  };
}

/** Moves selected events to a board or list column while preserving list order. */
export function planMoveCalendarEvents(
  events: CalendarEvent[],
  ids: Iterable<string>,
  boardId: string,
  columnId?: string,
): CalendarEventPlan {
  const selected = ids instanceof Set ? ids : new Set(ids);
  const publish: CalendarEvent[] = [];
  const publishDeleted: CalendarEvent[] = [];
  let changed = false;
  const next = events.map((event) => {
    if (!selected.has(event.id)) return event;
    changed = true;
    if (event.boardId !== boardId) publishDeleted.push(event);
    const updated: CalendarEvent = {
      ...event,
      boardId,
      originBoardId: undefined,
      columnId,
    };
    publish.push(updated);
    return updated;
  });
  return {
    events: changed ? next : events,
    publish,
    publishDeleted,
  };
}

/**
 * Deletes one event or ends its recurring series. A series seed is advanced when only its first
 * occurrence is deleted, because tombstoning the seed would end the whole series on other clients.
 */
export function planDeleteCalendarEvent(
  events: CalendarEvent[],
  id: string,
  options?: { skipPrompt?: boolean; scope?: "single" | "future" },
): CalendarDeletePlan {
  const existing = events.find((event) => event.id === id);
  if (!existing) return { kind: "none" };
  if (!options?.skipPrompt && existing.recurrence) return { kind: "ask-scope", event: existing };

  const seriesId = existing.seriesId || existing.id;
  const isSeed = !!existing.recurrence && existing.recurrence.type !== "none" && seriesId === existing.id;
  if (options?.scope === "future") {
    const cutoffKey = calendarEventDateKey(existing);
    if (!cutoffKey) return { kind: "none" };
    const cutoffDate = startOfDay(new Date(`${cutoffKey}T00:00:00`));
    if (Number.isNaN(cutoffDate.getTime())) return { kind: "none" };
    const cutoffTime = cutoffDate.getTime();
    const nextUntil = new Date(cutoffTime - MS_PER_DAY).toISOString();
    const hasSeed = events.some(
      (event) => event.id === seriesId && !!event.recurrence && !event.generated,
    );
    const publish: CalendarEvent[] = [];
    const publishDeleted: CalendarEvent[] = [];
    const deletedOccurrenceIds: string[] = [];
    const removedIds = new Set<string>();
    const replacements = new Map<string, CalendarEvent>();
    for (const event of events) {
      const eventSeriesId = event.seriesId || event.id;
      if (!event.recurrence || eventSeriesId !== seriesId) continue;
      const startKey = calendarEventDateKey(event);
      if (!startKey) continue;
      if (startKey >= cutoffKey) {
        deletedOccurrenceIds.push(event.id);
        removedIds.add(event.id);
        if (!event.generated) {
          publishDeleted.push({
            ...event,
            seriesId,
            recurrence: { ...event.recurrence, untilISO: nextUntil },
          });
        }
        continue;
      }
      const untilTime = event.recurrence.untilISO
        ? startOfDay(new Date(event.recurrence.untilISO)).getTime()
        : null;
      if (!untilTime || untilTime > cutoffTime - MS_PER_DAY) {
        const updated: CalendarEvent = {
          ...event,
          seriesId: event.seriesId || seriesId,
          recurrence: { ...event.recurrence, untilISO: nextUntil },
        };
        replacements.set(event.id, updated);
        const publishes = hasSeed ? event.id === seriesId : !event.generated;
        if (publishes) publish.push(updated);
      }
    }
    const next = removedIds.size || replacements.size
      ? events
          .filter((event) => !removedIds.has(event.id))
          .map((event) => replacements.get(event.id) ?? event)
      : events;
    return appliedDeletePlan(next, {
      publish,
      publishDeleted,
      deletedOccurrenceIds,
      cutoff: { boardId: existing.boardId, seriesId, untilISO: nextUntil },
    });
  }

  if (isSeed) return planAdvanceCalendarSeriesSeed(events, existing);

  return appliedDeletePlan(events.filter((event) => event.id !== id), {
    publishDeleted: [{ ...existing, generated: undefined }],
    deletedOccurrenceIds: [existing.id],
  });
}

/** Moves a recurring seed to its next occurrence without changing the stable series id. */
export function planAdvanceCalendarSeriesSeed(
  events: CalendarEvent[],
  seed: CalendarEvent,
): AppliedCalendarDeletePlan {
  const rule = seed.recurrence;
  const startISO = calendarEventStartISOForRecurrence(seed);
  const timeZone = seed.kind === "time" ? normalizeTimeZone(seed.startTzid) ?? undefined : "UTC";
  const nextISO = rule && startISO ? nextOccurrence(startISO, rule, seed.kind === "time", timeZone) : null;
  if (!rule || !nextISO) {
    return appliedDeletePlan(
      events.filter((event) => event.id !== seed.id && !(event.generated && event.seriesId === seed.id)),
      { publishDeleted: [seed] },
    );
  }

  let moved: CalendarEvent;
  if (seed.kind === "time") {
    const durationMs = seed.endISO ? Math.max(0, Date.parse(seed.endISO) - Date.parse(seed.startISO)) : 0;
    moved = {
      ...seed,
      startISO: nextISO,
      ...(durationMs ? { endISO: new Date(Date.parse(nextISO) + durationMs).toISOString() } : {}),
    };
  } else {
    const startDate = isoDatePart(nextISO, "UTC");
    const startParts = parseDateKey(seed.startDate);
    const endParts = seed.endDate && ISO_DATE_PATTERN.test(seed.endDate) ? parseDateKey(seed.endDate) : null;
    const spanDays = startParts && endParts
      ? Math.round(
          (Date.UTC(endParts.year, endParts.month - 1, endParts.day)
            - Date.UTC(startParts.year, startParts.month - 1, startParts.day))
            / MS_PER_DAY,
        )
      : 0;
    moved = {
      ...seed,
      startDate,
      ...(spanDays > 0 ? { endDate: addDaysToDateKey(startDate, spanDays) } : { endDate: undefined }),
    } as CalendarEvent;
  }
  const nextId = calendarRecurrenceInstanceId(seed.id, nextISO, rule, timeZone);
  const stood = events.find((event) => event.id === nextId);
  const next = events
    .filter((event) => event.id !== nextId)
    .map((event) => (event.id === seed.id ? moved : event));
  return appliedDeletePlan(next, {
    publish: [moved],
    publishDeleted: stood && !stood.generated ? [stood] : [],
    deletedOccurrenceIds: [nextId],
  });
}
