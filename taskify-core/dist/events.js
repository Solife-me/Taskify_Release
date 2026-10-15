import { ISO_DATE_PATTERN, isoFromDateTime, normalizeTimeZone } from "./dateTime.js";
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function buildCalendarEventDraft(input) {
    const boardId = input.boardId.trim();
    const title = input.title.trim();
    const date = input.date.trim();
    const endDate = input.endDate?.trim();
    const time = input.time?.trim();
    const endTime = input.endTime?.trim();
    const tz = normalizeTimeZone(input.timeZone) ?? undefined;
    if (!boardId)
        throw new Error("boardId is required");
    if (!title)
        throw new Error("title is required");
    if (!ISO_DATE_PATTERN.test(date))
        throw new Error("date must be YYYY-MM-DD");
    if (endDate && !ISO_DATE_PATTERN.test(endDate))
        throw new Error("endDate must be YYYY-MM-DD");
    if (time && !HHMM_RE.test(time))
        throw new Error("time must be HH:mm");
    if (endTime && !HHMM_RE.test(endTime))
        throw new Error("endTime must be HH:mm");
    if ((time || endTime) && endDate) {
        throw new Error("Cannot combine endDate with timed event. Use endTime for timed ranges.");
    }
    const id = crypto.randomUUID();
    if (time || endTime) {
        const start = isoFromDateTime(date, time || "09:00", tz);
        const endCandidate = isoFromDateTime(date, endTime || "10:00", tz);
        const startMs = Date.parse(start);
        const endMs = Date.parse(endCandidate);
        const end = !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs ? endCandidate : undefined;
        return {
            id,
            boardId,
            title,
            kind: "time",
            startISO: start,
            ...(end ? { endISO: end } : {}),
            ...(tz ? { startTzid: tz, endTzid: tz } : {}),
        };
    }
    return {
        id,
        boardId,
        title,
        kind: "date",
        startDate: date,
        ...(endDate && endDate >= date ? { endDate } : {}),
    };
}
