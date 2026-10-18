import React from "react";
import type { Weekday, Meridiem } from "../appTypes";
import type { Task } from "../tasks/taskTypes";

/* ================= Date helpers ================= */
// Pure date-key and time-zone helpers live in taskify-core so every client computes dates alike.
export {
  startOfDay,
  TIME_ZONE_VALIDATION_CACHE,
  DATE_KEY_FORMATTER_CACHE,
  TIME_KEY_FORMATTER_CACHE,
  OFFSET_FORMATTER_CACHE,
  resolveSystemTimeZone,
  normalizeTimeZone,
  formatDateKeyFromParts,
  formatDateKeyLocal,
  parseDateKey,
  addDaysToDateKey,
  parseTimeValue,
  getDateKeyFormatter,
  getTimeKeyFormatter,
  getOffsetFormatter,
  formatDateKeyInTimeZone,
  formatTimeKeyInTimeZone,
  getTimeZoneOffset,
  zonedTimeToUtc,
  isoDatePart,
  isoTimePart,
  isoTimePartUtc,
  weekdayFromISO,
  isoFromDateTime,
} from "taskify-core";
import {
  formatDateKeyFromParts,
  isoDatePart,
  isoTimePart,
  normalizeTimeZone,
  parseDateKey,
  parseTimeValue,
  startOfDay,
  weekdayFromISO,
} from "taskify-core";

export function formatOffsetLabel(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) return "UTC";
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function formatUpcomingDayLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  const weekday = parsed.toLocaleDateString([], { weekday: "long" });
  const monthDay = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${weekday} — ${monthDay}`;
}

export function taskDateKey(task: Task): string {
  return isoDatePart(task.dueISO, task.dueTimeZone);
}

export function taskDisplayDateKey(task: Task): string {
  return isoDatePart(task.dueISO);
}

export function taskTimeValue(task: Task): number | null {
  if (!task.dueTimeEnabled) return null;
  const timePart = isoTimePart(task.dueISO);
  const parsed = parseTimeValue(timePart);
  if (!parsed) return null;
  return parsed.hour * 60 + parsed.minute;
}

export function taskWeekday(task: Task): Weekday | null {
  // Use the task's stored dueTimeZone so a Wed-11pm-Pacific task doesn't
  // appear on Thursday for a viewer in UTC. The regression test in
  // tests/weekBoardGroupingRegression.test.ts asserts this exact shape.
  return weekdayFromISO(task.dueISO, task.dueTimeZone);
}

export function calendarAnchorFrom(dateStr?: string | null) {
  const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

export function getWheelMetrics(column: HTMLDivElement | null) {
  if (!column) return null;
  const first = column.querySelector<HTMLElement>("[data-picker-index]");
  if (!first) return null;
  const optionHeight = first.getBoundingClientRect().height;
  const optionOffset = first.offsetTop;
  return { optionHeight, optionOffset };
}

export function scrollWheelColumnToIndex(
  column: HTMLDivElement | null,
  index: number,
  behavior: ScrollBehavior = "smooth",
) {
  if (!column) return;
  const metrics = getWheelMetrics(column);
  if (!metrics) return;
  const { optionHeight, optionOffset } = metrics;
  const optionCenter = optionOffset + index * optionHeight + optionHeight / 2;
  const targetTop = optionCenter - column.clientHeight / 2;
  const maxScroll = Math.max(0, column.scrollHeight - column.clientHeight);
  const clampedTop = Math.max(0, Math.min(targetTop, maxScroll));
  if (Math.abs(column.scrollTop - clampedTop) < 0.5) return;
  column.scrollTo({ top: clampedTop, behavior });
}

export function getWheelNearestIndex(column: HTMLDivElement | null, totalOptions: number) {
  if (!column || totalOptions <= 0) return null;
  const metrics = getWheelMetrics(column);
  if (!metrics) return null;
  const { optionHeight, optionOffset } = metrics;
  if (!optionHeight) return null;
  const viewCenter = column.scrollTop + column.clientHeight / 2;
  const relative = (viewCenter - optionOffset - optionHeight / 2) / optionHeight;
  const rawIndex = Math.round(relative);
  return Math.min(totalOptions - 1, Math.max(0, rawIndex));
}

export type WheelPickerColumnTarget = {
  ref: React.RefObject<HTMLDivElement | null>;
  optionCount: number;
};

function wheelDeltaYToPixels(event: React.WheelEvent<HTMLElement>, column: HTMLDivElement) {
  const lineHeight = getWheelMetrics(column)?.optionHeight ?? 40;
  if (event.deltaMode === 1) return event.deltaY * lineHeight;
  if (event.deltaMode === 2) return event.deltaY * column.clientHeight;
  return event.deltaY;
}

function distanceToRect(rect: DOMRect, x: number, y: number) {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function closestWheelPickerColumn(
  event: React.WheelEvent<HTMLElement>,
  columns: WheelPickerColumnTarget[],
) {
  const target = event.target instanceof Element ? event.target : null;
  const containingColumn = target
    ? columns.find((column) => {
        const element = column.ref.current;
        return element ? element.contains(target) : false;
      })
    : undefined;
  if (containingColumn?.ref.current) return containingColumn;

  let nearest: WheelPickerColumnTarget | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const element = column.ref.current;
    if (!element) continue;
    const distance = distanceToRect(element.getBoundingClientRect(), event.clientX, event.clientY);
    if (distance < nearestDistance) {
      nearest = column;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function handleWheelPickerScroll(
  event: React.WheelEvent<HTMLElement>,
  columns: WheelPickerColumnTarget[],
) {
  const targetColumn = closestWheelPickerColumn(event, columns);
  const column = targetColumn?.ref.current;
  if (!targetColumn || !column) return;

  event.preventDefault();
  event.stopPropagation();

  const rawDelta = wheelDeltaYToPixels(event, column);
  if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < 0.5) return;

  const metrics = getWheelMetrics(column);
  const maxStep = metrics?.optionHeight ?? 48;
  const delta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), maxStep);
  const maxScroll = Math.max(0, column.scrollHeight - column.clientHeight);
  const nextTop = Math.max(0, Math.min(column.scrollTop + delta, maxScroll));

  if (Math.abs(nextTop - column.scrollTop) >= 0.5) {
    column.scrollTop = nextTop;
    return;
  }

  const currentIndex = getWheelNearestIndex(column, targetColumn.optionCount);
  if (currentIndex == null) return;
  const nextIndex = Math.max(0, Math.min(targetColumn.optionCount - 1, currentIndex + Math.sign(rawDelta)));
  if (nextIndex !== currentIndex) {
    scrollWheelColumnToIndex(column, nextIndex);
  }
}

export function scheduleWheelSnap(
  columnRef: React.RefObject<HTMLDivElement | null>,
  snapRef: React.MutableRefObject<number | null>,
  targetIndex: number,
  onCommit?: () => void,
) {
  if (snapRef.current != null) {
    window.clearTimeout(snapRef.current);
    snapRef.current = null;
  }
  snapRef.current = window.setTimeout(() => {
    snapRef.current = null;
    scrollWheelColumnToIndex(columnRef.current, targetIndex);
    onCommit?.();
  }, 120);
}

export function nudgeHorizontalScroller(scroller: HTMLDivElement | null) {
  if (!scroller) return;
  const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScroll < 1) return;
  const start = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
  const bump = start < maxScroll ? start + 1 : start - 1;
  if (Math.abs(bump - start) < 0.5) return;
  scroller.scrollLeft = bump;
  scroller.scrollLeft = start;
}

export function monthKeyFromYearMonth(year: number, monthIndex: number): string {
  const mm = String(monthIndex + 1).padStart(2, "0");
  return `${year}-${mm}`;
}

export function daysInCalendarMonth(year: number, monthIndex: number): number {
  const value = new Date(year, monthIndex + 1, 0).getDate();
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function nthWeekdayOfMonthDateKey(
  year: number,
  monthIndex: number,
  weekday: Weekday,
  occurrence: number,
): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(occurrence)) return null;
  if (occurrence < 1) return null;
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
  if (Number.isNaN(firstOfMonth.getTime())) return null;
  const firstWeekday = firstOfMonth.getUTCDay() as Weekday;
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (occurrence - 1) * 7;
  const maxDay = daysInCalendarMonth(year, monthIndex);
  if (day < 1 || day > maxDay) return null;
  return formatDateKeyFromParts(year, monthIndex + 1, day);
}

export function lastWeekdayOfMonthDateKey(year: number, monthIndex: number, weekday: Weekday): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return null;
  const maxDay = daysInCalendarMonth(year, monthIndex);
  const lastOfMonth = new Date(Date.UTC(year, monthIndex, maxDay));
  if (Number.isNaN(lastOfMonth.getTime())) return null;
  const lastWeekday = lastOfMonth.getUTCDay() as Weekday;
  const offset = (lastWeekday - weekday + 7) % 7;
  const day = maxDay - offset;
  if (day < 1 || day > maxDay) return null;
  return formatDateKeyFromParts(year, monthIndex + 1, day);
}

export function observedUsHolidayDateKey(dateKey: string): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (Number.isNaN(date.getTime())) return null;
  const weekday = date.getUTCDay() as Weekday;
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  else return null;
  return date.toISOString().slice(0, 10);
}

export function formatTimeLabel(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const safeZone = normalizeTimeZone(timeZone);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(safeZone ? { timeZone: safeZone } : {}),
  });
}

/**
 * Returns the current time as "HH:00" (24h), rounded UP to the next full hour.
 * Optionally accepts:
 *   - offsetMinutes: applied to "now" before rounding (e.g. +60 shifts the
 *     base time forward 1 h, so the result is "next hour + 1"). Useful for
 *     defaulting event end times.
 *   - timeZone: IANA tz name — uses Intl.DateTimeFormat to read the hour in
 *     that zone. Falls back to device local time if omitted or invalid.
 */
export function currentTimeValue(offsetMinutes = 0, timeZone?: string | null): string {
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  let h: number;
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en", {
        hour: "numeric",
        hour12: false,
        timeZone: safeZone,
      }).formatToParts(now);
      h = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
    } catch {
      h = now.getHours();
    }
  } else {
    h = now.getHours();
  }
  // Round up to the next full hour.
  const nextH = (h + 1) % 24;
  return `${String(nextH).padStart(2, "0")}:00`;
}

export function parseTimePickerValue(value?: string | null, fallback = "09:00") {
  const source = typeof value === "string" && value.includes(":") ? value : fallback;
  const [hourRaw, minuteRaw] = (source || "09:00").split(":");
  const hour24 = Number.parseInt(hourRaw ?? "0", 10);
  const minute = Number.parseInt(minuteRaw ?? "0", 10);
  const safeHour24 = Number.isFinite(hour24) ? Math.min(23, Math.max(0, hour24)) : 9;
  const clampedMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  const safeMinute = Math.round(clampedMinute / 5) * 5 % 60;
  const meridiem: Meridiem = safeHour24 >= 12 ? "PM" : "AM";
  const hour12 = safeHour24 % 12 === 0 ? 12 : safeHour24 % 12;
  return {
    hour: hour12,
    minute: safeMinute,
    meridiem,
  };
}

export function formatTimePickerValue(hour12: number, minute: number, meridiem: Meridiem) {
  const normalizedHour = Math.min(12, Math.max(1, hour12 || 12));
  const normalizedMinute = Math.min(59, Math.max(0, minute));
  let hour24 = normalizedHour % 12;
  if (meridiem === "PM") {
    hour24 += 12;
  } else if (normalizedHour === 12) {
    hour24 = 0;
  }
  const hh = String(hour24).padStart(2, "0");
  const mm = String(normalizedMinute).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** A timestamp string as canonical ISO (UTC), or undefined if it is not a valid date. */
export function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/** Local midnight today (or of `base`), as an ISO timestamp. */
export function isoForToday(base = new Date()): string {
  return startOfDay(base).toISOString();
}
