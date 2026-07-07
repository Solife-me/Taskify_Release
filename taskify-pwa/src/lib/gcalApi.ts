// Helper for signing Worker API requests for Google Calendar endpoints.
// Uses the same Nostr privkey the app already holds.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Prefix for synthetic boardId values representing Google Calendar calendars.
// Keeps gcal events identifiable and isolated from real board IDs.
export const SPECIAL_GCAL_CALENDAR_PREFIX = "gcal:";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GcalConnectionStatus =
  | { connected: false }
  | {
      connected: true;
      status: "active" | "token_expired" | "needs_reauth" | "sync_failed" | "disconnected";
      googleEmail: string;
      lastSyncAt: number | null;
      lastError: string | null;
    };

export type GcalCalendar = {
  id: string;
  name: string;
  primary_cal: number;
  selected: number;
  color: string | null;
  timezone: string | null;
};

/** Normalized Google Calendar event as returned by /api/gcal/events */
export type GcalExternalEvent = {
  id: string;
  calendarId: string;
  providerEventId: string;
  calendarName: string;
  calendarColor?: string;
  title: string;
  description?: string;
  location?: string;
  startISO: string;
  endISO?: string;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  htmlLink?: string;
  isRecurring: boolean;
  readonly: true;
  source: "google";
  kind: "calendar_event";
};

/** Shape accepted by Taskify's CalendarEvent union (TimeCalendarEvent | DateCalendarEvent) */
export type GcalCalendarEvent = {
  id: string;
  boardId: string;
  title: string;
  description?: string;
  locations?: string[];
  readOnly: true;
  gcalSource: true;
  gcalCalendarName: string;
  gcalCalendarColor?: string;
  gcalHtmlLink?: string;
} & (
  | { kind: "time"; startISO: string; endISO?: string }
  | { kind: "date"; startDate: string; endDate?: string }
);

// ─── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a GcalExternalEvent from the Worker into the CalendarEvent shape
 * that Taskify's Upcoming view understands.
 *
 * boardId is a synthetic `gcal:<calendarId>` value so Google Calendar
 * calendars appear as distinct sources in the filter panel.
 */
export function gcalEventToCalendarEvent(ev: GcalExternalEvent): GcalCalendarEvent {
  const boardId = `${SPECIAL_GCAL_CALENDAR_PREFIX}${ev.calendarId}`;
  const base = {
    id: ev.id,
    boardId,
    title: ev.title,
    description: ev.description,
    locations: ev.location ? [ev.location] : undefined,
    readOnly: true as const,
    gcalSource: true as const,
    gcalCalendarName: ev.calendarName,
    gcalCalendarColor: ev.calendarColor,
    gcalHtmlLink: ev.htmlLink,
  };

  if (ev.allDay) {
    // All-day: use date strings, never treat as midnight UTC
    const startDate = ev.startISO.slice(0, 10);
    const endDate = ev.endISO ? ev.endISO.slice(0, 10) : undefined;
    return { ...base, kind: "date", startDate, endDate };
  }

  return { ...base, kind: "time", startISO: ev.startISO, endISO: ev.endISO };
}

// ─── Auth headers ─────────────────────────────────────────────────────────────

export async function signGcalHeaders(
  privkeyHex: string,
  body: string = "",
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = `${ts}.${body}`;
  const msgHash = sha256(new TextEncoder().encode(payload));
  const privkeyBytes = hexToBytes(privkeyHex);
  const sigBytes = schnorr.sign(msgHash, privkeyBytes);
  const pubkey = bytesToHex(schnorr.getPublicKey(privkeyBytes));
  return {
    "X-Taskify-Npub": pubkey,
    "X-Taskify-Timestamp": ts,
    "X-Taskify-Sig": bytesToHex(sigBytes),
  };
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────────

export async function gcalFetch(
  workerBaseUrl: string,
  path: string,
  privkeyHex: string,
  options: RequestInit = {},
): Promise<Response> {
  const body = typeof options.body === "string" ? options.body : "";
  const authHeaders = await signGcalHeaders(privkeyHex, body);
  return fetch(`${workerBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}
