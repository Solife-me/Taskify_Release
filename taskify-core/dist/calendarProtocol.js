export const TASKIFY_CALENDAR_EVENT_KIND = 30310;
export const TASKIFY_CALENDAR_VIEW_KIND = 30311;
export const TASKIFY_CALENDAR_RSVP_KIND = 30312;
export function calendarAddress(kind, pubkey, d) {
    return `${kind}:${pubkey}:${d}`;
}
export function parseCalendarAddress(coord) {
    if (typeof coord !== "string")
        return null;
    const trimmed = coord.trim();
    if (!trimmed)
        return null;
    const parts = trimmed.split(":");
    if (parts.length < 3)
        return null;
    const kind = Number(parts[0]);
    if (!Number.isFinite(kind))
        return null;
    const pubkey = (parts[1] || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey))
        return null;
    const d = parts.slice(2).join(":").trim();
    if (!d)
        return null;
    return { kind, pubkey, d };
}
/**
 * Recurrence identity and its cutoff are part of the synced event version, including a
 * deleted version. That lets another client terminate the series without depending on a
 * relay honoring an optional NIP-09 deletion request.
 */
export function calendarRecurrenceSyncFields(event) {
    if (!event.recurrence || typeof event.recurrence !== "object")
        return {};
    const explicitSeriesId = typeof event.seriesId === "string" ? event.seriesId.trim() : "";
    const fallbackSeriesId = typeof event.id === "string" ? event.id.trim() : "";
    const seriesId = explicitSeriesId || fallbackSeriesId;
    return {
        recurrence: event.recurrence,
        ...(seriesId ? { seriesId } : {}),
    };
}
