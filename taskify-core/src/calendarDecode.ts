import { normalizeCalendarEventPayload } from "./calendarPayload.js";
import { normalizeTaskRecurrence } from "./shareContracts.js";
import type { Recurrence } from "./taskContracts.js";

export type CalendarRsvpStatus = "accepted" | "declined" | "tentative";
export type CalendarRsvpFb = "free" | "busy";

export type CalendarParticipant = {
  pubkey: string;
  relay?: string;
  role?: string;
};

export type CalendarCanonicalPayload = {
  v: 1;
  eventId: string;
  eventKey: string;
  createdBy?: string;
  lastEditedBy?: string;
  kind?: "date" | "time";
  title?: string;
  summary?: string;
  description?: string;
  documents?: unknown[];
  image?: string;
  locations?: string[];
  geohash?: string;
  participants?: CalendarParticipant[];
  hashtags?: string[];
  references?: string[];
  startDate?: string;
  endDate?: string;
  startISO?: string;
  endISO?: string;
  startTzid?: string;
  endTzid?: string;
  inviteTokens?: Record<string, string>;
  recurrence?: Recurrence;
  seriesId?: string;
  deleted?: boolean;
};

export type CalendarViewPayload = {
  v: 1;
  eventId: string;
  createdBy?: string;
  lastEditedBy?: string;
  kind?: "date" | "time";
  title?: string;
  summary?: string;
  description?: string;
  documents?: unknown[];
  image?: string;
  locations?: string[];
  geohash?: string;
  hashtags?: string[];
  references?: string[];
  startDate?: string;
  endDate?: string;
  startISO?: string;
  endISO?: string;
  startTzid?: string;
  endTzid?: string;
  recurrence?: Recurrence;
  seriesId?: string;
  deleted?: boolean;
};

export type CalendarRsvpPayload = {
  v: 1;
  eventId: string;
  status: CalendarRsvpStatus;
  inviteToken: string;
  fb?: CalendarRsvpFb;
  note?: string;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePubkey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return out.length ? out : undefined;
}

function normalizeParticipants(value: unknown): CalendarParticipant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CalendarParticipant[] = [];
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const pubkey = normalizeString((entry as any).pubkey);
    if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return;
    const relay = normalizeString((entry as any).relay) || undefined;
    const role = normalizeString((entry as any).role) || undefined;
    out.push({ pubkey: pubkey.toLowerCase(), ...(relay ? { relay } : {}), ...(role ? { role } : {}) });
  });
  return out.length ? out : undefined;
}

function normalizeInviteTokens(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, token]) => {
    if (!/^[0-9a-f]{64}$/i.test(key)) return;
    if (typeof token !== "string" || !token.trim()) return;
    out[key.toLowerCase()] = token.trim();
  });
  return Object.keys(out).length ? out : undefined;
}

export function parseCalendarCanonicalPayload(raw: unknown): CalendarCanonicalPayload | null {
  if (!raw || typeof raw !== "object") return null;
  if ((raw as any).v !== 1) return null;
  const eventId = normalizeString((raw as any).eventId);
  const eventKey = normalizeString((raw as any).eventKey);
  if (!eventId || !eventKey) return null;
  const deleted = (raw as any).deleted === true;
  const kindRaw = (raw as any).kind;
  const kind = kindRaw === "date" || kindRaw === "time" ? kindRaw : undefined;
  const title = normalizeString((raw as any).title);
  if (!deleted) {
    if (!kind || !title) return null;
  }
  const payload: CalendarCanonicalPayload = {
    v: 1,
    eventId,
    eventKey,
    ...(deleted ? { deleted: true } : {}),
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
  };
  const createdBy = normalizePubkey((raw as any).createdBy);
  if (createdBy) payload.createdBy = createdBy;
  const lastEditedBy = normalizePubkey((raw as any).lastEditedBy);
  if (lastEditedBy) payload.lastEditedBy = lastEditedBy;
  const summary = normalizeString((raw as any).summary);
  if (summary) payload.summary = summary;
  const description = normalizeString((raw as any).description);
  if (description) payload.description = description;
  if (Array.isArray((raw as any).documents) && (raw as any).documents.length) payload.documents = (raw as any).documents;
  const image = normalizeString((raw as any).image);
  if (image) payload.image = image;
  const geohash = normalizeString((raw as any).geohash);
  if (geohash) payload.geohash = geohash;
  const locations = normalizeStringArray((raw as any).locations);
  if (locations) payload.locations = locations;
  const hashtags = normalizeStringArray((raw as any).hashtags);
  if (hashtags) payload.hashtags = hashtags;
  const references = normalizeStringArray((raw as any).references);
  if (references) payload.references = references;
  const participants = normalizeParticipants((raw as any).participants);
  if (participants) payload.participants = participants;
  const inviteTokens = normalizeInviteTokens((raw as any).inviteTokens);
  if (inviteTokens) payload.inviteTokens = inviteTokens;
  const recurrence = normalizeTaskRecurrence((raw as any).recurrence) as Recurrence | undefined;
  if (recurrence?.type !== "none") payload.recurrence = recurrence;
  const seriesId = normalizeString((raw as any).seriesId);
  if (seriesId && recurrence?.type !== "none") payload.seriesId = seriesId;

  const core = normalizeCalendarEventPayload(raw);
  if (!core) return null;
  if (core.startDate) payload.startDate = core.startDate;
  if (core.endDate) payload.endDate = core.endDate;
  if (core.startISO) payload.startISO = core.startISO;
  if (core.endISO) payload.endISO = core.endISO;
  if (core.startTzid) payload.startTzid = core.startTzid;
  if (core.endTzid) payload.endTzid = core.endTzid;
  return payload;
}

export function parseCalendarViewPayload(raw: unknown): CalendarViewPayload | null {
  if (!raw || typeof raw !== "object") return null;
  if ((raw as any).v !== 1) return null;
  const eventId = normalizeString((raw as any).eventId);
  if (!eventId) return null;
  const deleted = (raw as any).deleted === true;
  const kindRaw = (raw as any).kind;
  const kind = kindRaw === "date" || kindRaw === "time" ? kindRaw : undefined;
  const title = normalizeString((raw as any).title);
  if (!deleted) {
    if (!kind || !title) return null;
  }
  const payload: CalendarViewPayload = {
    v: 1,
    eventId,
    ...(deleted ? { deleted: true } : {}),
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
  };
  const createdBy = normalizePubkey((raw as any).createdBy);
  if (createdBy) payload.createdBy = createdBy;
  const lastEditedBy = normalizePubkey((raw as any).lastEditedBy);
  if (lastEditedBy) payload.lastEditedBy = lastEditedBy;
  const summary = normalizeString((raw as any).summary);
  if (summary) payload.summary = summary;
  const description = normalizeString((raw as any).description);
  if (description) payload.description = description;
  if (Array.isArray((raw as any).documents) && (raw as any).documents.length) payload.documents = (raw as any).documents;
  const image = normalizeString((raw as any).image);
  if (image) payload.image = image;
  const geohash = normalizeString((raw as any).geohash);
  if (geohash) payload.geohash = geohash;
  const locations = normalizeStringArray((raw as any).locations);
  if (locations) payload.locations = locations;
  const hashtags = normalizeStringArray((raw as any).hashtags);
  if (hashtags) payload.hashtags = hashtags;
  const references = normalizeStringArray((raw as any).references);
  if (references) payload.references = references;
  const recurrence = normalizeTaskRecurrence((raw as any).recurrence) as Recurrence | undefined;
  if (recurrence?.type !== "none") payload.recurrence = recurrence;
  const seriesId = normalizeString((raw as any).seriesId);
  if (seriesId && recurrence?.type !== "none") payload.seriesId = seriesId;

  const core = normalizeCalendarEventPayload(raw);
  if (!core) return null;
  if (core.startDate) payload.startDate = core.startDate;
  if (core.endDate) payload.endDate = core.endDate;
  if (core.startISO) payload.startISO = core.startISO;
  if (core.endISO) payload.endISO = core.endISO;
  if (core.startTzid) payload.startTzid = core.startTzid;
  if (core.endTzid) payload.endTzid = core.endTzid;
  return payload;
}

export function parseCalendarRsvpPayload(raw: unknown): CalendarRsvpPayload | null {
  if (!raw || typeof raw !== "object") return null;
  if ((raw as any).v !== 1) return null;
  const eventId = normalizeString((raw as any).eventId);
  if (!eventId) return null;
  const inviteToken = normalizeString((raw as any).inviteToken);
  if (!inviteToken) return null;
  const statusRaw = (raw as any).status;
  const status =
    statusRaw === "accepted" || statusRaw === "declined" || statusRaw === "tentative"
      ? (statusRaw as CalendarRsvpStatus)
      : null;
  if (!status) return null;
  const payload: CalendarRsvpPayload = { v: 1, eventId, status, inviteToken };
  const fbRaw = (raw as any).fb;
  if (fbRaw === "free" || fbRaw === "busy") payload.fb = fbRaw as CalendarRsvpFb;
  const note = normalizeString((raw as any).note);
  if (note) payload.note = note;
  return payload;
}
