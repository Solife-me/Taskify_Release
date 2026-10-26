import { type NDKEvent } from "@nostr-dev-kit/ndk";
import { deriveBoardKeyPair } from "taskify-runtime-nostr";
import {
  parseCalendarCanonicalPayload,
  readStatusTag,
  readTagValue,
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
} from "taskify-core";
import { decryptCalendarPayloadForBoard } from "../calendarCrypto.js";
import { sanitizeRemote } from "../shared/displaySafe.js";
import type { ReminderPreset, Recurrence } from "../shared/taskTypes.js";
import type { DecryptedPayload } from "./context.js";

/** Calendar records: how a board's kind 30310 copy of an event becomes a `FullEventRecord`. */

/** What an invitation to a calendar event carries (`buildCalendarEventInviteEnvelope`). */
export type EventInvitation = {
  event: FullEventRecord;
  /** The board copy's and the invitees' copy's addresses, under the board's key. */
  canonical: string;
  view: string;
  inviteToken: string;
  /** The board's relays, where the event is published. */
  relays: string[];
};

export type FullEventRecord = {
  id: string;
  boardId: string;
  boardName?: string;
  eventKey: string;
  createdBy?: string;
  lastEditedBy?: string;
  inviteTokens?: Record<string, string>;
  title: string;
  summary?: string;
  image?: string;
  locations?: string[];
  geohash?: string;
  hashtags?: string[];
  references?: string[];
  kind: "date" | "time";
  startDate?: string;
  endDate?: string;
  startISO?: string;
  endISO?: string;
  startTzid?: string;
  endTzid?: string;
  description?: string;
  recurrence?: Recurrence;
  reminders?: ReminderPreset[];
  participants?: Array<{ pubkey: string; relay?: string; role?: string }>;
  documents?: Record<string, unknown>[];
  columnId?: string;
  rsvpStatus?: "accepted" | "declined" | "tentative";
  rsvpCreatedAt?: number;
  createdAt?: number;
  updatedAt?: string;
  deleted?: boolean;
};

export function validateCalendarEventCompat(event: NDKEvent): boolean {
  if (event.kind !== TASKIFY_CALENDAR_EVENT_KIND) return false;
  const hasD = event.tags.some((t) => t[0] === "d");
  const hasB = event.tags.some((t) => t[0] === "b");
  if (!hasD || !hasB) return false;
  if (!event.content) return false;
  return true;
}

export async function decryptCalendarEventPayload(event: NDKEvent, boardId: string): Promise<DecryptedPayload | null> {
  try {
    const boardKeys = deriveBoardKeyPair(boardId);
    return await decryptCalendarPayloadForBoard(event.content, boardKeys.skHex, boardKeys.pk) as DecryptedPayload;
  } catch {
    return null;
  }
}

export async function parseDecryptedCalendarEvent(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullEventRecord | null> {
  return sanitizeRemote(await parseDecryptedCalendarEventUnsafe(event, boardId, boardName));
}

async function parseDecryptedCalendarEventUnsafe(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullEventRecord | null> {
  if (!validateCalendarEventCompat(event)) return null;
  if (event.pubkey !== deriveBoardKeyPair(boardId).pk) return null;
  const statusVal = readStatusTag(event.tags, "open");
  const entityTag = readTagValue(event.tags, "entity");
  try {
    const raw = await decryptCalendarEventPayload(event, boardId);
    if (!raw) return null;

    const id = readTagValue(event.tags, "d") ?? "";
    if (!id) return null;

    const inferredEvent =
      event.kind === TASKIFY_CALENDAR_EVENT_KIND ||
      event.kind === TASKIFY_CALENDAR_VIEW_KIND ||
      entityTag === "event" ||
      raw.kind === "date" ||
      raw.kind === "time" ||
      typeof raw.startDate === "string" ||
      typeof raw.startISO === "string";
    if (!inferredEvent) return null;

    const payload = parseCalendarCanonicalPayload(raw);
    if (!payload || payload.eventId !== id) return null;
    const kind = payload.kind === "time" ? "time" : "date";

    return {
      id,
      boardId,
      boardName,
      eventKey: payload.eventKey,
      createdBy: payload.createdBy,
      lastEditedBy: payload.lastEditedBy,
      inviteTokens: payload.inviteTokens,
      title: payload.title ?? "",
      summary: payload.summary,
      image: payload.image,
      locations: payload.locations,
      geohash: payload.geohash,
      hashtags: payload.hashtags,
      references: payload.references,
      kind,
      startDate: payload.startDate,
      endDate: payload.endDate,
      startISO: payload.startISO,
      endISO: payload.endISO,
      startTzid: payload.startTzid,
      endTzid: payload.endTzid,
      description: payload.description,
      // Access extra fields from raw (not included in CalendarNormalizedPayload)
      recurrence: raw.recurrence as Recurrence | undefined,
      reminders: raw.reminders as ReminderPreset[] | undefined,
      participants: Array.isArray(raw.participants) ? raw.participants as Array<{ pubkey: string; relay?: string; role?: string }> : undefined,
      documents: Array.isArray(raw.documents) ? raw.documents as Record<string, unknown>[] : undefined,
      columnId: (readTagValue(event.tags, "col") || undefined),
      rsvpStatus: raw.rsvpStatus as "accepted" | "declined" | "tentative" | undefined,
      rsvpCreatedAt: typeof raw.rsvpCreatedAt === "number" ? raw.rsvpCreatedAt : undefined,
      createdAt: event.created_at,
      updatedAt: event.created_at ? new Date(event.created_at * 1000).toISOString() : undefined,
      deleted: statusVal === "deleted" || payload.deleted === true,
    };
  } catch {
    return null;
  }
}
