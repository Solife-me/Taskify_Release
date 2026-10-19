/**
 * The event editor's form, without React: where its schedule starts for an event, and the event
 * it saves. Like the task editor, an untouched start or end keeps its exact instant, so opening
 * and saving an event does not rewrite its times.
 */
import {
  isListLikeBoard,
  normalizeCalendarEventPayload,
  normalizeDelimitedValues,
  normalizeLocationList,
} from "taskify-core";
import { currentTimeValue, isoDatePart, isoFromDateTime, isoTimePart, normalizeTimeZone } from "../dateTime/dateUtils";
import { DEFAULT_DATE_REMINDER_TIME, normalizeReminderTime } from "../dateTime/reminderUtils";
import { ensureDocumentPreview, type TaskDocument } from "../../lib/documents";
import type {
  Board,
  CalendarEvent,
  CalendarEventBase,
  CalendarEventParticipant,
  Recurrence,
  ReminderPreset,
} from "../tasks/taskTypes";

const HOUR_MS = 60 * 60 * 1000;

export type EventEditorStart = {
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  startTzid: string;
  endTzid: string;
  reminderTime: string;
};

export function eventEditorStart(event: CalendarEvent, systemTimeZone: string): EventEditorStart {
  const reminderTime = normalizeReminderTime(event.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
  if (event.kind === "date") {
    return {
      allDay: true,
      startDate: event.startDate,
      endDate: event.endDate || event.startDate,
      // An all-day event has no times; the pickers open at the next hours.
      startTime: currentTimeValue(0, systemTimeZone),
      endTime: currentTimeValue(60, systemTimeZone),
      startTzid: systemTimeZone,
      endTzid: systemTimeZone,
      reminderTime,
    };
  }
  const startTzid = normalizeTimeZone(event.startTzid) ?? systemTimeZone;
  const endTzid = normalizeTimeZone(event.endTzid) ?? startTzid;
  const startMs = Date.parse(event.startISO);
  // Without an end, an event lasts an hour.
  const endISO = event.endISO ?? (Number.isNaN(startMs) ? undefined : new Date(startMs + HOUR_MS).toISOString());
  const startDate = isoDatePart(event.startISO, startTzid);
  return {
    allDay: false,
    startDate,
    endDate: endISO ? isoDatePart(endISO, endTzid) : startDate,
    startTime: isoTimePart(event.startISO, startTzid),
    endTime: endISO ? isoTimePart(endISO, endTzid) : currentTimeValue(60, startTzid),
    startTzid,
    endTzid,
    reminderTime,
  };
}

export type EventEditorDraft = {
  title: string;
  description: string;
  documents: TaskDocument[];
  image: string;
  locations: string[];
  geohash: string;
  /** Already validated and de-duplicated. */
  participants: CalendarEventParticipant[];
  hashtagsText: string;
  referencesText: string;
  reminders: ReminderPreset[];
  reminderTime: string;
  rule: Recurrence;
  boardId: string;
  board: Board | null;
  columnId: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  startTzid: string;
  endTzid: string;
};

/** The instant for a date and time, or `kept` when they and the zone are what the event had. */
function instant(
  date: string,
  time: string,
  zone: string,
  start: { date: string; time: string; zone: string; iso: string | undefined },
): string {
  if (start.iso && date === start.date && time === start.time && zone === start.zone) return start.iso;
  return isoFromDateTime(date, time, zone);
}

export function buildEventFromEditor(
  event: CalendarEvent,
  start: EventEditorStart,
  draft: EventEditorDraft,
  systemTimeZone: string,
): CalendarEvent {
  const title = draft.title.trim() || "Untitled";
  const description = draft.description.trim();
  const summary = (description || (event.summary || "").trim()).trim();
  const documents = draft.documents.map(ensureDocumentPreview);
  const image = draft.image.trim();
  const geohash = draft.geohash.trim();
  const locations = normalizeLocationList(draft.locations);
  const hashtags = normalizeDelimitedValues(draft.hashtagsText, /[,\n]+/g, { stripPrefix: "#" });
  const references = normalizeDelimitedValues(draft.referencesText, /\n+/g);
  const columnId = draft.board && isListLikeBoard(draft.board) ? draft.columnId || undefined : undefined;

  const base: CalendarEventBase = {
    id: event.id,
    boardId: draft.boardId,
    columnId,
    order: event.order,
    title,
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(documents.length ? { documents } : {}),
    ...(image ? { image } : {}),
    ...(locations ? { locations } : {}),
    ...(geohash ? { geohash } : {}),
    ...(draft.participants.length ? { participants: draft.participants } : {}),
    ...(hashtags ? { hashtags } : {}),
    ...(references ? { references } : {}),
    ...(draft.reminders.length ? { reminders: draft.reminders.slice() } : {}),
    ...(draft.allDay ? { reminderTime: normalizeReminderTime(draft.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME } : {}),
    ...(draft.rule.type !== "none" ? { recurrence: draft.rule, seriesId: event.seriesId || event.id } : {}),
    ...(event.readOnly ? { readOnly: true } : {}),
    ...(event.originBoardId ? { originBoardId: event.originBoardId } : {}),
    ...(event.eventKey ? { eventKey: event.eventKey } : {}),
    ...(event.inviteTokens ? { inviteTokens: event.inviteTokens } : {}),
    ...(event.canonicalAddress ? { canonicalAddress: event.canonicalAddress } : {}),
    ...(event.viewAddress ? { viewAddress: event.viewAddress } : {}),
    ...(event.inviteToken ? { inviteToken: event.inviteToken } : {}),
    ...(event.inviteRelays ? { inviteRelays: event.inviteRelays } : {}),
  };

  if (draft.allDay) {
    const core = normalizeCalendarEventPayload({ kind: "date", title, startDate: draft.startDate, endDate: draft.endDate });
    if (!core) return { ...base, kind: "date", startDate: draft.startDate } as CalendarEvent;
    return {
      ...base,
      kind: "date",
      startDate: core.startDate || draft.startDate,
      ...(core.endDate ? { endDate: core.endDate } : {}),
    } as CalendarEvent;
  }

  const startTzid = normalizeTimeZone(draft.startTzid) ?? systemTimeZone;
  const endTzid = normalizeTimeZone(draft.endTzid) ?? startTzid;
  const wasTimed = event.kind === "time";
  const startISO = instant(draft.startDate, draft.startTime || "09:00", startTzid, {
    date: start.startDate,
    time: start.startTime,
    zone: start.startTzid,
    iso: wasTimed ? event.startISO : undefined,
  });
  const endISO = instant(draft.endDate || draft.startDate, draft.endTime || "10:00", endTzid, {
    date: start.endDate,
    time: start.endTime,
    zone: start.endTzid,
    iso: wasTimed ? event.endISO : undefined,
  });

  const core = normalizeCalendarEventPayload({ kind: "time", title, startISO, endISO, startTzid, endTzid });
  if (!core) {
    return { ...base, kind: "time", startISO, startTzid, endTzid } as CalendarEvent;
  }
  return {
    ...base,
    kind: "time",
    startISO: core.startISO || startISO,
    ...(core.endISO ? { endISO: core.endISO } : {}),
    ...(core.startTzid ? { startTzid: core.startTzid } : {}),
    ...(core.endTzid ? { endTzid: core.endTzid } : {}),
  } as CalendarEvent;
}
