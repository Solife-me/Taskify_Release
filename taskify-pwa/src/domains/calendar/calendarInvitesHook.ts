import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxSender } from "taskify-core";
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  parseCalendarAddress,
  type CalendarRsvpStatus,
} from "../../lib/privateCalendar";
import { kvStorage } from "../../storage/kvStorage";

const LS_CALENDAR_INVITES = "taskify_calendar_invites_v2";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type CalendarInviteStatus = "pending" | "read" | CalendarRsvpStatus | "dismissed";

export type CalendarInvite = {
  id: string;
  source: "dm" | "nostr";
  eventId: string;
  canonical: string;
  view: string;
  eventKey: string;
  inviteToken: string;
  title?: string;
  start?: string;
  end?: string;
  relays?: string[];
  sender?: InboxSender;
  receivedAt: string;
  status: CalendarInviteStatus;
};

export function useCalendarInvites() {
  const [calendarInvites, setCalendarInvites] = useState<CalendarInvite[]>(loadCalendarInvites);
  const calendarInvitesRef = useRef<CalendarInvite[]>(calendarInvites);
  const calendarInvitesFirstRun = useRef(true);

  useEffect(() => {
    calendarInvitesRef.current = calendarInvites;
    if (calendarInvitesFirstRun.current) {
      calendarInvitesFirstRun.current = false;
      return;
    }
    try {
      kvStorage.setItem(LS_CALENDAR_INVITES, JSON.stringify(calendarInvites));
    } catch {}
  }, [calendarInvites]);

  const pendingCalendarInvites = useMemo(
    () => calendarInvites.filter((invite) => invite.status === "pending" || invite.status === "read"),
    [calendarInvites],
  );
  const unreadCalendarInviteCount = useMemo(
    () => calendarInvites.filter((invite) => invite.status === "pending").length,
    [calendarInvites],
  );
  const formatCalendarInviteWhen = useCallback((invite: CalendarInvite): string => {
    const startRaw = invite.start?.trim() || "";
    const endRaw = invite.end?.trim() || "";
    if (!startRaw) return "";

    const formatDateLabel = (dateKey: string): string => {
      const parsed = new Date(`${dateKey}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) return dateKey;
      return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    };

    const formatTimeLabel = (date: Date): string => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    if (ISO_DATE_PATTERN.test(startRaw)) {
      const startLabel = formatDateLabel(startRaw);
      if (!endRaw || !ISO_DATE_PATTERN.test(endRaw)) return startLabel;
      const endLabel = formatDateLabel(endRaw);
      return `${startLabel} – ${endLabel}`;
    }

    const startDate = new Date(startRaw);
    if (Number.isNaN(startDate.getTime())) return startRaw;
    const dateLabel = startDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const startTimeLabel = formatTimeLabel(startDate);

    if (!endRaw) return `${dateLabel} • ${startTimeLabel}`;
    const endDate = new Date(endRaw);
    if (Number.isNaN(endDate.getTime())) return `${dateLabel} • ${startTimeLabel}`;

    const endDateLabel = endDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const endTimeLabel = formatTimeLabel(endDate);
    if (endDateLabel === dateLabel) return `${dateLabel} • ${startTimeLabel} – ${endTimeLabel}`;
    return `${dateLabel} • ${startTimeLabel} – ${endDateLabel} ${endTimeLabel}`;
  }, []);

  return {
    calendarInvites,
    calendarInvitesRef,
    formatCalendarInviteWhen,
    pendingCalendarInvites,
    setCalendarInvites,
    unreadCalendarInviteCount,
  };
}

function loadCalendarInvites(): CalendarInvite[] {
  try {
    const raw = kvStorage.getItem(LS_CALENDAR_INVITES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeCalendarInvite(entry))
      .filter((entry): entry is CalendarInvite => !!entry);
  } catch {
    return [];
  }
}

function normalizeCalendarInvite(entry: unknown): CalendarInvite | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, any>;
  const eventId = typeof raw.eventId === "string" ? raw.eventId.trim() : "";
  const canonical = typeof raw.canonical === "string" ? raw.canonical.trim() : "";
  const view = typeof raw.view === "string" ? raw.view.trim() : "";
  const eventKey = typeof raw.eventKey === "string" ? raw.eventKey.trim() : "";
  const inviteToken = typeof raw.inviteToken === "string" ? raw.inviteToken.trim() : "";
  if (!eventId || !canonical || !view || !eventKey || !inviteToken) return null;
  const canonicalParsed = parseCalendarAddress(canonical);
  const viewParsed = parseCalendarAddress(view);
  if (!canonicalParsed || !viewParsed) return null;
  if (canonicalParsed.kind !== TASKIFY_CALENDAR_EVENT_KIND || viewParsed.kind !== TASKIFY_CALENDAR_VIEW_KIND) return null;
  if (canonicalParsed.d !== eventId || viewParsed.d !== eventId) return null;
  if (canonicalParsed.pubkey !== viewParsed.pubkey) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : canonical;
  if (!id) return null;
  const source = raw.source === "nostr" ? "nostr" : "dm";
  const status = normalizeCalendarInviteStatus(raw.status);
  const receivedAt = typeof raw.receivedAt === "string" ? raw.receivedAt : "";
  const sender = normalizeCalendarInviteSender(raw.sender);
  const relays = Array.isArray(raw.relays)
    ? raw.relays
        .map((relay: unknown) => (typeof relay === "string" ? relay.trim() : ""))
        .filter(Boolean)
    : undefined;
  return {
    id,
    source,
    eventId,
    canonical,
    view,
    eventKey,
    inviteToken,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined,
    start: typeof raw.start === "string" && raw.start.trim() ? raw.start.trim() : undefined,
    end: typeof raw.end === "string" && raw.end.trim() ? raw.end.trim() : undefined,
    relays: relays?.length ? relays : undefined,
    sender,
    receivedAt: receivedAt.trim() ? receivedAt : new Date().toISOString(),
    status,
  };
}

function normalizeCalendarInviteStatus(statusRaw: unknown): CalendarInviteStatus {
  if (statusRaw === "accepted" || statusRaw === "declined" || statusRaw === "tentative") {
    return statusRaw;
  }
  return statusRaw === "dismissed" ? "dismissed" : "pending";
}

function normalizeCalendarInviteSender(senderObj: unknown): InboxSender | undefined {
  if (!senderObj || typeof senderObj !== "object") return undefined;
  const sender = senderObj as Record<string, unknown>;
  if (typeof sender.pubkey !== "string" || !sender.pubkey.trim()) return undefined;
  return {
    pubkey: sender.pubkey.trim(),
    name: typeof sender.name === "string" && sender.name.trim() ? sender.name.trim() : undefined,
    npub: typeof sender.npub === "string" && sender.npub.trim() ? sender.npub.trim() : undefined,
  };
}
