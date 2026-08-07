import type { CalendarEvent } from "taskify-core";
import { isoDatePart } from "../dateTime/dateUtils";

export const CALENDAR_SERIES_CUTOFFS_KEY = "taskify_calendar_series_cutoffs_v1";

/** Board id → stable event series id → last permitted occurrence ISO. */
export type CalendarSeriesCutoffs = Record<string, Record<string, string>>;

function normalizedISO(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function safeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key === "__proto__" || key === "prototype" || key === "constructor") return null;
  return key;
}

export function parseCalendarSeriesCutoffs(value: unknown): CalendarSeriesCutoffs {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: CalendarSeriesCutoffs = {};
  for (const [rawBoardID, rawSeries] of Object.entries(parsed as Record<string, unknown>)) {
    const boardID = safeKey(rawBoardID);
    if (!boardID || !rawSeries || typeof rawSeries !== "object" || Array.isArray(rawSeries)) continue;
    const series: Record<string, string> = {};
    for (const [rawSeriesID, rawCutoff] of Object.entries(rawSeries as Record<string, unknown>)) {
      const seriesID = safeKey(rawSeriesID);
      const cutoff = normalizedISO(rawCutoff);
      if (seriesID && cutoff) series[seriesID] = cutoff;
    }
    if (Object.keys(series).length) result[boardID] = series;
  }
  return result;
}

export function serializeCalendarSeriesCutoffs(value: CalendarSeriesCutoffs): string {
  return JSON.stringify(parseCalendarSeriesCutoffs(value));
}

export function updateCalendarSeriesCutoff(
  current: CalendarSeriesCutoffs,
  boardIDValue: string,
  seriesIDValue: string,
  cutoffValue: string,
): CalendarSeriesCutoffs {
  const boardID = safeKey(boardIDValue);
  const seriesID = safeKey(seriesIDValue);
  const cutoff = normalizedISO(cutoffValue);
  if (!boardID || !seriesID || !cutoff) return current;
  const existing = normalizedISO(current[boardID]?.[seriesID]);
  if (existing && Date.parse(existing) <= Date.parse(cutoff)) return current;
  return {
    ...current,
    [boardID]: {
      ...(current[boardID] ?? {}),
      [seriesID]: cutoff,
    },
  };
}

function occurrenceDateKey(event: CalendarEvent): string | null {
  if (event.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(event.startDate) ? event.startDate : null;
  if (Number.isNaN(Date.parse(event.startISO))) return null;
  return isoDatePart(event.startISO, event.startTzid);
}

function cutoffDateKey(event: CalendarEvent, cutoffISO: string): string | null {
  if (Number.isNaN(Date.parse(cutoffISO))) return null;
  return isoDatePart(cutoffISO, event.kind === "time" ? event.startTzid : "UTC");
}

export function applyCalendarSeriesCutoff<TEvent extends CalendarEvent>(
  event: TEvent,
  cutoffs: CalendarSeriesCutoffs,
): TEvent | null {
  if (!event.recurrence || !event.seriesId) return event;
  const cutoff = normalizedISO(cutoffs[event.boardId]?.[event.seriesId]);
  if (!cutoff) return event;
  const occurrenceKey = occurrenceDateKey(event);
  const cutoffKey = cutoffDateKey(event, cutoff);
  if (occurrenceKey && cutoffKey && occurrenceKey > cutoffKey) return null;

  const existingUntil = normalizedISO(event.recurrence.untilISO);
  const effectiveUntil =
    existingUntil && Date.parse(existingUntil) <= Date.parse(cutoff) ? existingUntil : cutoff;
  if (event.recurrence.untilISO === effectiveUntil) return event;
  return {
    ...event,
    recurrence: { ...event.recurrence, untilISO: effectiveUntil },
  };
}

export function applyCalendarSeriesCutoffs<TEvent extends CalendarEvent>(
  events: TEvent[],
  cutoffs: CalendarSeriesCutoffs,
): TEvent[] {
  const next: TEvent[] = [];
  let changed = false;
  for (const event of events) {
    const bounded = applyCalendarSeriesCutoff(event, cutoffs);
    if (!bounded) {
      changed = true;
      continue;
    }
    if (bounded !== event) changed = true;
    next.push(bounded);
  }
  return changed ? next : events;
}
