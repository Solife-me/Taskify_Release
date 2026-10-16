/**
 * Reading a shared calendar event (the board's canonical copy, kind 30310) into the local list:
 * parsing the decrypted payload and merging it over the local copy. Pure; the counterpart of
 * `calendarWire.calendarEventPayload`.
 */
import { ISO_DATE_PATTERN, isListLikeBoard, type parseCalendarCanonicalPayload } from "taskify-core";
import { normalizeTimeZone } from "../domains/dateTime/dateUtils";
import { normalizeAgentPubkey } from "../domains/tasks/assignmentUtils";
import { applyHiddenForCalendarEvent } from "../domains/tasks/boardUtils";
import type { Board, CalendarEvent, CalendarEventBase, Weekday } from "../domains/tasks/taskTypes";
import { ensureDocumentPreview, normalizeDocumentList } from "../lib/documents";

export type CanonicalCalendarPayload = NonNullable<ReturnType<typeof parseCalendarCanonicalPayload>>;

/** The event a live (not deleted) canonical payload describes on local board `board`, or null if invalid. */
export function parseCalendarEvent(
  payload: CanonicalCalendarPayload,
  event: { eventId: string; column?: string; order?: string; canonicalAddress: string; viewAddress: string },
  board: Board,
): CalendarEvent | null {
  const order = event.order && Number.isFinite(Number(event.order)) ? Number(event.order) : undefined;
  const documents = normalizeDocumentList(payload.documents);
  const createdBy = normalizeAgentPubkey(payload.createdBy);
  const lastEditedBy = normalizeAgentPubkey(payload.lastEditedBy) ?? createdBy;
  const common: Omit<CalendarEventBase, "kind"> = {
    id: event.eventId,
    boardId: board.id,
    ...(createdBy ? { createdBy } : {}),
    ...(lastEditedBy ? { lastEditedBy } : {}),
    columnId: isListLikeBoard(board)
      ? event.column || (board.kind === "lists" ? board.columns[0]?.id : undefined)
      : undefined,
    order,
    title: payload.title || "Untitled",
    summary: payload.summary,
    description: payload.description || "",
    documents: documents ? documents.map(ensureDocumentPreview) : undefined,
    image: payload.image,
    locations: payload.locations?.length ? payload.locations : undefined,
    geohash: payload.geohash,
    participants: payload.participants?.length
      ? payload.participants.map((p) => ({ pubkey: p.pubkey, relay: p.relay, role: p.role }))
      : undefined,
    hashtags: payload.hashtags?.length ? payload.hashtags : undefined,
    references: payload.references?.length ? payload.references : undefined,
    eventKey: payload.eventKey,
    inviteTokens: payload.inviteTokens,
    recurrence: payload.recurrence,
    seriesId: payload.seriesId,
    canonicalAddress: event.canonicalAddress,
    viewAddress: event.viewAddress,
  };
  if (payload.kind === "date") {
    if (!payload.startDate || !ISO_DATE_PATTERN.test(payload.startDate)) return null;
    const startDate = payload.startDate;
    const endDate = payload.endDate && ISO_DATE_PATTERN.test(payload.endDate) && payload.endDate >= startDate
      ? payload.endDate
      : undefined;
    return { ...common, kind: "date", startDate, ...(endDate ? { endDate } : {}) };
  }
  if (payload.kind !== "time") return null;
  const startISO = payload.startISO || "";
  const startMs = Date.parse(startISO);
  if (!startISO || Number.isNaN(startMs)) return null;
  const endISO = payload.endISO && Date.parse(payload.endISO) > startMs ? payload.endISO : undefined;
  const startTzid = normalizeTimeZone(payload.startTzid) ?? undefined;
  const endTzid = normalizeTimeZone(payload.endTzid) ?? undefined;
  return {
    ...common,
    kind: "time",
    startISO,
    ...(endISO ? { endISO } : {}),
    ...(startTzid ? { startTzid } : {}),
    ...(endTzid ? { endTzid } : {}),
  };
}

/**
 * The local event after an incoming version. Device-local fields (reminders, hidden-until, order
 * when the event carries none) and anything the incoming version leaves out are kept; a new event
 * is hidden until its week like a locally created one.
 */
export function mergeIncomingCalendarEvent(
  existing: CalendarEvent | null | undefined,
  incoming: CalendarEvent,
  context: { weekStart: Weekday; boardKind: Board["kind"] },
): CalendarEvent {
  const merged = {
    ...incoming,
    ...(existing?.createdBy && !incoming.createdBy ? { createdBy: existing.createdBy } : {}),
    ...(existing?.lastEditedBy && !incoming.lastEditedBy ? { lastEditedBy: existing.lastEditedBy } : {}),
    ...(Array.isArray(existing?.reminders) && existing.reminders.length ? { reminders: existing.reminders } : {}),
    ...(existing?.reminderTime ? { reminderTime: existing.reminderTime } : {}),
    ...(!incoming.recurrence && existing?.recurrence ? { recurrence: existing.recurrence } : {}),
    ...(!incoming.seriesId && existing?.seriesId ? { seriesId: existing.seriesId } : {}),
    ...(existing?.hiddenUntilISO ? { hiddenUntilISO: existing.hiddenUntilISO } : {}),
    ...(typeof existing?.order === "number" && typeof incoming.order !== "number" ? { order: existing.order } : {}),
  } as CalendarEvent;
  return existing ? merged : applyHiddenForCalendarEvent(merged, context.weekStart, context.boardKind);
}
