/**
 * The wire format of Taskify calendar events. Each event is published twice: a canonical copy for
 * board members (encrypted to the board, carrying the event key, participants and their invite
 * tokens) and a view copy for invitees (encrypted with the event key, without the board's
 * secrets). iOS and macOS read these shapes, so changes here are protocol changes.
 */
import {
  calendarRecurrenceSyncFields,
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  type TaskDocument,
} from "taskify-core";
// The PWA's normalizer, which also accepts npubs (participants may be stored either way).
import { normalizeAgentPubkey, normalizeNostrPubkeyHex } from "../domains/tasks/assignmentUtils";
import type { Board, CalendarEvent } from "../domains/tasks/taskTypes";
import { generateEventKey, generateInviteToken } from "../lib/privateCalendar";

export type PreparedEventAttachments = { image: string | null; documents: unknown[] | null };

/** Participants plus extra recipients, as unique hex keys in order. */
function invitePubkeys(event: CalendarEvent, extraPubkeys?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...(event.participants ?? []).map((p) => p.pubkey), ...(extraPubkeys ?? [])]) {
    const pubkey = normalizeNostrPubkeyHex(candidate);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

/**
 * The event key and one invite token per invitee, keeping existing ones. `changed` says whether
 * the event must be updated locally before publishing.
 */
export function mergeInviteTokens(event: CalendarEvent, extraPubkeys?: string[]) {
  const eventKey = event.eventKey || generateEventKey();
  const existing = event.inviteTokens ?? {};
  const inviteTokens: Record<string, string> = {};
  for (const pubkey of invitePubkeys(event, extraPubkeys)) {
    inviteTokens[pubkey] = existing[pubkey] || generateInviteToken();
  }
  const existingKeys = Object.keys(existing);
  const nextKeys = Object.keys(inviteTokens);
  const changed =
    eventKey !== event.eventKey ||
    existingKeys.length !== nextKeys.length ||
    nextKeys.some((key) => existing[key] !== inviteTokens[key]);
  return { eventKey, inviteTokens: nextKeys.length ? inviteTokens : undefined, changed };
}

/**
 * One copy of a calendar event's payload. `audience: "board"` is the canonical copy;
 * `"invitees"` is the view copy. A deletion carries only identity, authorship and recurrence
 * fields. Null when the event's dates are invalid.
 */
export function calendarEventPayload(
  event: CalendarEvent,
  options: {
    audience: "board" | "invitees";
    deleted?: boolean;
    actorPubkey?: string | null;
    preparedAttachments?: PreparedEventAttachments;
    now?: number;
  },
): Record<string, unknown> | null {
  const deleted = !!options.deleted;
  const forBoard = options.audience === "board";
  const createdBy = normalizeAgentPubkey(event.createdBy || options.actorPubkey) ?? undefined;
  const lastEditedBy = normalizeAgentPubkey(event.lastEditedBy || options.actorPubkey || createdBy) ?? createdBy;
  const base: Record<string, unknown> = {
    v: 1,
    eventId: event.id,
    ...(forBoard ? { eventKey: event.eventKey || generateEventKey() } : {}),
    ...(deleted ? { deleted: true } : {}),
  };
  if (createdBy) base.createdBy = createdBy;
  if (lastEditedBy) base.lastEditedBy = lastEditedBy;
  Object.assign(base, calendarRecurrenceSyncFields(event));
  const fields = {
    title: event.title || "Untitled",
    kind: event.kind,
    startDate: event.kind === "date" ? event.startDate : undefined,
    endDate: event.kind === "date" ? event.endDate : undefined,
    startISO: event.kind === "time" ? event.startISO : undefined,
    endISO: event.kind === "time" ? event.endISO : undefined,
    startTzid: event.kind === "time" ? event.startTzid : undefined,
    endTzid: event.kind === "time" ? event.endTzid : undefined,
    description: event.description,
  };
  const now = options.now ?? Date.now();
  const normalized = deleted
    ? normalizeCalendarDeleteMutationPayload(fields, now)
    : normalizeCalendarMutationPayload(fields, now);
  if (!normalized) return null;
  if (deleted) return base;

  base.kind = normalized.kind;
  base.title = normalized.title || "Untitled";
  if (event.summary) base.summary = event.summary;
  if (event.description) base.description = event.description;
  if (event.documents?.length) {
    const documents = options.preparedAttachments?.documents ?? event.documents;
    if (documents?.length) base.documents = documents;
  }
  const preparedImage = options.preparedAttachments?.image;
  const image = preparedImage === null || typeof preparedImage === "undefined" ? event.image : preparedImage;
  if (image) base.image = image;
  if (event.locations?.length) base.locations = event.locations;
  if (event.geohash) base.geohash = event.geohash;
  if (forBoard && event.participants?.length) base.participants = event.participants;
  if (event.hashtags?.length) base.hashtags = event.hashtags;
  if (event.references?.length) base.references = event.references;
  if (forBoard && event.inviteTokens && Object.keys(event.inviteTokens).length) base.inviteTokens = event.inviteTokens;

  if (normalized.kind === "date") {
    if (!normalized.startDate) return null;
    base.startDate = normalized.startDate;
    if (normalized.endDate) base.endDate = normalized.endDate;
    return base;
  }
  if (!normalized.startISO) return null;
  base.startISO = normalized.startISO;
  if (normalized.endISO) base.endISO = normalized.endISO;
  if (normalized.startTzid) base.startTzid = normalized.startTzid;
  if (normalized.endTzid) base.endTzid = normalized.endTzid;
  return base;
}

/** Canonical-copy tags: week-board events sit in the `day` column, list events in their list. */
export function calendarEventTags(
  event: Pick<CalendarEvent, "id" | "columnId" | "order">,
  board: Pick<Board, "kind">,
  boardTagValue: string,
): string[][] {
  const tags: string[][] = [["d", event.id], ["b", boardTagValue]];
  const column = board.kind === "week" ? "day" : event.columnId || "";
  if (column) tags.push(["col", column]);
  if (typeof event.order === "number" && Number.isFinite(event.order)) tags.push(["order", String(event.order)]);
  return tags;
}

/** The event as published: uploaded attachments replace local copies; `null` means unchanged. */
export function calendarEventWithPreparedAttachments(event: CalendarEvent, prepared: PreparedEventAttachments): CalendarEvent {
  return {
    ...event,
    ...(prepared.image === null ? {} : { image: prepared.image || undefined }),
    ...(prepared.documents === null
      ? {}
      : { documents: prepared.documents.length ? (prepared.documents as TaskDocument[]) : undefined }),
  };
}
