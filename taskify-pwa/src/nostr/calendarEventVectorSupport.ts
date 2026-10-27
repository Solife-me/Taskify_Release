/**
 * Shared by the calendar event vector check (calendarEventVectors.test.ts) and its generator
 * (scripts/generate-calendar-event-vectors.test.ts). See taskify-core/fixtures/calendar-event-vectors-*.json.
 * Covers what the event cards and editors show, attachments included (C8-5).
 */
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";
import { calendarAddress, parseCalendarCanonicalPayload, TASKIFY_CALENDAR_EVENT_KIND, TASKIFY_CALENDAR_VIEW_KIND } from "taskify-core";
import type { Board, CalendarEvent } from "../domains/tasks/taskTypes";
import { deriveBoardNostrKeys } from "../domains/nostr/nostrKeyUtils";
import { boardTag } from "../boardCrypto";
import { decryptCalendarPayloadForBoard, encryptCalendarPayloadForBoard } from "../lib/privateCalendar";
import { calendarEventPayload, calendarEventTags } from "./calendarWire";
import { parseCalendarEvent } from "./calendarEventMerge";
import { VECTOR_BOARDS, type VectorDocument } from "./taskEventVectorSupport";

export type CalendarExpected = {
  id: string;
  title: string;
  /** "date" events: the day; "time" events: epoch seconds of the start. */
  start: string;
  image: string | null;
  documents: VectorDocument[] | null;
};

export type CalendarVector = { name: string; board: "lists" | "week"; event: Event; expected: CalendarExpected };

export async function decodeCalendarWithPwa(event: Event, board: Board): Promise<CalendarExpected> {
  const boardId = board.nostr!.boardId;
  const keys = await deriveBoardNostrKeys(boardId);
  const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
  if (event.pubkey !== keys.pk) throw new Error("not signed by the board key");
  if (tag("b") !== boardTag(boardId)) throw new Error("wrong board tag");
  if (!verifyEvent({ ...event })) throw new Error("bad signature");
  const payload = parseCalendarCanonicalPayload(await decryptCalendarPayloadForBoard(event.content, keys.skHex, keys.pk));
  if (!payload) throw new Error("unreadable payload");
  const eventId = tag("d")!;
  const parsed = parseCalendarEvent(
    payload,
    {
      eventId,
      column: tag("col"),
      order: tag("order"),
      canonicalAddress: calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, keys.pk, eventId),
      viewAddress: calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, keys.pk, eventId),
    },
    board,
  );
  if (!parsed) throw new Error("event not parsed");
  return {
    id: parsed.id,
    title: parsed.title,
    start: parsed.kind === "date" ? parsed.startDate : String(Math.floor(Date.parse(parsed.startISO) / 1000)),
    image: parsed.image ?? null,
    documents: parsed.documents?.length
      ? parsed.documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          mimeType: doc.mimeType,
          kind: doc.kind,
          remoteUrl: doc.remoteUrl ?? null,
          encrypted: doc.encrypted === true,
        }))
      : null,
  };
}

export async function pwaCalendarEvent(event: CalendarEvent, board: Board, createdAt: number): Promise<Event> {
  const boardId = board.nostr!.boardId;
  const keys = await deriveBoardNostrKeys(boardId);
  const payload = calendarEventPayload(event, { audience: "board", now: createdAt * 1000 });
  if (!payload) throw new Error("invalid event");
  const content = await encryptCalendarPayloadForBoard(payload, keys.skHex, keys.pk);
  return finalizeEvent(
    { kind: TASKIFY_CALENDAR_EVENT_KIND, created_at: createdAt, tags: calendarEventTags(event, board, boardTag(boardId)), content },
    keys.sk,
  );
}

const uploaded = (id: string, name: string, mimeType: string, kind: string) => ({
  id,
  name,
  mimeType,
  kind,
  dataUrl: "",
  createdAt: "2026-10-18T09:00:00.000Z",
  remoteUrl: `https://files.example/${id}.bin`,
  encrypted: true,
  encryptionBoardId: "taskify-vector-lists-board",
});

export const CALENDAR_CASES: Array<{ name: string; board: "lists" | "week"; event: CalendarEvent; expected: CalendarExpected }> = [
  {
    name: "timed event with an image and documents",
    board: "lists",
    event: {
      id: "cal-docs", boardId: "lists", columnId: "c1", kind: "time", title: "Closing meeting",
      startISO: "2026-10-27T15:00:00.000Z", endISO: "2026-10-27T16:00:00.000Z", startTzid: "America/Chicago",
      image: "https://files.example/cal-image.bin",
      documents: [uploaded("cal-doc-1", "Agenda.pdf", "application/pdf", "pdf"), uploaded("cal-doc-2", "Venue.png", "image/png", "png")],
    } as CalendarEvent,
    expected: {
      id: "cal-docs", title: "Closing meeting", start: "1793113200", image: "https://files.example/cal-image.bin",
      documents: [
        { id: "cal-doc-1", name: "Agenda.pdf", mimeType: "application/pdf", kind: "pdf", remoteUrl: "https://files.example/cal-doc-1.bin", encrypted: true },
        { id: "cal-doc-2", name: "Venue.png", mimeType: "image/png", kind: "png", remoteUrl: "https://files.example/cal-doc-2.bin", encrypted: true },
      ],
    },
  },
  {
    name: "all-day event without attachments",
    board: "week",
    event: { id: "cal-plain", boardId: "week", kind: "date", title: "Holiday", startDate: "2026-11-11" } as CalendarEvent,
    expected: { id: "cal-plain", title: "Holiday", start: "2026-11-11", image: null, documents: null },
  },
];

export { VECTOR_BOARDS };
