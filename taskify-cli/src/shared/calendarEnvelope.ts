import {
  parseCalendarCanonicalPayload,
  parseCalendarViewPayload,
  type CalendarCanonicalPayload,
  type CalendarViewPayload,
} from "taskify-core";

export type CalendarEnvelopeExtras = Record<string, unknown>;

/** Build and validate the canonical v1 payload consumed by Taskify's PWA. */
export function buildCalendarCanonicalEnvelope(
  eventId: string,
  eventKey: string,
  payload: CalendarEnvelopeExtras,
): CalendarCanonicalPayload & CalendarEnvelopeExtras {
  const candidate = {
    ...payload,
    v: 1 as const,
    eventId: eventId.trim(),
    eventKey: eventKey.trim(),
  };
  if (!parseCalendarCanonicalPayload(candidate)) {
    throw new Error("Invalid canonical calendar event payload.");
  }
  return candidate;
}

/** Create the event-key-encrypted view payload without board-only secrets. */
export function buildCalendarViewEnvelope(
  canonical: CalendarCanonicalPayload & CalendarEnvelopeExtras,
): CalendarViewPayload & CalendarEnvelopeExtras {
  const {
    eventKey: _eventKey,
    inviteTokens: _inviteTokens,
    participants: _participants,
    ...view
  } = canonical;
  if (!parseCalendarViewPayload(view)) {
    throw new Error("Invalid calendar view payload.");
  }
  return view;
}
