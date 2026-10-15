/** A calendar date key, `YYYY-MM-DD`. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function startOfDay(d) {
    const nd = new Date(d);
    nd.setHours(0, 0, 0, 0);
    return nd;
}
export const TIME_ZONE_VALIDATION_CACHE = new Map();
export const DATE_KEY_FORMATTER_CACHE = new Map();
export const TIME_KEY_FORMATTER_CACHE = new Map();
export const OFFSET_FORMATTER_CACHE = new Map();
export function resolveSystemTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
    catch {
        return "UTC";
    }
}
/** The IANA zone name if this runtime recognizes it, otherwise null. */
export function normalizeTimeZone(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (TIME_ZONE_VALIDATION_CACHE.has(trimmed))
        return TIME_ZONE_VALIDATION_CACHE.get(trimmed) ?? null;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
        TIME_ZONE_VALIDATION_CACHE.set(trimmed, trimmed);
        return trimmed;
    }
    catch {
        TIME_ZONE_VALIDATION_CACHE.set(trimmed, null);
        return null;
    }
}
export function formatDateKeyFromParts(year, month, day) {
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}
export function formatDateKeyLocal(date) {
    return formatDateKeyFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
export function parseDateKey(value) {
    if (!ISO_DATE_PATTERN.test(value))
        return null;
    const [yearRaw, monthRaw, dayRaw] = value.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day))
        return null;
    return { year, month, day };
}
/** Moves a date key by whole calendar days, so DST cannot shift it. Null for an invalid key. */
export function addDaysToDateKey(dateKey, days) {
    const parsed = parseDateKey(dateKey);
    if (!parsed)
        return null;
    const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
    base.setUTCDate(base.getUTCDate() + days);
    return formatDateKeyFromParts(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}
export function weekdayOfDateKey(dateKey) {
    const parsed = parseDateKey(dateKey);
    if (!parsed)
        return null;
    const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
    if (!Number.isFinite(utc))
        return null;
    return new Date(utc).getUTCDay();
}
export function parseTimeValue(value) {
    if (typeof value !== "string" || !value.includes(":"))
        return null;
    const [hourRaw, minuteRaw] = value.split(":");
    const hour = Number.parseInt(hourRaw ?? "", 10);
    const minute = Number.parseInt(minuteRaw ?? "", 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return null;
    return {
        hour: Math.min(23, Math.max(0, hour)),
        minute: Math.min(59, Math.max(0, minute)),
    };
}
export function getDateKeyFormatter(timeZone) {
    const cached = DATE_KEY_FORMATTER_CACHE.get(timeZone);
    if (cached)
        return cached;
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    DATE_KEY_FORMATTER_CACHE.set(timeZone, formatter);
    return formatter;
}
export function getTimeKeyFormatter(timeZone) {
    const cached = TIME_KEY_FORMATTER_CACHE.get(timeZone);
    if (cached)
        return cached;
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });
    TIME_KEY_FORMATTER_CACHE.set(timeZone, formatter);
    return formatter;
}
export function getOffsetFormatter(timeZone) {
    const cached = OFFSET_FORMATTER_CACHE.get(timeZone);
    if (cached)
        return cached;
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
export function formatDateKeyInTimeZone(date, timeZone) {
    const parts = getDateKeyFormatter(timeZone).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day)
        return formatDateKeyLocal(date);
    return `${year}-${month}-${day}`;
}
export function formatTimeKeyInTimeZone(date, timeZone) {
    const parts = getTimeKeyFormatter(timeZone).formatToParts(date);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    if (!hour || !minute)
        return "";
    return `${hour}:${minute}`;
}
/** Milliseconds the zone is ahead of UTC at this instant. */
export function getTimeZoneOffset(date, timeZone) {
    const parts = getOffsetFormatter(timeZone).formatToParts(date);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    const second = Number(parts.find((part) => part.type === "second")?.value);
    if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value)))
        return 0;
    const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    return asUTC - date.getTime();
}
export function zonedTimeToUtc(dateStr, timeStr, timeZone) {
    const parsedDate = parseDateKey(dateStr);
    const parsedTime = parseTimeValue(timeStr);
    if (!parsedDate || !parsedTime)
        return null;
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
export function isoDatePart(iso, timeZone) {
    if (typeof iso === "string" && ISO_DATE_PATTERN.test(iso))
        return iso;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return formatDateKeyLocal(new Date());
    const safeZone = normalizeTimeZone(timeZone);
    if (safeZone)
        return formatDateKeyInTimeZone(date, safeZone);
    return formatDateKeyLocal(date);
}
export function isoTimePart(iso, timeZone) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return "";
    const safeZone = normalizeTimeZone(timeZone);
    if (safeZone)
        return formatTimeKeyInTimeZone(date, safeZone);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}
export function isoTimePartUtc(iso) {
    if (typeof iso === "string" && iso.length >= 16)
        return iso.slice(11, 16);
    try {
        return new Date(iso).toISOString().slice(11, 16);
    }
    catch {
        return "";
    }
}
export function weekdayFromISO(iso, timeZone) {
    return weekdayOfDateKey(isoDatePart(iso, timeZone));
}
/** An ISO instant for a date key and optional `HH:mm`, in `timeZone` when valid, else local time. */
export function isoFromDateTime(dateStr, timeStr, timeZone) {
    const safeZone = normalizeTimeZone(timeZone);
    if (dateStr) {
        if (safeZone && ISO_DATE_PATTERN.test(dateStr)) {
            const timeValue = timeStr || "00:00";
            const zoned = zonedTimeToUtc(dateStr, timeValue, safeZone);
            if (zoned && !Number.isNaN(zoned.getTime()))
                return zoned.toISOString();
        }
        if (timeStr) {
            const withTime = new Date(`${dateStr}T${timeStr}`);
            if (!Number.isNaN(withTime.getTime()))
                return withTime.toISOString();
        }
        const midnight = new Date(`${dateStr}T00:00`);
        if (!Number.isNaN(midnight.getTime()))
            return midnight.toISOString();
    }
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime()))
        return parsed.toISOString();
    return new Date().toISOString();
}
