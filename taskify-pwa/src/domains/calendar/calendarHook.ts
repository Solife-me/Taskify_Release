import { useState } from "react";
import type { CalendarEvent, CalendarEventParticipant, CalendarEventBase, DateCalendarEvent, TimeCalendarEvent, Recurrence } from "../tasks/taskTypes";
import { parseCalendarAddress, type CalendarRsvpStatus, type CalendarRsvpFb } from "../../lib/privateCalendar";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_TASKS } from "../../storage/taskifyDb";
import { LS_CALENDAR_EVENTS, LS_EXTERNAL_CALENDAR_EVENTS } from "../storageKeys";
import { calendarEventEntityStore, externalCalendarEventEntityStore } from "../../storage/entityStore";
import { ensureDocumentPreview, normalizeDocumentList } from "../../lib/documents";
import { sanitizeReminderList, normalizeReminderTime } from "../dateTime/reminderUtils";
import { normalizeAgentPubkey, normalizeNostrPubkeyHex } from "../tasks/assignmentUtils";

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

export function useCalendarEvents() {
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    const normalizeStringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const out = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
      return out.length ? out : undefined;
    };

    const normalizeParticipants = (value: unknown): CalendarEventParticipant[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const out: CalendarEventParticipant[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const pubkey = typeof (entry as any).pubkey === "string" ? (entry as any).pubkey.trim() : "";
        if (!pubkey) continue;
        const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
        const role = typeof (entry as any).role === "string" ? (entry as any).role.trim() : "";
        out.push({ pubkey, relay: relay || undefined, role: role || undefined });
      }
      return out.length ? out : undefined;
    };

    const normalizeInviteTokens = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const out: Record<string, string> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        out[key] = trimmed;
      }
      return Object.keys(out).length ? out : undefined;
    };

    const normalizeRsvpStatus = (value: unknown): CalendarRsvpStatus | undefined => {
      if (value === "accepted" || value === "declined" || value === "tentative") return value;
      return undefined;
    };

    const normalizeRsvpFb = (value: unknown): CalendarRsvpFb | undefined => {
      if (value === "free" || value === "busy") return value;
      return undefined;
    };

    const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

    const loadStored = (key: string): any[] => {
      try {
        const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const rawEvents: any[] = calendarEventEntityStore.size() > 0
      ? calendarEventEntityStore.getAll()
      : loadStored(LS_CALENDAR_EVENTS);
    const rawExternalEvents: any[] = externalCalendarEventEntityStore.size() > 0
      ? externalCalendarEventEntityStore.getAll()
      : loadStored(LS_EXTERNAL_CALENDAR_EVENTS);
    const orderMap = new Map<string, number>();
    const todayKey = (() => {
      const now = new Date();
      const yyyy = String(now.getFullYear()).padStart(4, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();

    const normalizeEntry = (
      entry: any,
      options?: { external?: boolean },
    ): CalendarEvent | null => {
      if (!entry || typeof entry !== "object") return null;

      const external = options?.external === true;
      const fallbackBoard = typeof (entry as any).boardId === "string" ? (entry as any).boardId : "week-default";
      const boardId = fallbackBoard;
      const nextOrder = orderMap.get(boardId) ?? 0;
      const explicitOrder = typeof (entry as any).order === "number" ? (entry as any).order : nextOrder;
      orderMap.set(boardId, explicitOrder + 1);

      const idRaw = typeof (entry as any).id === "string" ? (entry as any).id.trim() : "";
      const legacyId = typeof (entry as any).eventId === "string" ? (entry as any).eventId.trim() : "";
      const id = idRaw || legacyId || crypto.randomUUID();
      const title = typeof (entry as any).title === "string" ? (entry as any).title : "";
      const summary = typeof (entry as any).summary === "string" ? (entry as any).summary : undefined;
      const description = typeof (entry as any).description === "string" ? (entry as any).description : undefined;
      const documents = normalizeDocumentList((entry as any).documents);
      const image = typeof (entry as any).image === "string" ? (entry as any).image : undefined;
      const geohash = typeof (entry as any).geohash === "string" ? (entry as any).geohash : undefined;
      const columnId = typeof (entry as any).columnId === "string" ? (entry as any).columnId : undefined;
      const reminders = sanitizeReminderList((entry as any).reminders);
      const reminderTime = normalizeReminderTime((entry as any).reminderTime);
      const readOnlyRaw = typeof (entry as any).readOnly === "boolean" ? (entry as any).readOnly : undefined;
      const readOnly = external ? true : readOnlyRaw;
      const originBoardId = typeof (entry as any).originBoardId === "string" ? (entry as any).originBoardId : undefined;
      const hiddenUntilISO = normalizeIsoTimestamp((entry as any).hiddenUntilISO);

      const locations = normalizeStringArray((entry as any).locations);
      const hashtags = normalizeStringArray((entry as any).hashtags);
      const references = normalizeStringArray((entry as any).references);
      const participants = normalizeParticipants((entry as any).participants);

      const recurrence =
        (entry as any).recurrence && typeof (entry as any).recurrence === "object" && typeof (entry as any).recurrence.type === "string"
          ? ((entry as any).recurrence as Recurrence)
          : undefined;
      const seriesId = typeof (entry as any).seriesId === "string" ? (entry as any).seriesId : undefined;

      const eventKey = typeof (entry as any).eventKey === "string" ? (entry as any).eventKey.trim() : "";
      const inviteTokens = normalizeInviteTokens((entry as any).inviteTokens);
      const canonicalAddress =
        typeof (entry as any).canonicalAddress === "string" ? (entry as any).canonicalAddress.trim() : "";
      const viewAddress =
        typeof (entry as any).viewAddress === "string" ? (entry as any).viewAddress.trim() : "";
      const inviteToken = typeof (entry as any).inviteToken === "string" ? (entry as any).inviteToken.trim() : "";
      const inviteRelays = normalizeStringArray((entry as any).inviteRelays);

      const parsedCanonical = canonicalAddress ? parseCalendarAddress(canonicalAddress) : null;
      const boardPubkeyRaw = typeof (entry as any).boardPubkey === "string" ? (entry as any).boardPubkey.trim() : "";
      const boardPubkey =
        normalizeNostrPubkeyHex(boardPubkeyRaw)
        ?? normalizeNostrPubkeyHex(parsedCanonical?.pubkey || "")
        ?? undefined;

      const rsvpStatus = normalizeRsvpStatus((entry as any).rsvpStatus);
      const rsvpCreatedAtRaw = (entry as any).rsvpCreatedAt;
      const rsvpCreatedAt = typeof rsvpCreatedAtRaw === "number" && Number.isFinite(rsvpCreatedAtRaw)
        ? rsvpCreatedAtRaw
        : undefined;
      const rsvpFb = normalizeRsvpFb((entry as any).rsvpFb);
      const createdBy = normalizeAgentPubkey((entry as any).createdBy);
      const lastEditedBy = normalizeAgentPubkey((entry as any).lastEditedBy) ?? createdBy;

      if (external) {
        if (!canonicalAddress || !viewAddress || !eventKey || !boardPubkey) return null;
      }

      const base: CalendarEventBase = {
        id,
        boardId,
        ...(createdBy ? { createdBy } : {}),
        ...(lastEditedBy ? { lastEditedBy } : {}),
        columnId,
        order: explicitOrder,
        title,
        summary,
        description,
        documents: documents ? documents.map(ensureDocumentPreview) : undefined,
        image,
        locations,
        geohash,
        participants,
        hashtags,
        references,
        reminders,
        ...(reminderTime ? { reminderTime } : {}),
        recurrence,
        seriesId,
        ...(hiddenUntilISO ? { hiddenUntilISO } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(external ? { external: true } : {}),
        ...(originBoardId ? { originBoardId } : {}),
        ...(eventKey ? { eventKey } : {}),
        ...(inviteTokens ? { inviteTokens } : {}),
        ...(canonicalAddress ? { canonicalAddress } : {}),
        ...(viewAddress ? { viewAddress } : {}),
        ...(inviteToken ? { inviteToken } : {}),
        ...(inviteRelays ? { inviteRelays } : {}),
        ...(boardPubkey ? { boardPubkey } : {}),
        ...(rsvpStatus ? { rsvpStatus } : {}),
        ...(rsvpCreatedAt ? { rsvpCreatedAt } : {}),
        ...(rsvpFb ? { rsvpFb } : {}),
      };

      const inferredKind =
        (entry as any).kind === "time" || (entry as any).kind === "date"
          ? (entry as any).kind
          : typeof (entry as any).startISO === "string"
            ? "time"
            : "date";

      if (inferredKind === "time") {
        const startISO = typeof (entry as any).startISO === "string" ? (entry as any).startISO : new Date().toISOString();
        if (Number.isNaN(Date.parse(startISO))) return null;
        const endISO = typeof (entry as any).endISO === "string" ? (entry as any).endISO : undefined;
        const normalizedEndISO = endISO && !Number.isNaN(Date.parse(endISO)) ? endISO : undefined;
        const startTzid = typeof (entry as any).startTzid === "string" ? (entry as any).startTzid : undefined;
        const endTzid = typeof (entry as any).endTzid === "string" ? (entry as any).endTzid : undefined;
        const event: TimeCalendarEvent = {
          ...base,
          kind: "time",
          startISO,
          endISO: normalizedEndISO,
          startTzid,
          endTzid,
        };
        return event;
      }

      const startDate =
        typeof (entry as any).startDate === "string" && isDateKey((entry as any).startDate)
          ? (entry as any).startDate
          : todayKey;
      const endDate =
        typeof (entry as any).endDate === "string" && isDateKey((entry as any).endDate)
          ? (entry as any).endDate
          : undefined;
      const event: DateCalendarEvent = {
        ...base,
        kind: "date",
        startDate,
        endDate,
      };
      return event;
    };

    const boardEvents: CalendarEvent[] = [];
    const migratedExternal: CalendarEvent[] = [];
    rawEvents.forEach((entry) => {
      const event = normalizeEntry(entry, { external: false });
      if (!event) return;
      const shouldMigrateExternal =
        (entry as any)?.external === true
        || (!!event.readOnly && !event.originBoardId && !!event.eventKey && !!event.viewAddress && !!event.canonicalAddress);
      if (shouldMigrateExternal) {
        const externalEvent = normalizeEntry(entry, { external: true });
        if (externalEvent) {
          migratedExternal.push(externalEvent);
          return;
        }
      }
      boardEvents.push(event);
    });

    const externalEvents: CalendarEvent[] = [];
    rawExternalEvents.forEach((entry) => {
      const event = normalizeEntry(entry, { external: true });
      if (event) externalEvents.push(event);
    });

    const mergedExternalMap = new Map<string, CalendarEvent>();
    [...migratedExternal, ...externalEvents].forEach((event) => {
      if (!event.external) return;
      const key = `${event.id}::${event.viewAddress || ""}`;
      const existing = mergedExternalMap.get(key);
      if (!existing) {
        mergedExternalMap.set(key, event);
        return;
      }
      const nextCreated = event.rsvpCreatedAt ?? 0;
      const prevCreated = existing.rsvpCreatedAt ?? 0;
      if (nextCreated >= prevCreated) {
        mergedExternalMap.set(key, event);
      }
    });

    return [...boardEvents, ...Array.from(mergedExternalMap.values())];
  });
  return [events, setEvents] as const;
}
