/**
 * Calendar commands take current state and return the next state plus work for the caller.
 * They never touch React, storage or the network.
 */
import {
  addDaysToDateKey,
  ISO_DATE_PATTERN,
  MS_PER_DAY,
  nextOccurrence,
  type CalendarRsvpStatus,
  type CalendarViewPayload,
  type TaskDocument,
} from "taskify-core";
import { isoDatePart, isoFromDateTime, normalizeTimeZone, parseDateKey, startOfDay } from "../dateTime/dateUtils";
import { normalizeAgentPubkey } from "../tasks/assignmentUtils";
import { applyHiddenForCalendarEvent, nextOrderForCalendarBoard } from "../tasks/boardUtils";
import type { Settings } from "../tasks/settingsTypes";
import type { Board, CalendarEvent, CalendarEventBase, CalendarEventParticipant } from "../tasks/taskTypes";
import { calendarRecurrenceInstanceId, calendarRecurrenceLimit } from "./calendarRecurrenceWindow";
import { calendarEventDateKey, calendarEventStartISOForRecurrence } from "./calendarUtils";

export type CalendarEventPlan = {
  events: CalendarEvent[];
  publish: CalendarEvent[];
  publishDeleted: CalendarEvent[];
};

export type AppliedCalendarDeletePlan = CalendarEventPlan & {
  kind: "applied";
  deletedOccurrenceIds: string[];
  cutoff: { boardId: string; seriesId: string; untilISO: string } | null;
};

export type CalendarDeletePlan =
  | { kind: "none" }
  | { kind: "ask-scope"; event: CalendarEvent }
  | AppliedCalendarDeletePlan;

export type SaveCalendarEventContext = {
  now: Date;
  actorPubkey?: string;
  boards: Board[];
  settings: Pick<Settings, "newTaskPosition" | "weekStart">;
};

export type SaveCalendarEventPlan = CalendarEventPlan & {
  saved: CalendarEvent;
  previousParticipants: CalendarEventParticipant[];
  forceInviteAll: boolean;
  publishBoardId: string;
  shouldSendInvites: boolean;
};

export type AcceptedCalendarInvite = {
  eventId: string;
  canonical: string;
  view: string;
  eventKey: string;
  inviteToken: string;
  title?: string;
  start?: string;
  end?: string;
  relays?: string[];
  sender?: { pubkey: string };
};

export type ResolvedCalendarInviteView = Omit<CalendarViewPayload, "documents"> & {
  documents?: TaskDocument[];
};

export type AcceptedInviteContext = {
  now: Date;
  boards: Board[];
  destinationBoardId: string;
  settings: Pick<Settings, "newTaskPosition" | "weekStart">;
  status: CalendarRsvpStatus;
  viewEventId: string;
  originBoardId: string | null;
  boardPubkey?: string;
  viewPayload: ResolvedCalendarInviteView | null;
};

export type AcceptedInviteFailure =
  | "unsupported-status"
  | "missing-board"
  | "missing-board-pubkey"
  | "deleted"
  | "mismatched-view"
  | "unparseable";

export type AcceptedInvitePlan =
  | { kind: "applied"; events: CalendarEvent[]; event: CalendarEvent }
  | { kind: "unchanged"; events: CalendarEvent[]; event: CalendarEvent }
  | { kind: "invalid"; events: CalendarEvent[]; reason: AcceptedInviteFailure };

function appliedDeletePlan(
  events: CalendarEvent[],
  options: Partial<Omit<AppliedCalendarDeletePlan, "kind" | "events">> = {},
): AppliedCalendarDeletePlan {
  return {
    kind: "applied",
    events,
    publish: options.publish ?? [],
    publishDeleted: options.publishDeleted ?? [],
    deletedOccurrenceIds: options.deletedOccurrenceIds ?? [],
    cutoff: options.cutoff ?? null,
  };
}

/** Moves selected events to a board or list column while preserving list order. */
export function planMoveCalendarEvents(
  events: CalendarEvent[],
  ids: Iterable<string>,
  boardId: string,
  columnId?: string,
): CalendarEventPlan {
  const selected = ids instanceof Set ? ids : new Set(ids);
  const publish: CalendarEvent[] = [];
  const publishDeleted: CalendarEvent[] = [];
  let changed = false;
  const next = events.map((event) => {
    if (!selected.has(event.id)) return event;
    changed = true;
    if (event.boardId !== boardId) publishDeleted.push(event);
    const updated: CalendarEvent = {
      ...event,
      boardId,
      originBoardId: undefined,
      columnId,
    };
    publish.push(updated);
    return updated;
  });
  return {
    events: changed ? next : events,
    publish,
    publishDeleted,
  };
}

/**
 * Deletes one event or ends its recurring series. A series seed is advanced when only its first
 * occurrence is deleted, because tombstoning the seed would end the whole series on other clients.
 */
export function planDeleteCalendarEvent(
  events: CalendarEvent[],
  id: string,
  options?: { skipPrompt?: boolean; scope?: "single" | "future" },
): CalendarDeletePlan {
  const existing = events.find((event) => event.id === id);
  if (!existing) return { kind: "none" };
  if (!options?.skipPrompt && existing.recurrence) return { kind: "ask-scope", event: existing };

  const seriesId = existing.seriesId || existing.id;
  const isSeed = !!existing.recurrence && existing.recurrence.type !== "none" && seriesId === existing.id;
  if (options?.scope === "future") {
    const cutoffKey = calendarEventDateKey(existing);
    if (!cutoffKey) return { kind: "none" };
    const cutoffDate = startOfDay(new Date(`${cutoffKey}T00:00:00`));
    if (Number.isNaN(cutoffDate.getTime())) return { kind: "none" };
    const cutoffTime = cutoffDate.getTime();
    const nextUntil = new Date(cutoffTime - MS_PER_DAY).toISOString();
    const hasSeed = events.some(
      (event) => event.id === seriesId && !!event.recurrence && !event.generated,
    );
    const publish: CalendarEvent[] = [];
    const publishDeleted: CalendarEvent[] = [];
    const deletedOccurrenceIds: string[] = [];
    const removedIds = new Set<string>();
    const replacements = new Map<string, CalendarEvent>();
    for (const event of events) {
      const eventSeriesId = event.seriesId || event.id;
      if (!event.recurrence || eventSeriesId !== seriesId) continue;
      const startKey = calendarEventDateKey(event);
      if (!startKey) continue;
      if (startKey >= cutoffKey) {
        deletedOccurrenceIds.push(event.id);
        removedIds.add(event.id);
        if (!event.generated) {
          publishDeleted.push({
            ...event,
            seriesId,
            recurrence: { ...event.recurrence, untilISO: nextUntil },
          });
        }
        continue;
      }
      const untilTime = event.recurrence.untilISO
        ? startOfDay(new Date(event.recurrence.untilISO)).getTime()
        : null;
      if (!untilTime || untilTime > cutoffTime - MS_PER_DAY) {
        const updated: CalendarEvent = {
          ...event,
          seriesId: event.seriesId || seriesId,
          recurrence: { ...event.recurrence, untilISO: nextUntil },
        };
        replacements.set(event.id, updated);
        const publishes = hasSeed ? event.id === seriesId : !event.generated;
        if (publishes) publish.push(updated);
      }
    }
    const next = removedIds.size || replacements.size
      ? events
          .filter((event) => !removedIds.has(event.id))
          .map((event) => replacements.get(event.id) ?? event)
      : events;
    return appliedDeletePlan(next, {
      publish,
      publishDeleted,
      deletedOccurrenceIds,
      cutoff: { boardId: existing.boardId, seriesId, untilISO: nextUntil },
    });
  }

  if (isSeed) return planAdvanceCalendarSeriesSeed(events, existing);

  return appliedDeletePlan(events.filter((event) => event.id !== id), {
    publishDeleted: [{ ...existing, generated: undefined }],
    deletedOccurrenceIds: [existing.id],
  });
}

/** Moves a recurring seed to its next occurrence without changing the stable series id. */
export function planAdvanceCalendarSeriesSeed(
  events: CalendarEvent[],
  seed: CalendarEvent,
): AppliedCalendarDeletePlan {
  const rule = seed.recurrence;
  const startISO = calendarEventStartISOForRecurrence(seed);
  const timeZone = seed.kind === "time" ? normalizeTimeZone(seed.startTzid) ?? undefined : "UTC";
  const nextISO = rule && startISO ? nextOccurrence(startISO, rule, seed.kind === "time", timeZone) : null;
  if (!rule || !nextISO) {
    return appliedDeletePlan(
      events.filter((event) => event.id !== seed.id && !(event.generated && event.seriesId === seed.id)),
      { publishDeleted: [seed] },
    );
  }

  let moved: CalendarEvent;
  if (seed.kind === "time") {
    const durationMs = seed.endISO ? Math.max(0, Date.parse(seed.endISO) - Date.parse(seed.startISO)) : 0;
    moved = {
      ...seed,
      startISO: nextISO,
      ...(durationMs ? { endISO: new Date(Date.parse(nextISO) + durationMs).toISOString() } : {}),
    };
  } else {
    const startDate = isoDatePart(nextISO, "UTC");
    const startParts = parseDateKey(seed.startDate);
    const endParts = seed.endDate && ISO_DATE_PATTERN.test(seed.endDate) ? parseDateKey(seed.endDate) : null;
    const spanDays = startParts && endParts
      ? Math.round(
          (Date.UTC(endParts.year, endParts.month - 1, endParts.day)
            - Date.UTC(startParts.year, startParts.month - 1, startParts.day))
            / MS_PER_DAY,
        )
      : 0;
    moved = {
      ...seed,
      startDate,
      ...(spanDays > 0 ? { endDate: addDaysToDateKey(startDate, spanDays) } : { endDate: undefined }),
    } as CalendarEvent;
  }
  const nextId = calendarRecurrenceInstanceId(seed.id, nextISO, rule, timeZone);
  const stood = events.find((event) => event.id === nextId);
  const next = events
    .filter((event) => event.id !== nextId)
    .map((event) => (event.id === seed.id ? moved : event));
  return appliedDeletePlan(next, {
    publish: [moved],
    publishDeleted: stood && !stood.generated ? [stood] : [],
    deletedOccurrenceIds: [nextId],
  });
}

/**
 * Saves an event, normalizes its authorship and recurrence identity, and refreshes a seed's local
 * recurrence window. Generated occurrences remain publish intents for fidelity; the publisher
 * ignores them because every client derives them locally.
 */
export function planSaveCalendarEvent(
  events: CalendarEvent[],
  updated: CalendarEvent,
  ctx: SaveCalendarEventContext,
): SaveCalendarEventPlan {
  const prior = events.find((event) => event.id === updated.id) ?? null;
  const previousParticipants = prior?.participants ?? [];
  const priorPublishBoardId = prior?.originBoardId ?? prior?.boardId;
  const publishBoardId = updated.originBoardId ?? updated.boardId;
  const forceInviteAll = !!prior && (priorPublishBoardId !== publishBoardId || prior.kind !== updated.kind);
  const boardForUpdate = ctx.boards.find((board) => board.id === publishBoardId) ?? null;

  // Edited on its own, a generated occurrence becomes an exception and is published.
  let next: CalendarEvent = { ...updated, generated: undefined };
  if (prior && prior.boardId !== updated.boardId) {
    next = {
      ...next,
      order: nextOrderForCalendarBoard(updated.boardId, events, ctx.settings.newTaskPosition),
    };
  } else if (typeof next.order !== "number") {
    next = {
      ...next,
      order: nextOrderForCalendarBoard(updated.boardId, events, ctx.settings.newTaskPosition),
    };
  }

  if (next.recurrence && next.recurrence.type !== "none") {
    next = { ...next, seriesId: next.seriesId || next.id };
  } else {
    next = { ...next, recurrence: undefined, seriesId: undefined };
  }
  const nextCreatedBy = normalizeAgentPubkey(next.createdBy || prior?.createdBy || ctx.actorPubkey) ?? undefined;
  const nextLastEditedBy = normalizeAgentPubkey(next.lastEditedBy || ctx.actorPubkey || nextCreatedBy) ?? nextCreatedBy;
  next = {
    ...next,
    ...(nextCreatedBy ? { createdBy: nextCreatedBy } : {}),
    ...(nextLastEditedBy ? { lastEditedBy: nextLastEditedBy } : {}),
  };
  const visibilityBoard = ctx.boards.find((board) => board.id === next.boardId) ?? boardForUpdate ?? null;
  next = applyHiddenForCalendarEvent(next, ctx.settings.weekStart, visibilityBoard?.kind ?? "week", ctx.now);

  const index = events.findIndex((event) => event.id === next.id);
  let nextState = index >= 0
    ? events.map((event) => (event.id === next.id ? next : event))
    : [...events, next];
  const publish: CalendarEvent[] = [next];
  const publishDeleted: CalendarEvent[] = [];
  const shouldGenerate =
    next.recurrence
    && next.recurrence.type !== "none"
    && (next.seriesId || next.id) === next.id;

  if (shouldGenerate) {
    const seriesId = next.seriesId || next.id;
    const rule = next.recurrence!;
    const timeZone = next.kind === "time" ? normalizeTimeZone(next.startTzid) ?? undefined : "UTC";
    const baseStartISO = next.kind === "time"
      ? next.startISO
      : isoFromDateTime(next.startDate, "00:00", "UTC");
    const limitKey = rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : null;
    if (limitKey && ISO_DATE_PATTERN.test(limitKey)) {
      const startKeyForSeriesEvent = (event: CalendarEvent): string | null => {
        if (!event.recurrence || (event.seriesId || event.id) !== seriesId) return null;
        if (event.kind === "date") {
          return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
        }
        const dateKey = isoDatePart(event.startISO, timeZone);
        return ISO_DATE_PATTERN.test(dateKey) ? dateKey : null;
      };
      const pruned: CalendarEvent[] = [];
      for (const event of nextState) {
        if (event.id === next.id) {
          pruned.push(event);
          continue;
        }
        const startKey = startKeyForSeriesEvent(event);
        if (!startKey || startKey <= limitKey) {
          pruned.push(event);
          continue;
        }
        publishDeleted.push(event);
      }
      nextState = pruned;
    }

    const existingIds = new Set(nextState.map((event) => event.id));
    const durationMs = (() => {
      if (next.kind !== "time" || !next.endISO) return 0;
      const start = Date.parse(next.startISO);
      const end = Date.parse(next.endISO);
      if (Number.isNaN(start) || Number.isNaN(end)) return 0;
      return Math.max(0, end - start);
    })();
    const durationDays = (() => {
      if (next.kind !== "date") return 1;
      const endDate = next.endDate && ISO_DATE_PATTERN.test(next.endDate) ? next.endDate : next.startDate;
      const startParts = parseDateKey(next.startDate);
      const endParts = parseDateKey(endDate);
      if (!startParts || !endParts) return 1;
      const startUtc = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
      const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
      if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc < startUtc) return 1;
      return Math.round((endUtc - startUtc) / MS_PER_DAY) + 1;
    })();
    let cursorISO = baseStartISO;
    const maxInstances = Math.max(1, calendarRecurrenceLimit(rule));
    const generated: CalendarEvent[] = [];
    for (let i = 1; i < maxInstances; i += 1) {
      const occurrenceISO = nextOccurrence(cursorISO, rule, next.kind === "time", timeZone);
      if (!occurrenceISO) break;
      cursorISO = occurrenceISO;
      const id = calendarRecurrenceInstanceId(seriesId, occurrenceISO, rule, timeZone);
      if (existingIds.has(id)) continue;

      const nextOrder = nextOrderForCalendarBoard(next.boardId, nextState, ctx.settings.newTaskPosition);
      const instanceBase: CalendarEventBase = {
        ...(next as CalendarEventBase),
        id,
        order: nextOrder,
        seriesId,
        recurrence: rule,
        eventKey: undefined,
        inviteTokens: undefined,
        canonicalAddress: undefined,
        viewAddress: undefined,
        inviteToken: undefined,
        inviteRelays: undefined,
        generated: true,
      };
      const instance: CalendarEvent = next.kind === "time"
        ? {
            ...instanceBase,
            kind: "time",
            startISO: occurrenceISO,
            ...(durationMs ? { endISO: new Date(Date.parse(occurrenceISO) + durationMs).toISOString() } : {}),
            ...(normalizeTimeZone(next.startTzid) ? { startTzid: next.startTzid } : {}),
            ...(normalizeTimeZone(next.endTzid) ? { endTzid: next.endTzid } : {}),
          }
        : (() => {
            const startDate = isoDatePart(occurrenceISO, "UTC");
            const endDate = durationDays > 1 ? addDaysToDateKey(startDate, durationDays - 1) : null;
            return {
              ...instanceBase,
              kind: "date",
              startDate,
              ...(endDate ? { endDate } : {}),
            } as CalendarEvent;
          })();
      const normalizedInstance = applyHiddenForCalendarEvent(
        instance,
        ctx.settings.weekStart,
        visibilityBoard?.kind ?? "week",
        ctx.now,
      );
      existingIds.add(id);
      generated.push(normalizedInstance);
      nextState = [...nextState, normalizedInstance];
    }
    publish.push(...generated);
  }

  return {
    events: nextState,
    saved: next,
    publish,
    publishDeleted,
    previousParticipants,
    forceInviteAll,
    publishBoardId,
    shouldSendInvites: (updated.participants?.length ?? 0) > 0,
  };
}

/** Chooses the same local board priority used when an accepted invite first materializes. */
export function selectAcceptedInviteDestination(boards: Board[]): Board | null {
  const eligible = boards.filter(
    (board) => !board.archived && !board.hidden && board.kind !== "bible" && board.kind !== "compound",
  );
  return eligible.find((board) => board.id === "week-default" && board.kind === "week")
    ?? eligible.find((board) => board.kind === "week")
    ?? eligible.find((board) => board.kind === "lists")
    ?? eligible[0]
    ?? boards.find((board) => !board.archived && !board.hidden)
    ?? boards[0]
    ?? null;
}

/** Returns an invite already materialized with the same secrets, so no relay lookup is needed. */
export function findReusableAcceptedInvite(
  events: CalendarEvent[],
  invite: AcceptedCalendarInvite,
): CalendarEvent | null {
  const existing = events.find(
    (event) => event.id === invite.eventId && event.viewAddress === invite.view,
  );
  if (!existing) return null;
  const hasInviteRelays = !!invite.relays?.length;
  const existingHasRelays = !!existing.inviteRelays?.length;
  if (
    existing.eventKey === invite.eventKey
    && existing.inviteToken === invite.inviteToken
    && (!hasInviteRelays || existingHasRelays)
  ) {
    return existing;
  }
  return null;
}

/** Materializes a decoded accepted invite or refreshes the secrets on its existing local copy. */
export function planAddAcceptedInviteToCalendar(
  events: CalendarEvent[],
  invite: AcceptedCalendarInvite,
  ctx: AcceptedInviteContext,
): AcceptedInvitePlan {
  if (ctx.status !== "accepted" && ctx.status !== "tentative") {
    return { kind: "invalid", events, reason: "unsupported-status" };
  }
  const destinationBoard = ctx.boards.find((board) => board.id === ctx.destinationBoardId);
  if (!destinationBoard) return { kind: "invalid", events, reason: "missing-board" };

  const existingMatch = events.find(
    (event) => event.id === invite.eventId && event.viewAddress === invite.view,
  ) ?? null;
  const isExternal = !ctx.originBoardId;
  const readOnly = isExternal;
  if (isExternal && !ctx.boardPubkey) {
    return { kind: "invalid", events, reason: "missing-board-pubkey" };
  }
  if (ctx.viewPayload?.deleted) return { kind: "invalid", events, reason: "deleted" };
  const resolvedEventId = ctx.viewPayload?.eventId || ctx.viewEventId || invite.eventId;
  if (ctx.viewPayload && ctx.viewPayload.eventId !== ctx.viewEventId) {
    return { kind: "invalid", events, reason: "mismatched-view" };
  }

  const order = nextOrderForCalendarBoard(destinationBoard.id, events, ctx.settings.newTaskPosition);
  const columnId =
    destinationBoard.kind === "lists" && destinationBoard.columns.length
      ? destinationBoard.columns[0].id
      : undefined;
  const inviteRelays = invite.relays?.length ? invite.relays : existingMatch?.inviteRelays;
  const tokenPatch = {
    ...(ctx.originBoardId ? { originBoardId: ctx.originBoardId } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(isExternal ? { external: true, boardPubkey: ctx.boardPubkey, rsvpStatus: ctx.status } : {}),
    eventKey: invite.eventKey,
    viewAddress: invite.view,
    canonicalAddress: invite.canonical,
    inviteToken: invite.inviteToken,
    inviteRelays,
  };
  const inviteCreatedBy =
    normalizeAgentPubkey(ctx.viewPayload?.createdBy)
    ?? normalizeAgentPubkey(invite.sender?.pubkey)
    ?? normalizeAgentPubkey(ctx.boardPubkey)
    ?? undefined;
  const inviteLastEditedBy = normalizeAgentPubkey(ctx.viewPayload?.lastEditedBy) ?? inviteCreatedBy;

  const updateExistingTokens = (): CalendarEvent[] => {
    if (!existingMatch) return events;
    const index = events.findIndex(
      (event) => event.id === existingMatch.id && event.viewAddress === invite.view,
    );
    if (index < 0) return events;
    const existing = events[index];
    const updated: CalendarEvent = {
      ...existing,
      ...tokenPatch,
      ...(readOnly ? { readOnly: true } : { readOnly: existing.readOnly }),
    } as CalendarEvent;
    const next = events.slice();
    next[index] = updated;
    return next;
  };

  const toCommon = (details: {
    title?: string;
    summary?: string;
    description?: string;
    documents?: TaskDocument[];
    image?: string;
    locations?: string[];
    geohash?: string;
    hashtags?: string[];
    references?: string[];
  }): Omit<CalendarEventBase, "kind" | "startDate" | "endDate" | "startISO" | "endISO"> => ({
    id: resolvedEventId,
    boardId: destinationBoard.id,
    ...(inviteCreatedBy ? { createdBy: inviteCreatedBy } : {}),
    ...(inviteLastEditedBy ? { lastEditedBy: inviteLastEditedBy } : {}),
    columnId,
    order,
    title: details.title || invite.title || "Untitled",
    summary: details.summary,
    description: details.description || "",
    documents: details.documents?.length ? details.documents : undefined,
    image: details.image,
    locations: details.locations?.length ? details.locations : undefined,
    geohash: details.geohash,
    hashtags: details.hashtags?.length ? details.hashtags : undefined,
    references: details.references?.length ? details.references : undefined,
    ...tokenPatch,
  });

  let nextEvent: CalendarEvent | null = null;
  if (ctx.viewPayload) {
    if (ctx.viewPayload.kind === "date") {
      const startDate = ctx.viewPayload.startDate || "";
      if (ISO_DATE_PATTERN.test(startDate)) {
        const rawEnd = ctx.viewPayload.endDate || "";
        const endDate = rawEnd && ISO_DATE_PATTERN.test(rawEnd) && rawEnd >= startDate ? rawEnd : undefined;
        nextEvent = {
          ...toCommon(ctx.viewPayload),
          kind: "date",
          startDate,
          ...(endDate ? { endDate } : {}),
        };
      }
    } else {
      const startISO = typeof ctx.viewPayload.startISO === "string" ? ctx.viewPayload.startISO.trim() : "";
      const startMs = startISO ? Date.parse(startISO) : NaN;
      if (startISO && !Number.isNaN(startMs)) {
        const endISO = typeof ctx.viewPayload.endISO === "string" ? ctx.viewPayload.endISO.trim() : "";
        const normalizedEnd = endISO && Date.parse(endISO) > startMs ? endISO : undefined;
        const startTzid = normalizeTimeZone(ctx.viewPayload.startTzid) ?? undefined;
        const endTzid = normalizeTimeZone(ctx.viewPayload.endTzid) ?? undefined;
        nextEvent = {
          ...toCommon(ctx.viewPayload),
          kind: "time",
          startISO,
          ...(normalizedEnd ? { endISO: normalizedEnd } : {}),
          ...(startTzid ? { startTzid } : {}),
          ...(endTzid ? { endTzid } : {}),
        };
      }
    }
  } else if (existingMatch) {
    return { kind: "applied", events: updateExistingTokens(), event: existingMatch };
  } else {
    const startRaw = invite.start?.trim() || "";
    if (ISO_DATE_PATTERN.test(startRaw)) {
      const endRaw = invite.end?.trim() || "";
      const endDate = endRaw && ISO_DATE_PATTERN.test(endRaw) && endRaw >= startRaw ? endRaw : undefined;
      nextEvent = {
        ...toCommon({ title: invite.title }),
        kind: "date",
        startDate: startRaw,
        ...(endDate ? { endDate } : {}),
      };
    } else {
      const startMs = startRaw ? Date.parse(startRaw) : NaN;
      if (startRaw && !Number.isNaN(startMs)) {
        const endRaw = invite.end?.trim() || "";
        const endMs = endRaw ? Date.parse(endRaw) : NaN;
        const endISO = !Number.isNaN(endMs) && endMs > startMs ? new Date(endMs).toISOString() : undefined;
        nextEvent = {
          ...toCommon({ title: invite.title }),
          kind: "time",
          startISO: new Date(startMs).toISOString(),
          ...(endISO ? { endISO } : {}),
        };
      }
    }
  }

  if (!nextEvent) {
    if (existingMatch) return { kind: "unchanged", events, event: existingMatch };
    return { kind: "invalid", events, reason: "unparseable" };
  }

  const normalizedEvent = applyHiddenForCalendarEvent(
    nextEvent,
    ctx.settings.weekStart,
    destinationBoard.kind,
    ctx.now,
  );
  const index = events.findIndex(
    (event) => event.id === normalizedEvent.id && event.viewAddress === invite.view,
  );
  if (index < 0) {
    return { kind: "applied", events: [...events, normalizedEvent], event: normalizedEvent };
  }
  const existing = events[index];
  const merged: CalendarEvent = {
    ...normalizedEvent,
    ...(Array.isArray(existing.reminders) && existing.reminders.length ? { reminders: existing.reminders } : {}),
    ...(existing.reminderTime ? { reminderTime: existing.reminderTime } : {}),
    ...(existing.recurrence ? { recurrence: existing.recurrence } : {}),
    ...(existing.seriesId ? { seriesId: existing.seriesId } : {}),
    ...(existing.hiddenUntilISO ? { hiddenUntilISO: existing.hiddenUntilISO } : {}),
    ...(typeof existing.order === "number" && typeof normalizedEvent.order !== "number" ? { order: existing.order } : {}),
  } as CalendarEvent;
  const next = events.slice();
  next[index] = merged;
  return { kind: "applied", events: next, event: normalizedEvent };
}
