import { type NDKEvent } from "@nostr-dev-kit/ndk";
import { sanitizeRemote } from "./shared/displaySafe.js";
import { boardTagHash, collectRuntimeRelayUrls, deriveBoardKeyPair, type RelayRuntimeStatus } from "taskify-runtime-nostr";
import { eventInvitationSecrets, withInvitee } from "./shared/eventInvite.js";
import type { ReminderPreset, Recurrence } from "./shared/taskTypes.js";
import type { AgentTaskCreateInput, AgentTaskPatchInput, AgentTaskStatus } from "./shared/agentRuntime.js";
import type { AgentSecurityConfig } from "./shared/agentSecurity.js";
import type { TaskifyConfig, BoardEntry } from "./config.js";
import { saveConfig } from "./config.js";
import { readCache, writeCache } from "./taskCache.js";
import { pickBestBoardMeta } from "./shared/boardMeta.js";
import { pickLatestParsedEvent, pickLatestParsedEventsByKey } from "./shared/latestEvent.js";
import {
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  parseCalendarCanonicalPayload,
  calendarAddress,
  resolveIdentifierReference,
  readTagValue,
  readStatusTag,
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
} from "taskify-core";
import {
  encryptCalendarPayloadForBoard,
  decryptCalendarPayloadForBoard,
  encryptCalendarPayloadWithEventKey,
  generateEventKey,
  generateInviteToken,
} from "./calendarCrypto.js";
import {
  buildCalendarCanonicalEnvelope,
  buildCalendarViewEnvelope,
} from "./shared/calendarEnvelope.js";
import { createCliNostrSession, type CliNostrSession } from "./shared/nodeRuntimeSession.js";
import { cliProofOfWorkSettings, cliRelayInfoCache } from "./shared/relaySettings.js";
import { decryptContent, encryptContent, getUserPubkeyHex, resolveBoardEntry, type DecryptedPayload, type RuntimeContext } from "./runtime/context.js";
import type { ExtendedCreateInput, FullTaskRecord } from "./runtime/taskCodec.js";
import { createTaskRepository, type ListTasksOptions } from "./runtime/taskRepository.js";

export type { ExtendedCreateInput, FullTaskRecord } from "./runtime/taskCodec.js";

// ---- Internal helpers (not exported) ----

function validateCalendarEventCompat(event: NDKEvent): boolean {
  if (event.kind !== TASKIFY_CALENDAR_EVENT_KIND) return false;
  const hasD = event.tags.some((t) => t[0] === "d");
  const hasB = event.tags.some((t) => t[0] === "b");
  if (!hasD || !hasB) return false;
  if (!event.content) return false;
  return true;
}

// ---- Public types ----

/** What an invitation to a calendar event carries (`buildCalendarEventInviteEnvelope`). */
export type EventInvitation = {
  event: FullEventRecord;
  /** The board copy's and the invitees' copy's addresses, under the board's key. */
  canonical: string;
  view: string;
  inviteToken: string;
  /** The board's relays, where the event is published. */
  relays: string[];
};

export type FullEventRecord = {
  id: string;
  boardId: string;
  boardName?: string;
  eventKey: string;
  createdBy?: string;
  lastEditedBy?: string;
  inviteTokens?: Record<string, string>;
  title: string;
  summary?: string;
  image?: string;
  locations?: string[];
  geohash?: string;
  hashtags?: string[];
  references?: string[];
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
  documents?: Record<string, unknown>[];
  columnId?: string;
  rsvpStatus?: "accepted" | "declined" | "tentative";
  rsvpCreatedAt?: number;
  createdAt?: number;
  updatedAt?: string;
  deleted?: boolean;
};

export type NostrRuntime = {
  getDefaultBoardId(): string | null;
  disconnect(): Promise<void>;
  listTasks(options: ListTasksOptions): Promise<FullTaskRecord[]>;
  listEvents(options: { boardId?: string }): Promise<FullEventRecord[]>;
  getEvent(eventId: string, boardId?: string): Promise<FullEventRecord | null>;
  createEvent(input: {
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
  }): Promise<FullEventRecord>;
  updateEvent(eventId: string, boardId: string | undefined, patch: Partial<Pick<FullEventRecord, "title" | "startDate" | "endDate" | "startISO" | "endISO" | "startTzid" | "endTzid" | "description" | "recurrence" | "reminders" | "participants" | "columnId">> & { documents?: Record<string, unknown>[] | null }): Promise<FullEventRecord | null>;
  deleteEvent(eventId: string, boardId: string | undefined): Promise<FullEventRecord | null>;
  /** Adds `recipientPubkeyHex` to the event's participants with their own invite token, publishes
   * the event, and returns what the invitation carries. Null when the event isn't found. */
  inviteToEvent(eventId: string, boardId: string | undefined, recipientPubkeyHex: string): Promise<EventInvitation | null>;
  syncBoard(boardId: string): Promise<{ name?: string; kind?: string; columns?: { id: string; name: string }[]; children?: string[] }>;
  createTask(input: AgentTaskCreateInput): Promise<FullTaskRecord>;
  createTaskFull(input: ExtendedCreateInput): Promise<FullTaskRecord>;
  createBoard(input: { name: string; kind: "lists" | "week" | "compound"; columns?: { id: string; name: string }[]; children?: string[] }): Promise<{ boardId: string }>;
  updateBoard(boardId: string, patch: Partial<Pick<BoardEntry, "name" | "archived" | "hidden" | "indexCardEnabled" | "clearCompletedDisabled" | "hideChildBoardNames" | "shareSettings" | "columns" | "children" | "sortMode" | "sortDirection">>): Promise<BoardEntry | null>;
  clearCompleted(boardId: string): Promise<number>;
  updateTask(taskId: string, boardId: string, patch: AgentTaskPatchInput): Promise<FullTaskRecord | null>;
  setTaskStatus(taskId: string, status: AgentTaskStatus, boardId: string): Promise<FullTaskRecord | null>;
  deleteTask(taskId: string, boardId: string): Promise<FullTaskRecord | null>;
  toggleSubtask(taskId: string, boardId: string, subtaskRef: string, completed: boolean): Promise<FullTaskRecord | null>;
  getTask(taskId: string, boardId?: string): Promise<FullTaskRecord | null>;
  applyTaskAssignmentResponse(taskId: string, senderPubkey: string, status: "accepted" | "declined" | "tentative", respondedAt?: string): Promise<FullTaskRecord | null>;
  applyEventRsvpResponse(eventId: string, senderPubkey: string, status: "accepted" | "declined" | "tentative", respondedAt?: string): Promise<FullEventRecord | null>;
  remindTask(taskId: string, presets: ReminderPreset[]): Promise<void>;
  getLocalReminders(taskId: string): ReminderPreset[];
  getAgentSecurityConfig(): Promise<AgentSecurityConfig>;
  setAgentSecurityConfig(cfg: AgentSecurityConfig): Promise<AgentSecurityConfig>;
  getRelayStatus(): Promise<RelayRuntimeStatus[]>;
};

// ---- Event parsing ----

async function decryptCalendarEventPayload(event: NDKEvent, boardId: string): Promise<DecryptedPayload | null> {
  try {
    const boardKeys = deriveBoardKeyPair(boardId);
    return await decryptCalendarPayloadForBoard(event.content, boardKeys.skHex, boardKeys.pk) as DecryptedPayload;
  } catch {
    return null;
  }
}


async function parseDecryptedCalendarEvent(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullEventRecord | null> {
  return sanitizeRemote(await parseDecryptedCalendarEventUnsafe(event, boardId, boardName));
}

async function parseDecryptedCalendarEventUnsafe(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullEventRecord | null> {
  if (!validateCalendarEventCompat(event)) return null;
  if (event.pubkey !== deriveBoardKeyPair(boardId).pk) return null;
  const statusVal = readStatusTag(event.tags, "open");
  const entityTag = readTagValue(event.tags, "entity");
  try {
    const raw = await decryptCalendarEventPayload(event, boardId);
    if (!raw) return null;

    const id = readTagValue(event.tags, "d") ?? "";
    if (!id) return null;

    const inferredEvent =
      event.kind === TASKIFY_CALENDAR_EVENT_KIND ||
      event.kind === TASKIFY_CALENDAR_VIEW_KIND ||
      entityTag === "event" ||
      raw.kind === "date" ||
      raw.kind === "time" ||
      typeof raw.startDate === "string" ||
      typeof raw.startISO === "string";
    if (!inferredEvent) return null;

    const payload = parseCalendarCanonicalPayload(raw);
    if (!payload || payload.eventId !== id) return null;
    const kind = payload.kind === "time" ? "time" : "date";

    return {
      id,
      boardId,
      boardName,
      eventKey: payload.eventKey,
      createdBy: payload.createdBy,
      lastEditedBy: payload.lastEditedBy,
      inviteTokens: payload.inviteTokens,
      title: payload.title ?? "",
      summary: payload.summary,
      image: payload.image,
      locations: payload.locations,
      geohash: payload.geohash,
      hashtags: payload.hashtags,
      references: payload.references,
      kind,
      startDate: payload.startDate,
      endDate: payload.endDate,
      startISO: payload.startISO,
      endISO: payload.endISO,
      startTzid: payload.startTzid,
      endTzid: payload.endTzid,
      description: payload.description,
      // Access extra fields from raw (not included in CalendarNormalizedPayload)
      recurrence: raw.recurrence as Recurrence | undefined,
      reminders: raw.reminders as ReminderPreset[] | undefined,
      participants: Array.isArray(raw.participants) ? raw.participants as Array<{ pubkey: string; relay?: string; role?: string }> : undefined,
      documents: Array.isArray(raw.documents) ? raw.documents as Record<string, unknown>[] : undefined,
      columnId: (readTagValue(event.tags, "col") || undefined),
      rsvpStatus: raw.rsvpStatus as "accepted" | "declined" | "tentative" | undefined,
      rsvpCreatedAt: typeof raw.rsvpCreatedAt === "number" ? raw.rsvpCreatedAt : undefined,
      createdAt: event.created_at,
      updatedAt: event.created_at ? new Date(event.created_at * 1000).toISOString() : undefined,
      deleted: statusVal === "deleted" || payload.deleted === true,
    };
  } catch {
    return null;
  }
}

// ---- Runtime factory ----

/**
 * What the runtime reaches outside itself. Production uses the CLI's file-backed session, task
 * cache and config; tests pass a session on a loopback relay and in-memory stores.
 */
export type NostrRuntimeDependencies = {
  createSession?: (config: TaskifyConfig) => CliNostrSession;
  taskCache?: RuntimeContext["taskCache"];
  saveConfig?: (config: TaskifyConfig) => Promise<void>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  randomUUID?: () => string;
};

export function createNostrRuntime(config: TaskifyConfig, dependencies: NostrRuntimeDependencies = {}): NostrRuntime {
  const runtimeRelays = collectRuntimeRelayUrls(config.relays, config.boards);
  const session = dependencies.createSession
    ? dependencies.createSession(config)
    : createCliNostrSession(config, {
      relayInfoCache: cliRelayInfoCache(),
      proofOfWork: cliProofOfWorkSettings(),
    }).session;
  const taskCache = dependencies.taskCache ?? { read: readCache, write: writeCache };
  const persistConfig = dependencies.saveConfig ?? saveConfig;
  const clock = dependencies.now ?? (() => Date.now());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const isoNow = () => new Date(clock()).toISOString();

  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    await session.init(runtimeRelays);
    connected = true;
  }

  const invitationGenerators = { eventKey: generateEventKey, inviteToken: generateInviteToken };

  function boardRelays(boardId: string): string[] {
    const configured = config.boards.find((board) => board.id === boardId)?.relays;
    return configured?.length ? configured : config.relays;
  }


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

  async function publishBoardDefinition(board: BoardEntry): Promise<void> {
    const { signer } = deriveBoardKeyPair(board.id);
    const bTag = boardTagHash(board.id);
    const payload: Record<string, unknown> = {
      name: board.name,
      kind: board.kind ?? "lists",
      columns: board.columns ?? [],
      children: board.children ?? [],
      archived: !!board.archived,
      hidden: !!board.hidden,
      clearCompletedDisabled: !!board.clearCompletedDisabled,
      listIndex: !!board.indexCardEnabled,
      hideBoardNames: !!board.hideChildBoardNames,
      shareSettings: board.shareSettings ?? {},
      sortMode: board.sortMode ?? null,
      sortDirection: board.sortDirection ?? null,
      version: 1,
    };
    const encrypted = await encryptContent(board.id, JSON.stringify(payload));
    const event = session.createEvent();
    event.kind = 30300;
    event.content = encrypted;
    event.tags = [
      ["d", bTag],
      ["b", bTag],
      ["k", board.kind ?? "lists"],
      ["name", board.name],
      ...(board.columns ?? []).map((c): string[] => ["col", c.id, c.name]),
      ...(board.children ?? []).map((child): string[] => ["ch", child]),
      ...(board.sortMode ? [["sort", board.sortMode, board.sortDirection ?? "asc"]] : []),
    ];
    await session.publishSigned(event, signer, board.relays?.length ? board.relays : config.relays);
  }

  const context: RuntimeContext = { config, session, ensureConnected, boardRelays, taskCache, persistConfig, clock, randomUUID, isoNow };
  const tasks = createTaskRepository(context);

  return {
    getDefaultBoardId(): string | null {
      return config.defaultLocation?.boardId ?? config.boards[0]?.id ?? null;
    },

    async disconnect(): Promise<void> {
      await session.shutdown();
      connected = false;
    },

    listTasks: tasks.listTasks,
    createTask: tasks.createTask,
    createTaskFull: tasks.createTaskFull,
    updateTask: tasks.updateTask,
    setTaskStatus: tasks.setTaskStatus,
    deleteTask: tasks.deleteTask,
    toggleSubtask: tasks.toggleSubtask,
    getTask: tasks.getTask,
    applyTaskAssignmentResponse: tasks.applyTaskAssignmentResponse,
    clearCompleted: tasks.clearCompleted,

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

    async createEvent(input): Promise<FullEventRecord> {
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

    async updateEvent(eventId: string, boardId: string | undefined, patch): Promise<FullEventRecord | null> {
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

    async inviteToEvent(this: NostrRuntime, eventId: string, boardId: string | undefined, recipientPubkeyHex: string): Promise<EventInvitation | null> {
      const sender = getUserPubkeyHex(config);
      if (sender && sender === recipientPubkeyHex) throw new Error("You can't invite yourself.");
      const existing = await this.getEvent(eventId, boardId);
      if (!existing) return null;
      const event = await this.updateEvent(existing.id, existing.boardId, {
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

    async syncBoard(boardId: string): Promise<{ name?: string; kind?: string; columns?: { id: string; name: string }[]; children?: string[] }> {
      await ensureConnected();
      const bTag = boardTagHash(boardId);
      const boardPubkey = deriveBoardKeyPair(boardId).pk;
      const rawEvents = await session.fetchEvents(
        [{ kinds: [30300], authors: [boardPubkey], "#b": [bTag], limit: 25 } as never],
        boardRelays(boardId),
        10_000,
      );
      const events = new Set(rawEvents.map((event) => session.createEvent(event)));

      // Use config from closure (avoids extra file read and ensures correct profile)
      const entry = config.boards.find((b) => b.id === boardId);
      if (!entry) return {};

      let name: string | undefined;
      let kind: string | undefined;
      let columns: { id: string; name: string }[] | undefined;
      let children: string[] | undefined;

      if (events.size > 0) {
        const eventLikes: Array<{ tags: string[][]; content: string; created_at?: number }> = [];

        for (const event of events) {
          let content = event.content ?? "";
          if (content) {
            try {
              content = await decryptContent(boardId, content);
            } catch {
              // Non-fatal: keep original content (may be plaintext/JSON, or unusable encrypted payload)
            }
          }
          eventLikes.push({
            tags: event.tags ?? [],
            content,
            created_at: event.created_at,
          });
        }

        // Any member can publish board metadata; its names reach the terminal and the config.
        const meta = sanitizeRemote(pickBestBoardMeta(eventLikes, boardId));
        name = meta.name;
        kind = meta.kind;
        columns = meta.columns;
        children = meta.children;

        if (name) entry.name = name;
        if (kind) entry.kind = kind as BoardEntry["kind"];
        if (columns && columns.length > 0) entry.columns = columns;
        if (children && children.length > 0) entry.children = children;
        if (meta.archived !== undefined) entry.archived = meta.archived;
        if (meta.hidden !== undefined) entry.hidden = meta.hidden;
        if (meta.indexCardEnabled !== undefined) entry.indexCardEnabled = meta.indexCardEnabled;
        if (meta.clearCompletedDisabled !== undefined) entry.clearCompletedDisabled = meta.clearCompletedDisabled;
        if (meta.hideChildBoardNames !== undefined) entry.hideChildBoardNames = meta.hideChildBoardNames;
        if (meta.shareSettings !== undefined) entry.shareSettings = meta.shareSettings;
        // Parse sort tag from board events
        for (const event of events) {
          const sortTag = event.tags.find((t: string[]) => t[0] === "sort");
          if (sortTag?.[1]) {
            entry.sortMode = sortTag[1] as BoardEntry["sortMode"];
            if (sortTag[2]) entry.sortDirection = sortTag[2] as BoardEntry["sortDirection"];
          }
        }
        await persistConfig(config);
      }

      return { name, kind, columns, children };
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

    async remindTask(taskId: string, presets: ReminderPreset[]): Promise<void> {
      // Device-local only — NEVER publish to Nostr
      if (!config.taskReminders) config.taskReminders = {};
      config.taskReminders[taskId] = presets;
      await persistConfig(config);
      process.stderr.write(
        "\x1b[2m  Note: Reminders are device-local and will not sync to other devices\x1b[0m\n",
      );
    },

    getLocalReminders(taskId: string): ReminderPreset[] {
      return config.taskReminders?.[taskId] ?? [];
    },

    async getAgentSecurityConfig(): Promise<AgentSecurityConfig> {
      return {
        enabled: config.securityEnabled,
        mode: config.securityMode,
        trustedNpubs: config.trustedNpubs,
        updatedISO: isoNow(),
      };
    },

    async setAgentSecurityConfig(secCfg: AgentSecurityConfig): Promise<AgentSecurityConfig> {
      config.securityEnabled = secCfg.enabled;
      config.securityMode = secCfg.mode;
      config.trustedNpubs = secCfg.trustedNpubs;
      await persistConfig(config);
      return secCfg;
    },

    async getRelayStatus(): Promise<RelayRuntimeStatus[]> {
      await ensureConnected();
      // Relays that challenge on connect get their AUTH answered within a moment.
      await new Promise((resolve) => setTimeout(resolve, 750));
      return session.relayStatuses();
    },

    async createBoard(input: {
      name: string;
      kind: "lists" | "week" | "compound";
      columns?: { id: string; name: string }[];
      children?: string[];
    }): Promise<{ boardId: string }> {
      await ensureConnected();
      const boardId = randomUUID();

      const newEntry: BoardEntry = {
        id: boardId,
        name: input.name,
        kind: input.kind,
        columns: input.columns ?? [],
        children: input.children ?? [],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
        hideChildBoardNames: false,
      };
      try {
        await publishBoardDefinition(newEntry);
      } catch (err) {
        throw new Error(`Board publish failed: ${String(err)}`);
      }

      config.boards.push(newEntry);
      await persistConfig(config);
      return { boardId };
    },

    async updateBoard(boardId: string, patch: Partial<Pick<BoardEntry, "name" | "archived" | "hidden" | "indexCardEnabled" | "clearCompletedDisabled" | "hideChildBoardNames" | "shareSettings" | "columns" | "children" | "sortMode" | "sortDirection">>): Promise<BoardEntry | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      if (patch.name !== undefined) entry.name = patch.name;
      if (patch.archived !== undefined) entry.archived = patch.archived;
      if (patch.hidden !== undefined) entry.hidden = patch.hidden;
      if (patch.indexCardEnabled !== undefined) entry.indexCardEnabled = patch.indexCardEnabled;
      if (patch.clearCompletedDisabled !== undefined) entry.clearCompletedDisabled = patch.clearCompletedDisabled;
      if (patch.hideChildBoardNames !== undefined) entry.hideChildBoardNames = patch.hideChildBoardNames;
      if (patch.columns !== undefined) entry.columns = patch.columns;
      if (patch.children !== undefined) entry.children = patch.children;
      if (patch.shareSettings !== undefined) entry.shareSettings = patch.shareSettings;
      if (patch.sortMode !== undefined) entry.sortMode = patch.sortMode;
      if (patch.sortDirection !== undefined) entry.sortDirection = patch.sortDirection;
      await publishBoardDefinition(entry);
      await persistConfig(config);
      return entry;
    },
  };
}
