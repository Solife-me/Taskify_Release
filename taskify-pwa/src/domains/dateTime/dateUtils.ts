import React from "react";
import type { Weekday, Meridiem } from "../appTypes";
import { ISO_DATE_PATTERN } from "../appTypes";
import type { Task } from "../tasks/taskTypes";

/* ================= Date helpers ================= */
export function startOfDay(d: Date) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

export const TIME_ZONE_VALIDATION_CACHE = new Map<string, string | null>();
export const DATE_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
export const TIME_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
export const OFFSET_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export function resolveSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function normalizeTimeZone(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (TIME_ZONE_VALIDATION_CACHE.has(trimmed)) return TIME_ZONE_VALIDATION_CACHE.get(trimmed) ?? null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    TIME_ZONE_VALIDATION_CACHE.set(trimmed, trimmed);
    return trimmed;
  } catch {
    TIME_ZONE_VALIDATION_CACHE.set(trimmed, null);
    return null;
  }
}

export function formatDateKeyFromParts(year: number, month: number, day: number): string {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDateKeyLocal(date: Date): string {
  return formatDateKeyFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return {
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
  };
}

export function getDateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_KEY_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DATE_KEY_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

export function getTimeKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = TIME_KEY_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  TIME_KEY_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

export function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = OFFSET_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  OFFSET_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

export function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const formatter = getDateKeyFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return formatDateKeyLocal(date);
  return `${year}-${month}-${day}`;
}

export function formatTimeKeyInTimeZone(date: Date, timeZone: string): string {
  const formatter = getTimeKeyFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) return "";
  return `${hour}:${minute}`;
}

export function getTimeZoneOffset(date: Date, timeZone: string): number {
  const formatter = getOffsetFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const second = Number(parts.find((part) => part.type === "second")?.value);
  if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) return 0;
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUTC - date.getTime();
}

export function formatOffsetLabel(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) return "UTC";
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date | null {
  const parsedDate = parseDateKey(dateStr);
  const parsedTime = parseTimeValue(timeStr);
  if (!parsedDate || !parsedTime) return null;
  const { year, month, day } = parsedDate;
  const { hour, minute } = parsedTime;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffset(utcGuess, timeZone);
  let adjusted = new Date(utcGuess.getTime() - offset);
  const offsetCheck = getTimeZoneOffset(adjusted, timeZone);
  if (offsetCheck !== offset) {
    adjusted = new Date(utcGuess.getTime() - offsetCheck);
  }
  return adjusted;
}

export function isoDatePart(iso: string, timeZone?: string): string {
  if (typeof iso === "string" && ISO_DATE_PATTERN.test(iso)) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatDateKeyLocal(new Date());
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) return formatDateKeyInTimeZone(date, safeZone);
  return formatDateKeyLocal(date);
}

export function formatUpcomingDayLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  const weekday = parsed.toLocaleDateString([], { weekday: "long" });
  const monthDay = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${weekday} — ${monthDay}`;
}

export function isoTimePart(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) return formatTimeKeyInTimeZone(date, safeZone);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function isoTimePartUtc(iso: string): string {
  if (typeof iso === 'string' && iso.length >= 16) return iso.slice(11, 16);
  try { return new Date(iso).toISOString().slice(11, 16); } catch { return ""; }
}

export function weekdayFromISO(iso: string, timeZone?: string): Weekday | null {
  const dateKey = isoDatePart(iso, timeZone);
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!Number.isFinite(utc)) return null;
  return new Date(utc).getUTCDay() as Weekday;
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

export function isoFromDateTime(dateStr: string, timeStr?: string, timeZone?: string): string {
  const safeZone = normalizeTimeZone(timeZone);
  if (dateStr) {
    if (safeZone && ISO_DATE_PATTERN.test(dateStr)) {
      const timeValue = timeStr || "00:00";
      const zoned = zonedTimeToUtc(dateStr, timeValue, safeZone);
      if (zoned && !Number.isNaN(zoned.getTime())) return zoned.toISOString();
    }
    if (timeStr) {
      const withTime = new Date(`${dateStr}T${timeStr}`);
      if (!Number.isNaN(withTime.getTime())) return withTime.toISOString();
    }
    const midnight = new Date(`${dateStr}T00:00`);
    if (!Number.isNaN(midnight.getTime())) return midnight.toISOString();
  }
  const parsed = new Date(dateStr);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
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
