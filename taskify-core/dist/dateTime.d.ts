import type { Weekday } from "./weekDate.js";
/** A calendar date key, `YYYY-MM-DD`. */
export declare const ISO_DATE_PATTERN: RegExp;
export type DateKeyParts = {
    year: number;
    month: number;
    day: number;
};
export declare function startOfDay(d: Date): Date;
export declare const TIME_ZONE_VALIDATION_CACHE: Map<string, string | null>;
export declare const DATE_KEY_FORMATTER_CACHE: Map<string, Intl.DateTimeFormat>;
export declare const TIME_KEY_FORMATTER_CACHE: Map<string, Intl.DateTimeFormat>;
export declare const OFFSET_FORMATTER_CACHE: Map<string, Intl.DateTimeFormat>;
export declare function resolveSystemTimeZone(): string;
/** The IANA zone name if this runtime recognizes it, otherwise null. */
export declare function normalizeTimeZone(value?: string | null): string | null;
export declare function formatDateKeyFromParts(year: number, month: number, day: number): string;
export declare function formatDateKeyLocal(date: Date): string;
export declare function parseDateKey(value: string): DateKeyParts | null;
/** Moves a date key by whole calendar days, so DST cannot shift it. Null for an invalid key. */
export declare function addDaysToDateKey(dateKey: string, days: number): string | null;
export declare function weekdayOfDateKey(dateKey: string): Weekday | null;
export declare function parseTimeValue(value: string): {
    hour: number;
    minute: number;
} | null;
export declare function getDateKeyFormatter(timeZone: string): Intl.DateTimeFormat;
export declare function getTimeKeyFormatter(timeZone: string): Intl.DateTimeFormat;
export declare function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat;
export declare function formatDateKeyInTimeZone(date: Date, timeZone: string): string;
export declare function formatTimeKeyInTimeZone(date: Date, timeZone: string): string;
/** Milliseconds the zone is ahead of UTC at this instant. */
export declare function getTimeZoneOffset(date: Date, timeZone: string): number;
export declare function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date | null;
/** The date key of an instant, in `timeZone` when it is valid, else in local time. */
export declare function isoDatePart(iso: string, timeZone?: string): string;
export declare function isoTimePart(iso: string, timeZone?: string): string;
export declare function isoTimePartUtc(iso: string): string;
export declare function weekdayFromISO(iso: string, timeZone?: string): Weekday | null;
/** An ISO instant for a date key and optional `HH:mm`, in `timeZone` when valid, else local time. */
export declare function isoFromDateTime(dateStr: string, timeStr?: string, timeZone?: string): string;
