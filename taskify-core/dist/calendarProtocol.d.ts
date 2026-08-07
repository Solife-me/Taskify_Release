export declare const TASKIFY_CALENDAR_EVENT_KIND = 30310;
export declare const TASKIFY_CALENDAR_VIEW_KIND = 30311;
export declare const TASKIFY_CALENDAR_RSVP_KIND = 30312;
export type CalendarAddress = {
    kind: number;
    pubkey: string;
    d: string;
};
export declare function calendarAddress(kind: number, pubkey: string, d: string): string;
export declare function parseCalendarAddress(coord: string): CalendarAddress | null;
/**
 * Recurrence identity and its cutoff are part of the synced event version, including a
 * deleted version. That lets another client terminate the series without depending on a
 * relay honoring an optional NIP-09 deletion request.
 */
export declare function calendarRecurrenceSyncFields<TRecurrence>(event: {
    id: string;
    recurrence?: TRecurrence;
    seriesId?: string;
}): {
    recurrence?: TRecurrence;
    seriesId?: string;
};
