// Calendar event date/visibility utility functions extracted from App.tsx

import type { CalendarEvent, Board } from "../tasks/taskTypes";
import { ISO_DATE_PATTERN, MS_PER_DAY } from "../appTypes";
import type { Weekday } from "../appTypes";
import { isoDatePart, parseDateKey, formatDateKeyLocal, isoFromDateTime } from "../dateTime/dateUtils";

// ---- Special calendar constants ----

export const SPECIAL_CALENDAR_US_HOLIDAYS_ID = "special:us-holidays";
export const SPECIAL_CALENDAR_US_HOLIDAYS_LABEL = "US Holidays";
export const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS = 1;
export const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS = 8;

// ---- Week helpers ----

export { startOfWeekLocal as startOfWeek } from "taskify-core";
import { startOfWeekLocal as startOfWeek } from "taskify-core";

// ---- Calendar event date/time utilities ----

export function calendarEventDateKey(event: CalendarEvent): string | null {
  if (event.kind === "date") {
    return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  }
  const key = isoDatePart(event.startISO, event.startTzid);
  return ISO_DATE_PATTERN.test(key) ? key : null;
}

export function calendarEventStartISOForRecurrence(event: CalendarEvent): string | null {
  if (event.kind === "time") return event.startISO;
  const dateKey = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  if (!dateKey) return null;
  return isoFromDateTime(dateKey, "00:00", "UTC");
}

export function calendarEventEndMs(event: CalendarEvent): number | null {
  if (event.kind === "time") {
    const start = Date.parse(event.startISO);
    if (Number.isNaN(start)) return null;
    if (event.endISO) {
      const end = Date.parse(event.endISO);
      if (!Number.isNaN(end) && end >= start) return end;
    }
    return start;
  }
  const startKey = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  if (!startKey) return null;
  const endKey =
    event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= startKey
      ? event.endDate
      : startKey;
  const parsed = parseDateKey(endKey);
  if (!parsed) return null;
  const endUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!Number.isFinite(endUtc)) return null;
  return endUtc + MS_PER_DAY;
}

export function calendarWeekRangeKeys(weekStart: Weekday, base = new Date()): { startKey: string; endKey: string } {
  const start = startOfWeek(base, weekStart);
  const startKey = formatDateKeyLocal(start);
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  const endKey = formatDateKeyLocal(end);
  return { startKey, endKey };
}

export function hiddenUntilForCalendarEvent(
  event: CalendarEvent,
  boardKind: Board["kind"],
  weekStart: Weekday,
): string | undefined {
  if (boardKind !== "lists" && boardKind !== "compound") return undefined;
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return undefined;
  const parsed = parseDateKey(dateKey);
  if (!parsed) return undefined;
  const eventDate = new Date(parsed.year, parsed.month - 1, parsed.day);
  if (Number.isNaN(eventDate.getTime())) return undefined;
  const eventWeekStart = startOfWeek(eventDate, weekStart);
  const currentWeekStart = startOfWeek(new Date(), weekStart);
  if (eventWeekStart.getTime() > currentWeekStart.getTime()) {
    return eventWeekStart.toISOString();
  }
  return undefined;
}

export function isCalendarEventVisibleOnListBoard(event: CalendarEvent, weekStart: Weekday, now = new Date()): boolean {
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return false;
  const { startKey, endKey } = calendarWeekRangeKeys(weekStart, now);

  if (event.kind === "date") {
    const startKeyForEvent = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : dateKey;
    const endKeyForEvent =
      event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= startKeyForEvent
        ? event.endDate
        : startKeyForEvent;
    if (endKeyForEvent < startKey) return false;
    if (startKeyForEvent <= endKey && endKeyForEvent >= startKey) return true;
    return !event.hiddenUntilISO;
  }

  if (dateKey < startKey) return false;
  if (dateKey > endKey) return !event.hiddenUntilISO;
  return true;
}
