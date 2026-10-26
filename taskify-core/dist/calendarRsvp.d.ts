import { type CalendarRsvpFb, type CalendarRsvpPayload, type CalendarRsvpStatus } from "./calendarDecode.js";
/**
 * The token a board member answers with when the event names no token for them:
 * base64(sha256(label ‖ "<boardId>:<attendeePubkey>")), with the board's shared id.
 */
export declare function deriveBoardRsvpToken(boardId: string, attendeePubkey: string): Promise<string>;
export type CalendarRsvpInput = {
    /** The event's canonical address, `30310:<boardPubkey>:<eventId>`. */
    canonical: string;
    eventId: string;
    attendeePubkey: string;
    status: CalendarRsvpStatus;
    inviteToken: string | null | undefined;
    fb?: CalendarRsvpFb;
    note?: string;
};
export type CalendarRsvpPlan = {
    kind: "invalid";
    error: string;
} | {
    kind: "ready";
    /** Who the content is encrypted to: the board's key. */
    boardPubkey: string;
    canonicalAddress: string;
    tags: string[][];
    payload: CalendarRsvpPayload;
};
/** Everything but the encryption and signature of an attendee's RSVP event. */
export declare function planCalendarRsvp(input: CalendarRsvpInput): CalendarRsvpPlan;
export type CalendarRsvpResponse = {
    eventId: string;
    attendeePubkey: string;
    /** The RSVP event's `created_at`, in seconds. */
    createdAt: number;
    status: CalendarRsvpStatus;
    inviteToken: string;
    fb?: CalendarRsvpFb;
    note?: string;
};
/** Why an organizer leaves a response out. */
export type CalendarRsvpRejection = "kind" | "author" | "address" | "payload" | "event" | "token";
export type CalendarRsvpAcceptInput = {
    /** The signed RSVP event, its signature already checked by the caller. */
    rsvp: {
        kind: number;
        pubkey: string;
        created_at: number;
        tags: string[][];
    };
    /** Its content, decrypted with the board's key. */
    payload: unknown;
    /** The organizer's copy of the event. */
    event: {
        id: string;
        canonicalAddress: string;
        inviteTokens?: Record<string, string> | null;
    };
    /** `deriveBoardRsvpToken(boardId, rsvp.pubkey)`. */
    boardToken: string;
};
/**
 * Whether an organizer counts a response: an RSVP for this event's address and id, carrying one of
 * the event's invite tokens or the attendee's board-derived token.
 */
export declare function acceptCalendarRsvp(input: CalendarRsvpAcceptInput): {
    accepted: true;
    response: CalendarRsvpResponse;
} | {
    accepted: false;
    reason: CalendarRsvpRejection;
};
/** Each attendee's newest response (on a tie, the larger token), ordered by attendee key. */
export declare function latestCalendarRsvps(responses: readonly CalendarRsvpResponse[]): CalendarRsvpResponse[];
