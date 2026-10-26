import { type NDKEvent } from "@nostr-dev-kit/ndk";
import { boardTagHash, deriveBoardKeyPair } from "taskify-runtime-nostr";
import {
  calendarAddress,
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  readTagValue,
  resolveIdentifierReference,
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
} from "taskify-core";
import {
  encryptCalendarPayloadForBoard,
  encryptCalendarPayloadWithEventKey,
  generateEventKey,
  generateInviteToken,
} from "../calendarCrypto.js";
import { buildCalendarCanonicalEnvelope, buildCalendarViewEnvelope } from "../shared/calendarEnvelope.js";
import { eventInvitationSecrets, withInvitee } from "../shared/eventInvite.js";
import { pickLatestParsedEvent, pickLatestParsedEventsByKey } from "../shared/latestEvent.js";
import type { ReminderPreset, Recurrence } from "../shared/taskTypes.js";
import { getUserPubkeyHex, resolveBoardEntry, type RuntimeContext } from "./context.js";
import {
  decryptCalendarEventPayload,
  parseDecryptedCalendarEvent,
  type EventInvitation,
  type FullEventRecord,
} from "./calendarCodec.js";

export type CreateEventInput = {
  boardId: string;
  title: string;
  kind: "date" | "time";
  startDate?: string;
  endDate?: string;
  startISO?: string;
  endISO?: string;
  startTzid?: string;
  endTzid?: string;
  description?: string;
  recurrence?: Recurrence;
  reminders?: ReminderPreset[];
  participants?: Array<{ pubkey: string; relay?: string; role?: string }>;
  columnId?: string;
  documents?: Record<string, unknown>[];
};

export type EventPatch = Partial<Pick<FullEventRecord, "title" | "startDate" | "endDate" | "startISO" | "endISO" | "startTzid" | "endTzid" | "description" | "recurrence" | "reminders" | "participants" | "columnId">> & { documents?: Record<string, unknown>[] | null };

/**
 * Calendar events on boards: each is a board-key copy (kind 30310, board-encrypted) and an
 * invitees' view (kind 30311, under the event's own key). The `NostrRuntime` facade exposes these
 * methods as they are.
 */
export function createCalendarRepository(context: RuntimeContext) {
  const { config, session, ensureConnected, boardRelays, clock, randomUUID, isoNow } = context;

  const invitationGenerators = { eventKey: generateEventKey, inviteToken: generateInviteToken };

  async function fetchBoardCalendarEvents(boardId: string, eventId?: string): Promise<Set<NDKEvent>> {
    const bTag = boardTagHash(boardId);
    const boardPubkey = deriveBoardKeyPair(boardId).pk;
    const filter: Record<string, unknown> = {
      kinds: [TASKIFY_CALENDAR_EVENT_KIND],
      authors: [boardPubkey],
      "#b": [bTag],
    };
    if (eventId) filter["#d"] = [eventId];

    const events = await session.fetchEvents(
      [filter as never],
      boardRelays(boardId),
      eventId ? 8_000 : 12_000,
      200,
      eventId ? 2_000 : 3_000,
    );
    return new Set(events.map((event) => session.createEvent(event)));
  }

  async function resolveCalendarEventId(boardId: string, eventIdOrPrefix: string): Promise<string | null> {
    const exact = eventIdOrPrefix.trim();
    if (exact.length === 36) return exact;

    const allEvents = await fetchBoardCalendarEvents(boardId);
    const entries = Array.from(allEvents)
      .map((event) => ({ id: readTagValue(event.tags, "d") ?? "" }))
      .filter((entry) => entry.id);

    return resolveIdentifierReference(entries, eventIdOrPrefix)?.id ?? null;
  }

  async function publishCalendarEvent(
    boardId: string,
    calEventId: string,
    eventKey: string,
    payload: Record<string, unknown>,
    status: "open" | "deleted",
    colId: string = "",
    afterCreatedAt?: number,
  ): Promise<NDKEvent> {
    const boardKeys = deriveBoardKeyPair(boardId);
    const bTag = boardTagHash(boardId);
    const canonicalPayload = buildCalendarCanonicalEnvelope(calEventId, eventKey, payload);
    const viewPayload = buildCalendarViewEnvelope(canonicalPayload);
    const encrypted = await encryptCalendarPayloadForBoard(canonicalPayload, boardKeys.skHex, boardKeys.pk);
    const event = session.createEvent();
    event.created_at = Math.max(
      Math.floor(clock() / 1000),
      typeof afterCreatedAt === "number" ? afterCreatedAt + 1 : 0,
    );
    event.kind = TASKIFY_CALENDAR_EVENT_KIND;
    event.content = encrypted;
    event.tags = [
      ["d", calEventId],
      ["b", bTag],
      ["col", colId],
      ["status", status],
      ["entity", "event"],
    ];
    try {
      await session.publishSigned(event, boardKeys.signer, boardRelays(boardId));
      const viewEvent = session.createEvent();
      viewEvent.kind = TASKIFY_CALENDAR_VIEW_KIND;
      viewEvent.created_at = event.created_at;
      viewEvent.content = await encryptCalendarPayloadWithEventKey(viewPayload, eventKey);
      viewEvent.tags = [
        ["d", calEventId],
        ["a", calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, calEventId)],
      ];
      await session.publishSigned(viewEvent, boardKeys.signer, boardRelays(boardId));
    } catch (err) {
      throw err;
    }
    return event;
  }

  const repository = {
    async listEvents({ boardId }: { boardId?: string }): Promise<FullEventRecord[]> {
      const boards = boardId
        ? (() => {
            const entry = resolveBoardEntry(config, boardId);
            return entry ? [entry] : [];
          })()
        : [...config.boards];
      if (boards.length === 0) return [];

      await ensureConnected();
      const out: FullEventRecord[] = [];
      for (const board of boards) {
        const events = await fetchBoardCalendarEvents(board.id);
        const latestById = await pickLatestParsedEventsByKey(
          events,
          (event) => readTagValue(event.tags, "d"),
          (event) => parseDecryptedCalendarEvent(event, board.id, board.name),
        );
        for (const { parsed } of latestById.values()) {
          if (parsed.deleted) continue;
          out.push(parsed);
        }
      }
      out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return out;
    },

    async getEvent(eventId: string, boardId?: string): Promise<FullEventRecord | null> {
      const boards = boardId
        ? (() => {
            const entry = resolveBoardEntry(config, boardId);
            return entry ? [entry] : [];
          })()
        : [...config.boards];
      if (boards.length === 0) return null;

      await ensureConnected();
      const matches: FullEventRecord[] = [];
      for (const board of boards) {
        const resolvedId = await resolveCalendarEventId(board.id, eventId);
        if (!resolvedId) continue;
        const events = await fetchBoardCalendarEvents(board.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (evt) => parseDecryptedCalendarEvent(evt, board.id, board.name));
        if (!latest || latest.parsed.deleted) continue;
        matches.push(latest.parsed);
      }

      if (matches.length === 0) return null;
      if (!boardId && matches.length > 1) {
        throw new Error(`Event id matches multiple boards; specify --board (matches: ${matches.map((m) => m.boardName ?? m.boardId).join(", ")})`);
      }
      return matches[0];
    },

    async createEvent(input: CreateEventInput): Promise<FullEventRecord> {
      await ensureConnected();
      const id = randomUUID();
      const now = clock();
      const normalized = normalizeCalendarMutationPayload(
        {
          title: input.title,
          kind: input.kind,
          startDate: input.startDate,
          endDate: input.endDate,
          startISO: input.startISO,
          endISO: input.endISO,
          startTzid: input.startTzid,
          endTzid: input.endTzid,
          description: input.description,
        },
        now,
      );
      if (!normalized) {
        throw new Error("Invalid event payload");
      }
      const userPubkey = getUserPubkeyHex(config);
      // A key, and a token per invitee, by the rule the PWA and iOS share.
      const { eventKey, inviteTokens } = eventInvitationSecrets({}, input.participants, userPubkey, invitationGenerators);
      // Merge extra fields not handled by normalizeCalendarMutationPayload
      const payload: Record<string, unknown> = {
        ...normalized,
        ...(userPubkey ? { createdBy: userPubkey, lastEditedBy: userPubkey } : {}),
        ...(inviteTokens ? { inviteTokens } : {}),
        recurrence: input.recurrence ?? null,
        reminders: input.reminders ?? null,
        participants: input.participants ?? null,
        documents: input.documents ?? null,
      };
      const boardEntry = resolveBoardEntry(config, input.boardId);
      const colId = input.columnId
        ?? (boardEntry?.kind === "lists" && Array.isArray(boardEntry.columns) && boardEntry.columns.length > 0 ? boardEntry.columns[0].id : "");
      await publishCalendarEvent(input.boardId, id, eventKey, payload, "open", colId);
      return {
        id,
        boardId: input.boardId,
        eventKey,
        inviteTokens,
        createdBy: userPubkey,
        lastEditedBy: userPubkey,
        title: normalized.title ?? "",
        kind: normalized.kind === "time" ? "time" : "date",
        startDate: normalized.startDate,
        endDate: normalized.endDate,
        startISO: normalized.startISO,
        endISO: normalized.endISO,
        startTzid: normalized.startTzid,
        endTzid: normalized.endTzid,
        description: normalized.description,
        recurrence: input.recurrence as Recurrence | undefined,
        reminders: input.reminders as ReminderPreset[] | undefined,
        participants: input.participants,
        documents: input.documents,
        columnId: colId || undefined,
        createdAt: Math.floor(now / 1000),
        updatedAt: new Date(now).toISOString(),
      };
    },

    async updateEvent(eventId: string, boardId: string | undefined, patch: EventPatch): Promise<FullEventRecord | null> {
      await ensureConnected();
      const boards = boardId
        ? (() => {
            const entry = resolveBoardEntry(config, boardId);
            return entry ? [entry] : [];
          })()
        : [...config.boards];
      if (boards.length === 0) return null;

      const matches: Array<{ entry: (typeof boards)[number]; resolvedId: string; existing: FullEventRecord }> = [];
      for (const entry of boards) {
        const resolvedId = await resolveCalendarEventId(entry.id, eventId);
        if (!resolvedId) continue;
        const events = await fetchBoardCalendarEvents(entry.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (evt) => parseDecryptedCalendarEvent(evt, entry.id, entry.name));
        if (!latest || latest.parsed.deleted) continue;
        matches.push({ entry, resolvedId, existing: latest.parsed });
      }

      if (matches.length === 0) return null;
      if (!boardId && matches.length > 1) {
        throw new Error(`Event id matches multiple boards; specify --board (matches: ${matches.map((m) => m.entry.name).join(", ")})`);
      }

      const { entry, resolvedId, existing } = matches[0];
      const mergedRecurrence = patch.recurrence ?? existing.recurrence;
      const mergedReminders = patch.reminders ?? existing.reminders;
      const mergedParticipants = patch.participants ?? existing.participants;
      // Tokens follow the participants: new invitees get one, removed ones lose theirs.
      const { eventKey, inviteTokens } = eventInvitationSecrets(existing, mergedParticipants, getUserPubkeyHex(config), invitationGenerators);
      const mergedDocuments = patch.documents === undefined ? existing.documents : patch.documents ?? undefined;
      const normalized = normalizeCalendarMutationPayload(
        {
          title: patch.title ?? existing.title,
          kind: existing.kind,
          startDate: patch.startDate ?? existing.startDate,
          endDate: patch.endDate ?? existing.endDate,
          startISO: patch.startISO ?? existing.startISO,
          endISO: patch.endISO ?? existing.endISO,
          startTzid: patch.startTzid ?? existing.startTzid,
          endTzid: patch.endTzid ?? existing.endTzid,
          description: patch.description ?? existing.description,
        },
        existing.createdAt ? existing.createdAt * 1000 : clock(),
      );
      if (!normalized) return null;
      const mergedPayload: Record<string, unknown> = {
        ...normalized,
        ...(existing.createdBy ? { createdBy: existing.createdBy } : {}),
        ...(getUserPubkeyHex(config) || existing.lastEditedBy
          ? { lastEditedBy: getUserPubkeyHex(config) || existing.lastEditedBy }
          : {}),
        ...(inviteTokens ? { inviteTokens } : {}),
        ...(existing.summary ? { summary: existing.summary } : {}),
        ...(existing.image ? { image: existing.image } : {}),
        ...(existing.locations?.length ? { locations: existing.locations } : {}),
        ...(existing.geohash ? { geohash: existing.geohash } : {}),
        ...(existing.hashtags?.length ? { hashtags: existing.hashtags } : {}),
        ...(existing.references?.length ? { references: existing.references } : {}),
        recurrence: mergedRecurrence ?? null,
        reminders: mergedReminders ?? null,
        participants: mergedParticipants ?? null,
        documents: mergedDocuments ?? null,
      };
      const colId = patch.columnId !== undefined ? (patch.columnId ?? "") : (existing.columnId ?? "");
      const published = await publishCalendarEvent(
        entry.id,
        resolvedId,
        eventKey,
        mergedPayload,
        "open",
        colId,
        existing.createdAt,
      );
      return {
        id: resolvedId,
        boardId: entry.id,
        boardName: entry.name,
        eventKey,
        createdBy: existing.createdBy,
        lastEditedBy: getUserPubkeyHex(config) || existing.lastEditedBy,
        inviteTokens,
        title: normalized.title ?? "",
        summary: existing.summary,
        image: existing.image,
        locations: existing.locations,
        geohash: existing.geohash,
        hashtags: existing.hashtags,
        references: existing.references,
        kind: normalized.kind === "time" ? "time" : "date",
        startDate: normalized.startDate,
        endDate: normalized.endDate,
        startISO: normalized.startISO,
        endISO: normalized.endISO,
        startTzid: normalized.startTzid,
        endTzid: normalized.endTzid,
        description: normalized.description,
        recurrence: mergedRecurrence as Recurrence | undefined,
        reminders: mergedReminders as ReminderPreset[] | undefined,
        participants: mergedParticipants,
        documents: mergedDocuments as Record<string, unknown>[] | undefined,
        columnId: colId || undefined,
        createdAt: published.created_at ?? existing.createdAt,
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : isoNow(),
      };
    },

    async inviteToEvent(eventId: string, boardId: string | undefined, recipientPubkeyHex: string): Promise<EventInvitation | null> {
      const sender = getUserPubkeyHex(config);
      if (sender && sender === recipientPubkeyHex) throw new Error("You can't invite yourself.");
      const existing = await repository.getEvent(eventId, boardId);
      if (!existing) return null;
      const event = await repository.updateEvent(existing.id, existing.boardId, {
        participants: withInvitee(existing.participants, recipientPubkeyHex),
      });
      const inviteToken = event?.inviteTokens?.[recipientPubkeyHex];
      if (!event || !inviteToken) return null;
      const { pk } = deriveBoardKeyPair(event.boardId);
      return {
        event,
        canonical: calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, pk, event.id),
        view: calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, pk, event.id),
        inviteToken,
        relays: boardRelays(event.boardId),
      };
    },

    async deleteEvent(eventId: string, boardId: string | undefined): Promise<FullEventRecord | null> {
      await ensureConnected();
      const boards = boardId
        ? (() => {
            const entry = resolveBoardEntry(config, boardId);
            return entry ? [entry] : [];
          })()
        : [...config.boards];
      if (boards.length === 0) return null;

      const matches: Array<{ entry: (typeof boards)[number]; resolvedId: string; existing: FullEventRecord }> = [];
      for (const entry of boards) {
        const resolvedId = await resolveCalendarEventId(entry.id, eventId);
        if (!resolvedId) continue;
        const events = await fetchBoardCalendarEvents(entry.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (evt) => parseDecryptedCalendarEvent(evt, entry.id, entry.name));
        if (!latest || latest.parsed.deleted) continue;
        matches.push({ entry, resolvedId, existing: latest.parsed });
      }

      if (matches.length === 0) return null;
      if (!boardId && matches.length > 1) {
        throw new Error(`Event id matches multiple boards; specify --board (matches: ${matches.map((m) => m.entry.name).join(", ")})`);
      }

      const { entry, resolvedId, existing } = matches[0];
      const payload = normalizeCalendarDeleteMutationPayload(
        {
          title: existing.title,
          kind: existing.kind,
          startDate: existing.startDate,
          endDate: existing.endDate,
          startISO: existing.startISO,
          endISO: existing.endISO,
          startTzid: existing.startTzid,
          endTzid: existing.endTzid,
          description: existing.description,
        },
        existing.createdAt ? existing.createdAt * 1000 : clock(),
      );
      if (!payload) return null;
      await publishCalendarEvent(
        entry.id,
        resolvedId,
        existing.eventKey,
        {
          ...(payload as unknown as Record<string, unknown>),
          ...(existing.createdBy ? { createdBy: existing.createdBy } : {}),
          ...(getUserPubkeyHex(config) || existing.lastEditedBy
            ? { lastEditedBy: getUserPubkeyHex(config) || existing.lastEditedBy }
            : {}),
        },
        "deleted",
        "",
        existing.createdAt,
      );
      return { ...existing, deleted: true };
    },

    async applyEventRsvpResponse(eventId: string, senderPubkey: string, status: "accepted" | "declined" | "tentative", respondedAt?: string): Promise<FullEventRecord | null> {
      await ensureConnected();
      for (const entry of config.boards) {
        const resolvedId = await resolveCalendarEventId(entry.id, eventId);
        if (!resolvedId) continue;
        const events = await fetchBoardCalendarEvents(entry.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedCalendarEvent(event, entry.id, entry.name));
        if (!latest || latest.parsed.deleted) continue;
        const { event, parsed: existing } = latest;
        const rawPayload = await decryptCalendarEventPayload(event, entry.id);
        if (!rawPayload) continue;
        rawPayload.rsvpStatus = status;
        rawPayload.rsvpCreatedAt = respondedAt ? Math.floor(new Date(respondedAt).getTime() / 1000) : Math.floor(clock() / 1000);
        rawPayload.lastEditedBy = senderPubkey;
        const colId = readTagValue(event.tags, "col") ?? existing.columnId ?? "";
        await publishCalendarEvent(entry.id, resolvedId, existing.eventKey, rawPayload, "open", colId, event.created_at);
        return { ...existing, rsvpStatus: status, rsvpCreatedAt: rawPayload.rsvpCreatedAt };
      }
      return null;
    },
  };
  return repository;
}
