import type { Weekday } from "./weekDate.js";

/** A calendar date key, `YYYY-MM-DD`. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DateKeyParts = { year: number; month: number; day: number };

export function startOfDay(d: Date): Date {
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

/** The IANA zone name if this runtime recognizes it, otherwise null. */
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

export function parseDateKey(value: string): DateKeyParts | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

/** Moves a date key by whole calendar days, so DST cannot shift it. Null for an invalid key. */
export function addDaysToDateKey(dateKey: string, days: number): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  base.setUTCDate(base.getUTCDate() + days);
  return formatDateKeyFromParts(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

export function weekdayOfDateKey(dateKey: string): Weekday | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!Number.isFinite(utc)) return null;
  return new Date(utc).getUTCDay() as Weekday;
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
  const parts = getDateKeyFormatter(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return formatDateKeyLocal(date);
  return `${year}-${month}-${day}`;
}

export function formatTimeKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = getTimeKeyFormatter(timeZone).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) return "";
  return `${hour}:${minute}`;
}

/** Milliseconds the zone is ahead of UTC at this instant. */
export function getTimeZoneOffset(date: Date, timeZone: string): number {
  const parts = getOffsetFormatter(timeZone).formatToParts(date);
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

/** The date key of an instant, in `timeZone` when it is valid, else in local time. */
export function isoDatePart(iso: string, timeZone?: string): string {
  if (typeof iso === "string" && ISO_DATE_PATTERN.test(iso)) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatDateKeyLocal(new Date());
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) return formatDateKeyInTimeZone(date, safeZone);
  return formatDateKeyLocal(date);
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
  if (typeof iso === "string" && iso.length >= 16) return iso.slice(11, 16);
  try {
    return new Date(iso).toISOString().slice(11, 16);
  } catch {
    return "";
  }
}

export function weekdayFromISO(iso: string, timeZone?: string): Weekday | null {
  return weekdayOfDateKey(isoDatePart(iso, timeZone));
}

/** An ISO instant for a date key and optional `HH:mm`, in `timeZone` when valid, else local time. */
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
