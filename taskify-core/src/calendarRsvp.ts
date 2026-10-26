import { calendarAddress, parseCalendarAddress, TASKIFY_CALENDAR_EVENT_KIND, TASKIFY_CALENDAR_RSVP_KIND } from "./calendarProtocol.js";
import { parseCalendarRsvpPayload, type CalendarRsvpFb, type CalendarRsvpPayload, type CalendarRsvpStatus } from "./calendarDecode.js";
import { b64encode, concatBytes, sha256 } from "./nostrPrimitives.js";

/**
 * Event RSVPs, the rule the PWA, iOS and the CLI share (fixtures/calendar-rsvp-vectors.json).
 *
 * An attendee answers with their own kind 30312 event, signed with their key: `d` is
 * `<eventId>:<attendeePubkey>`, `a` the event's canonical 30310 address, and the content is
 * NIP-44 between the attendee and the board's key (the address's pubkey). The organizer stores
 * nothing: it reads the responses for the address, keeps those that pass `acceptCalendarRsvp`,
 * and shows the newest per attendee (`latestCalendarRsvps`).
 */

const BOARD_RSVP_TOKEN_LABEL = "taskify-board-rsvp-token-v1";

/**
 * The token a board member answers with when the event names no token for them:
 * base64(sha256(label ‖ "<boardId>:<attendeePubkey>")), with the board's shared id.
 */
export async function deriveBoardRsvpToken(boardId: string, attendeePubkey: string): Promise<string> {
  const encoder = new TextEncoder();
  const material = concatBytes(
    encoder.encode(BOARD_RSVP_TOKEN_LABEL),
    encoder.encode(`${(boardId || "").trim()}:${(attendeePubkey || "").trim().toLowerCase()}`),
  );
  return b64encode(await sha256(material));
}

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

export type CalendarRsvpPlan =
  | { kind: "invalid"; error: string }
  | {
      kind: "ready";
      /** Who the content is encrypted to: the board's key. */
      boardPubkey: string;
      canonicalAddress: string;
      tags: string[][];
      payload: CalendarRsvpPayload;
    };

/** Everything but the encryption and signature of an attendee's RSVP event. */
export function planCalendarRsvp(input: CalendarRsvpInput): CalendarRsvpPlan {
  const parsed = parseCalendarAddress(input.canonical);
  if (!parsed || parsed.kind !== TASKIFY_CALENDAR_EVENT_KIND) {
    return { kind: "invalid", error: "Invalid calendar event address." };
  }
  const eventId = (input.eventId || "").trim();
  if (eventId !== parsed.d) return { kind: "invalid", error: "Calendar event address mismatch." };
  const attendee = (input.attendeePubkey || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(attendee)) return { kind: "invalid", error: "Invalid attendee public key." };
  if (input.status !== "accepted" && input.status !== "declined" && input.status !== "tentative") {
    return { kind: "invalid", error: "Invalid RSVP status." };
  }
  const inviteToken = typeof input.inviteToken === "string" ? input.inviteToken.trim() : "";
  if (!inviteToken) return { kind: "invalid", error: "Missing invite token for RSVP." };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const canonicalAddress = calendarAddress(parsed.kind, parsed.pubkey, parsed.d);
  return {
    kind: "ready",
    boardPubkey: parsed.pubkey,
    canonicalAddress,
    tags: [["d", `${eventId}:${attendee}`], ["a", canonicalAddress]],
    payload: {
      v: 1,
      eventId,
      status: input.status,
      inviteToken,
      ...(input.fb === "free" || input.fb === "busy" ? { fb: input.fb } : {}),
      ...(note ? { note } : {}),
    },
  };
}

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
  rsvp: { kind: number; pubkey: string; created_at: number; tags: string[][] };
  /** Its content, decrypted with the board's key. */
  payload: unknown;
  /** The organizer's copy of the event. */
  event: { id: string; canonicalAddress: string; inviteTokens?: Record<string, string> | null };
  /** `deriveBoardRsvpToken(boardId, rsvp.pubkey)`. */
  boardToken: string;
};

/**
 * Whether an organizer counts a response: an RSVP for this event's address and id, carrying one of
 * the event's invite tokens or the attendee's board-derived token.
 */
export function acceptCalendarRsvp(
  input: CalendarRsvpAcceptInput,
): { accepted: true; response: CalendarRsvpResponse } | { accepted: false; reason: CalendarRsvpRejection } {
  const reject = (reason: CalendarRsvpRejection) => ({ accepted: false as const, reason });
  if (input.rsvp.kind !== TASKIFY_CALENDAR_RSVP_KIND) return reject("kind");
  const author = (input.rsvp.pubkey || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return reject("author");
  const address = input.rsvp.tags.find((tag) => tag[0] === "a")?.[1];
  if (!address || address !== input.event.canonicalAddress) return reject("address");
  const payload = parseCalendarRsvpPayload(input.payload);
  if (!payload) return reject("payload");
  if (payload.eventId !== input.event.id) return reject("event");
  const tokens = Object.values(input.event.inviteTokens ?? {});
  if (payload.inviteToken !== input.boardToken && !tokens.includes(payload.inviteToken)) return reject("token");
  return {
    accepted: true,
    response: {
      eventId: payload.eventId,
      attendeePubkey: author,
      createdAt: input.rsvp.created_at,
      status: payload.status,
      inviteToken: payload.inviteToken,
      ...(payload.fb ? { fb: payload.fb } : {}),
      ...(payload.note ? { note: payload.note } : {}),
    },
  };
}

/** Each attendee's newest response (on a tie, the larger token), ordered by attendee key. */
export function latestCalendarRsvps(responses: readonly CalendarRsvpResponse[]): CalendarRsvpResponse[] {
  const latest = new Map<string, CalendarRsvpResponse>();
  for (const response of responses) {
    const existing = latest.get(response.attendeePubkey);
    if (
      !existing ||
      response.createdAt > existing.createdAt ||
      (response.createdAt === existing.createdAt && response.inviteToken > existing.inviteToken)
    ) {
      latest.set(response.attendeePubkey, response);
    }
  }
  return Array.from(latest.values()).sort((a, b) => (a.attendeePubkey < b.attendeePubkey ? -1 : a.attendeePubkey > b.attendeePubkey ? 1 : 0));
}
