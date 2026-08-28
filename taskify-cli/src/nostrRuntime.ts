import { type NDKEvent } from "@nostr-dev-kit/ndk";
import { getPublicKey, nip19 } from "nostr-tools";
import { boardTagHash, collectRuntimeRelayUrls, deriveBoardKeyPair } from "taskify-runtime-nostr";
import type { ReminderPreset, Recurrence, Subtask, TaskAssignee } from "./shared/taskTypes.js";
import type { AgentTaskCreateInput, AgentTaskPatchInput, AgentTaskStatus } from "./shared/agentRuntime.js";
import type { AgentSecurityConfig } from "./shared/agentSecurity.js";
import type { TaskifyConfig, BoardEntry } from "./config.js";
import { saveConfig } from "./config.js";
import { incrementalSyncSince, readCache, writeCache, type CachedTask } from "./taskCache.js";
import { pickBestBoardMeta } from "./shared/boardMeta.js";
import {
  compareReplaceableEvents,
  pickLatestParsedEvent,
  pickLatestParsedEventsByKey,
} from "./shared/latestEvent.js";
import {
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  parseCalendarCanonicalPayload,
  calendarAddress,
  encryptToBoard,
  decryptFromBoard,
  resolveBoardReference,
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
} from "./calendarCrypto.js";
import {
  buildCalendarCanonicalEnvelope,
  buildCalendarViewEnvelope,
} from "./shared/calendarEnvelope.js";
import { createCliNostrSession } from "./shared/nodeRuntimeSession.js";

function nowISO(): string {
  return new Date().toISOString();
}

// ---- Internal helpers (not exported) ----

async function encryptContent(boardId: string, plaintext: string): Promise<string> {
  return encryptToBoard(boardId, plaintext);
}

async function decryptContent(boardId: string, data: string): Promise<string> {
  const result = await decryptFromBoard(boardId, data);
  return result.plaintext;
}

function getUserPubkeyHex(config: TaskifyConfig): string | undefined {
  if (!config.nsec) return undefined;
  try {
    const decoded = nip19.decode(config.nsec);
    if (decoded.type === "nsec") {
      return getPublicKey(decoded.data as Uint8Array);
    }
  } catch {
    // ignore
  }
  return undefined;
}

function validateEventCompat(event: NDKEvent): boolean {
  if (event.kind !== 30301) return false;
  const hasD = event.tags.some((t) => t[0] === "d");
  const hasB = event.tags.some((t) => t[0] === "b");
  if (!hasD || !hasB) return false;
  if (!event.content) return false;
  return true;
}

function validateCalendarEventCompat(event: NDKEvent): boolean {
  if (event.kind !== TASKIFY_CALENDAR_EVENT_KIND) return false;
  const hasD = event.tags.some((t) => t[0] === "d");
  const hasB = event.tags.some((t) => t[0] === "b");
  if (!hasD || !hasB) return false;
  if (!event.content) return false;
  return true;
}

function resolveBoardEntry(config: TaskifyConfig, boardIdOrName: string): BoardEntry | null {
  return resolveBoardReference(config.boards, boardIdOrName);
}

// ---- Cache conversion helpers ----

function recordToCache(r: FullTaskRecord): CachedTask {
  return {
    id: r.id,
    title: r.title,
    boardId: r.boardId,
    boardName: r.boardName,
    status: r.deleted ? "deleted" : r.completed ? "done" : "open",
    updatedAt: r.createdAt,
    note: r.note,
    dueISO: r.dueISO,
    dueDateEnabled: r.dueDateEnabled,
    dueTimeEnabled: r.dueTimeEnabled,
    dueTimeZone: r.dueTimeZone,
    priority: r.priority,
    completed: r.completed,
    completedAt: r.completedAt,
    completedBy: r.completedBy,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    lastEditedBy: r.lastEditedBy,
    column: r.column,
    subtasks: r.subtasks,
    recurrence: r.recurrence,
    bounty: r.bounty,
    reminders: r.reminders,
    inboxItem: r.inboxItem,
    assignees: r.assignees,
    documents: r.documents,
    hiddenUntilISO: r.hiddenUntilISO,
    streak: r.streak,
    longestStreak: r.longestStreak,
    seriesId: r.seriesId,
    images: r.images,
    nostrEventId: r.nostrEventId,
    deleted: r.deleted,
  };
}

function cacheToRecord(t: CachedTask, boardName?: string): FullTaskRecord {
  return {
    id: t.id,
    boardId: t.boardId,
    boardName: t.boardName ?? boardName,
    title: t.title,
    note: t.note,
    dueISO: t.dueISO ?? "",
    dueDateEnabled: t.dueDateEnabled,
    dueTimeEnabled: t.dueTimeEnabled,
    dueTimeZone: t.dueTimeZone,
    priority: t.priority,
    completed: t.status === "done",
    completedAt: t.completedAt,
    completedBy: t.completedBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt
      ? new Date(t.updatedAt * 1000).toISOString()
      : undefined,
    createdBy: t.createdBy,
    lastEditedBy: t.lastEditedBy,
    column: t.column,
    subtasks: t.subtasks,
    recurrence: t.recurrence as Recurrence | undefined,
    bounty: t.bounty,
    reminders: t.reminders,
    inboxItem: t.inboxItem,
    assignees: t.assignees as TaskAssignee[] | undefined,
    documents: t.documents as Record<string, unknown>[] | undefined,
    hiddenUntilISO: t.hiddenUntilISO,
    streak: t.streak,
    longestStreak: t.longestStreak,
    seriesId: t.seriesId,
    images: t.images,
    nostrEventId: t.nostrEventId,
    deleted: t.status === "deleted",
  };
}

// ---- Public types ----

export type FullTaskRecord = {
  id: string;              // UUID from the "d" tag
  boardId: string;         // raw board UUID
  boardName?: string;
  title: string;
  note?: string;
  dueISO: string;
  dueDateEnabled?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  priority?: 1 | 2 | 3;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  createdAt?: number;      // Unix seconds (for render compat)
  updatedAt?: string;
  createdBy?: string;      // hex pubkey
  lastEditedBy?: string;   // hex pubkey
  recurrence?: Recurrence;
  subtasks?: Subtask[];
  bounty?: object;
  reminders?: ReminderPreset[];
  column?: string;         // col tag value (column ID)
  sourceBoardId?: string;
  inboxItem?: boolean;
  assignees?: TaskAssignee[];
  documents?: Record<string, unknown>[];
  hiddenUntilISO?: string;
  streak?: number;
  longestStreak?: number;
  seriesId?: string;
  images?: string[];
  deleted?: boolean;
  /** Signed relay event id for deterministic equal-timestamp replacement. */
  nostrEventId?: string;
};

export type ExtendedCreateInput = AgentTaskCreateInput & {
  subtasks?: Subtask[];
  inboxItem?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  hiddenUntilISO?: string;
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
  listTasks(options: {
    boardId?: string;
    status: "open" | "done" | "any";
    columnId?: string;
    refresh?: boolean;
    noCache?: boolean;
  }): Promise<FullTaskRecord[]>;
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
  getRelayStatus(): Promise<{ url: string; connected: boolean }[]>;
};

// ---- Event parsing ----

type DecryptedPayload = Record<string, any>;

async function decryptTaskEventPayload(event: NDKEvent, boardId: string): Promise<DecryptedPayload> {
  const plaintext = await decryptContent(boardId, event.content);
  return JSON.parse(plaintext) as DecryptedPayload;
}

async function decryptCalendarEventPayload(event: NDKEvent, boardId: string): Promise<DecryptedPayload | null> {
  try {
    const boardKeys = deriveBoardKeyPair(boardId);
    return await decryptCalendarPayloadForBoard(event.content, boardKeys.skHex, boardKeys.pk) as DecryptedPayload;
  } catch {
    return null;
  }
}

async function parseDecryptedEvent(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullTaskRecord | null> {
  if (!validateEventCompat(event)) return null;
  if (event.pubkey !== deriveBoardKeyPair(boardId).pk) return null;
  try {
    const payload = await decryptTaskEventPayload(event, boardId);
    const taskId = readTagValue(event.tags, "d") ?? "";
    if (!taskId) return null;
    const statusVal = readStatusTag(event.tags, "open");
    const completed = statusVal === "done";
    const deleted = statusVal === "deleted";
    const column = readTagValue(event.tags, "col") || undefined;
    return {
      id: taskId,
      boardId,
      boardName,
      title: payload.title ?? "",
      note: payload.note || undefined,
      dueISO: payload.dueISO ?? "",
      dueDateEnabled: payload.dueDateEnabled ?? undefined,
      dueTimeEnabled: payload.dueTimeEnabled ?? undefined,
      priority: payload.priority ?? undefined,
      completed,
      completedAt: payload.completedAt ?? undefined,
      // payload.createdAt is ms; convert to seconds for render compat
      // Use relay event timestamp for merge ordering/version selection.
      // payload.createdAt is the original task creation time and does NOT change
      // on edits/completions, so using it causes stale open versions to beat
      // newer done/updated versions during incremental sync merges.
      createdAt: event.created_at ?? (payload.createdAt ? Math.floor(payload.createdAt / 1000) : undefined),
      updatedAt: event.created_at
        ? new Date(event.created_at * 1000).toISOString()
        : undefined,
      createdBy: payload.createdBy,
      lastEditedBy: payload.lastEditedBy,
      recurrence: payload.recurrence ?? undefined,
      subtasks: payload.subtasks ?? undefined,
      bounty: payload.bounty ?? undefined,
      column,
      inboxItem: payload.inboxItem === true ? true : undefined,
      assignees: Array.isArray(payload.assignees) && payload.assignees.length > 0
        ? (payload.assignees as Array<unknown>)
          .map((a) => {
            if (typeof a === "string") return { pubkey: a };
            if (!a || typeof a !== "object") return null;
            const obj = a as Record<string, unknown>;
            const pubkey = typeof obj.pubkey === "string" ? obj.pubkey : "";
            if (!pubkey) return null;
            return {
              pubkey,
              relay: typeof obj.relay === "string" ? obj.relay : undefined,
              status: obj.status === "pending" || obj.status === "accepted" || obj.status === "declined" || obj.status === "tentative"
                ? obj.status
                : undefined,
              respondedAt: typeof obj.respondedAt === "number" ? Math.round(obj.respondedAt) : undefined,
            };
          })
          .filter((a): a is TaskAssignee => !!a)
        : undefined,
      documents: Array.isArray(payload.documents) ? (payload.documents as Record<string, unknown>[]) : undefined,
      dueTimeZone: payload.dueTimeZone ?? undefined,
      hiddenUntilISO: payload.hiddenUntilISO ?? undefined,
      streak: typeof payload.streak === "number" ? payload.streak : undefined,
      longestStreak: typeof payload.longestStreak === "number" ? payload.longestStreak : undefined,
      seriesId: typeof payload.seriesId === "string" ? payload.seriesId : undefined,
      completedBy: payload.completedBy ?? undefined,
      images: Array.isArray(payload.images) ? payload.images as string[] : undefined,
      deleted,
      nostrEventId: event.id,
    };
  } catch {
    return null;
  }
}

async function parseDecryptedCalendarEvent(
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

export function createNostrRuntime(config: TaskifyConfig): NostrRuntime {
  const runtimeRelays = collectRuntimeRelayUrls(config.relays, config.boards);
  const { session } = createCliNostrSession(config);

  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    await session.init(runtimeRelays);
    connected = true;
  }

  function boardRelays(boardId: string): string[] {
    const configured = config.boards.find((board) => board.id === boardId)?.relays;
    return configured?.length ? configured : config.relays;
  }

  async function fetchBoardEvents(boardId: string, taskId?: string, since?: number): Promise<Set<NDKEvent>> {
    const bTag = boardTagHash(boardId);
    const boardPubkey = deriveBoardKeyPair(boardId).pk;
    const filter: Record<string, unknown> = {
      kinds: [30301],
      authors: [boardPubkey],
      "#b": [bTag],
      // An unbounded cold query is required to build a complete local baseline.
      // Relays already paginate/cap responses according to their own policies; an
      // additional client-side limit silently omitted older active tasks.
      ...(since !== undefined ? { since } : {}),
    };
    if (taskId) filter["#d"] = [taskId];

    const isCursor = since !== undefined && !taskId;
    const events = await session.fetchEvents(
      [filter as never],
      boardRelays(boardId),
      taskId ? 8_000 : isCursor ? 5_000 : 12_000,
      isCursor ? 150 : 200,
      taskId ? 2_000 : isCursor ? 1_000 : 3_000,
    );
    return new Set(events.map((event) => session.createEvent(event)));
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

  // Resolve from the local full-state cache first, then fall back to relay tags.
  async function resolveTaskId(boardId: string, taskIdOrPrefix: string): Promise<string | null> {
    const exact = taskIdOrPrefix.trim();
    // Standard UUID (36 chars) — return directly without a relay lookup
    if (exact.length === 36) return exact;

    const cachedTasks = readCache().boards[boardId]?.tasks ?? [];
    const cached = resolveIdentifierReference(cachedTasks, exact);
    if (cached) return cached.id;

    const allEvents = await fetchBoardEvents(boardId);
    const entries = Array.from(allEvents)
      .map((event) => ({ id: readTagValue(event.tags, "d") ?? "" }))
      .filter((entry) => entry.id);

    // For recurring instance IDs ("recurrence:...") the full ID can be >36 chars.
    // resolveIdentifierReference does an exact-match first, so passing the full
    // recurrence ID will always land on the right instance.
    return resolveIdentifierReference(entries, taskIdOrPrefix)?.id ?? null;
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

  async function publishTaskEvent(
    boardId: string,
    taskId: string,
    payload: Record<string, unknown>,
    status: "open" | "done" | "deleted",
    colId: string = "",
    afterCreatedAt?: number,
  ): Promise<NDKEvent> {
    const { signer } = deriveBoardKeyPair(boardId);
    const bTag = boardTagHash(boardId);
    const encrypted = await encryptContent(boardId, JSON.stringify(payload));
    const event = session.createEvent();
    event.created_at = Math.max(
      Math.floor(Date.now() / 1000),
      typeof afterCreatedAt === "number" ? afterCreatedAt + 1 : 0,
    );
    event.kind = 30301;
    event.content = encrypted;
    event.tags = [
      ["d", taskId],
      ["b", bTag],
      ["col", colId],
      ["status", status],
    ];
    await event.sign(signer);
    await session.publishRaw(event.rawEvent(), { relayUrls: boardRelays(boardId) });
    return event;
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
      Math.floor(Date.now() / 1000),
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
    await event.sign(boardKeys.signer);
    try {
      await session.publishRaw(event.rawEvent(), { relayUrls: boardRelays(boardId) });
      const viewEvent = session.createEvent();
      viewEvent.kind = TASKIFY_CALENDAR_VIEW_KIND;
      viewEvent.created_at = event.created_at;
      viewEvent.content = await encryptCalendarPayloadWithEventKey(viewPayload, eventKey);
      viewEvent.tags = [
        ["d", calEventId],
        ["a", calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, calEventId)],
      ];
      await viewEvent.sign(boardKeys.signer);
      await session.publishRaw(viewEvent.rawEvent(), { relayUrls: boardRelays(boardId) });
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
    await event.sign(signer);
    await session.publishRaw(event.rawEvent(), { relayUrls: board.relays?.length ? board.relays : config.relays });
  }

  return {
    getDefaultBoardId(): string | null {
      return config.defaultLocation?.boardId ?? config.boards[0]?.id ?? null;
    },

    async disconnect(): Promise<void> {
      await session.shutdown();
      connected = false;
    },

    async listTasks({ boardId, status, columnId, refresh, noCache }): Promise<FullTaskRecord[]> {
      const boards: BoardEntry[] = [];
      if (boardId) {
        const entry = resolveBoardEntry(config, boardId);
        if (!entry) {
          throw new Error(
            `Board not found in config: "${boardId}". Use: taskify board join <id> --name <name>`,
          );
        }
        boards.push(entry);
      } else {
        boards.push(...config.boards);
      }
      if (boards.length === 0) return [];

      const cache = readCache();
      const records: FullTaskRecord[] = [];

      for (const board of boards) {
        // Compound board: aggregate tasks from children
        if (board.kind === "compound") {
          await ensureConnected();
          const childIds = board.children ?? [];
          const seen = new Set<string>();
          const childResults = await Promise.all(childIds.map(async (childId) => {
            const childEntry = resolveBoardEntry(config, childId) ?? { id: childId, name: childId };
            const childEvents = await fetchBoardEvents(childId);
            const latest = await pickLatestParsedEventsByKey(
              childEvents,
              (event) => readTagValue(event.tags, "d"),
              (event) => parseDecryptedEvent(event, childId, (childEntry as BoardEntry).name ?? childId),
            );
            return { childId, latest };
          }));
          for (const { childId, latest } of childResults) {
            for (const { parsed: record } of latest.values()) {
              if (seen.has(record.id)) continue;
              seen.add(record.id);
              record.sourceBoardId = childId;
              if (record.deleted) continue;
              if (status === "open" && record.completed) continue;
              if (status === "done" && !record.completed) continue;
              if (columnId !== undefined && record.column !== columnId) continue;
              records.push(record);
            }
          }
          continue;
        }

        const boardCache = cache.boards[board.id];

        // Cursor-based incremental fetch:
        // - If we have a prior sync cursor, fetch only events since then (- 5 min buffer for clock skew).
        // - First run or --no-cache: fetch the complete relay history without a date cutoff.
        // - If cursor is set but cache is empty (e.g. cleared), fall back to cold fetch.
        await ensureConnected();
        const since = incrementalSyncSince(boardCache, { refresh, noCache });
        const hasCursor = since !== undefined;

        const events = await fetchBoardEvents(board.id, undefined, since);
        const latestIncoming = await pickLatestParsedEventsByKey(
          events,
          (event) => readTagValue(event.tags, "d"),
          (event) => parseDecryptedEvent(event, board.id, board.name),
        );
        const incomingRecords = Array.from(latestIncoming.values(), ({ parsed }) => parsed);
        let maxCreatedAt = hasCursor ? (boardCache?.lastSyncAt ?? 0) : 0;
        for (const { event } of latestIncoming.values()) {
          if (event.created_at && event.created_at > maxCreatedAt) {
            maxCreatedAt = event.created_at;
          }
        }

        // Merge: latest created_at per task ID wins.
        // Start from cached tasks, overlay incoming (which are newer by since filter).
        let mergedRecords: FullTaskRecord[];
        if (hasCursor && boardCache) {
          // Incremental: merge incoming over the existing cache
          const byId = new Map<string, FullTaskRecord>();
          for (const t of boardCache.tasks) byId.set(t.id, cacheToRecord(t, board.name));
          // If the latest incoming version is deleted, keep it in the merge map so it
          // suppresses older cached open/done versions. Filtering happens later.
          for (const r of incomingRecords) {
            const existing = byId.get(r.id);
            if (!existing || compareReplaceableEvents(
              { created_at: r.createdAt, id: r.nostrEventId },
              { created_at: existing.createdAt, id: existing.nostrEventId },
            ) > 0) {
              byId.set(r.id, r);
            }
          }
          mergedRecords = Array.from(byId.values());
        } else {
          // Cold fetch: the per-id latest incoming revisions are the full state.
          mergedRecords = incomingRecords;
        }

        // A3/A2: guard against caching an empty result when previous data exists
        if (mergedRecords.length === 0 && boardCache && !noCache) {
          const cacheAgeMs = Date.now() - boardCache.fetchedAt;
          const TEN_MIN_MS = 10 * 60 * 1000;
          if (cacheAgeMs <= TEN_MIN_MS) {
            // A3: cache ≤ 10 min old — silently fall back
            for (const t of boardCache.tasks) {
              const rec = cacheToRecord(t, board.name);
              if (rec.deleted) continue;
              if (status === "open" && rec.completed) continue;
              if (status === "done" && !rec.completed) continue;
              if (columnId !== undefined && rec.column !== columnId) continue;
              records.push(rec);
            }
            continue;
          } else if (boardCache.tasks.length > 0) {
            // A2: stale cache has tasks — warn and keep
            process.stderr.write("⚠ Relay returned 0 tasks — keeping cached results\n");
            for (const t of boardCache.tasks) {
              const rec = cacheToRecord(t, board.name);
              if (rec.deleted) continue;
              if (status === "open" && rec.completed) continue;
              if (status === "done" && !rec.completed) continue;
              if (columnId !== undefined && rec.column !== columnId) continue;
              records.push(rec);
            }
            continue;
          }
        }

        // Write merged state to cache, advancing the sync cursor.
        cache.boards[board.id] = {
          tasks: mergedRecords.map(recordToCache),
          fetchedAt: Date.now(),
          ...(maxCreatedAt > 0 ? { lastSyncAt: maxCreatedAt } : {}),
        };

        // Filter for the caller
        for (const record of mergedRecords) {
          if (record.deleted) continue;
          if (columnId !== undefined && record.column !== columnId) continue;
          if (status === "open" && record.completed) continue;
          if (status === "done" && !record.completed) continue;
          records.push(record);
        }
      }

      writeCache(cache);
      records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return records;
    },

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
      const id = crypto.randomUUID();
      const now = Date.now();
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
      const eventKey = generateEventKey();
      const userPubkey = getUserPubkeyHex(config);
      // Merge extra fields not handled by normalizeCalendarMutationPayload
      const payload: Record<string, unknown> = {
        ...normalized,
        ...(userPubkey ? { createdBy: userPubkey, lastEditedBy: userPubkey } : {}),
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
        existing.createdAt ? existing.createdAt * 1000 : Date.now(),
      );
      if (!normalized) return null;
      const mergedPayload: Record<string, unknown> = {
        ...normalized,
        ...(existing.createdBy ? { createdBy: existing.createdBy } : {}),
        ...(getUserPubkeyHex(config) || existing.lastEditedBy
          ? { lastEditedBy: getUserPubkeyHex(config) || existing.lastEditedBy }
          : {}),
        ...(existing.inviteTokens ? { inviteTokens: existing.inviteTokens } : {}),
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
        existing.eventKey,
        mergedPayload,
        "open",
        colId,
        existing.createdAt,
      );
      return {
        id: resolvedId,
        boardId: entry.id,
        boardName: entry.name,
        eventKey: existing.eventKey,
        createdBy: existing.createdBy,
        lastEditedBy: getUserPubkeyHex(config) || existing.lastEditedBy,
        inviteTokens: existing.inviteTokens,
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
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : nowISO(),
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
        existing.createdAt ? existing.createdAt * 1000 : Date.now(),
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

        const meta = pickBestBoardMeta(eventLikes, boardId);
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
        await saveConfig(config);
      }

      return { name, kind, columns, children };
    },

    async createTask(input: AgentTaskCreateInput): Promise<FullTaskRecord> {
      return (this as NostrRuntime).createTaskFull(input);
    },

    async createTaskFull(input: ExtendedCreateInput): Promise<FullTaskRecord> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, input.boardId);
      if (!entry) {
        throw new Error(
          `Board not found in config: "${input.boardId}". Use: taskify board join <id> --name <name>`,
        );
      }
      const boardId = entry.id;
      const taskId = input.taskId?.trim() || crypto.randomUUID();
      const userPubkey = getUserPubkeyHex(config);
      if (!userPubkey) {
        process.stderr.write(
          "\x1b[33m(warning: no nsec configured — createdBy/lastEditedBy will be empty)\x1b[0m\n",
        );
      }
      const now = Date.now();
      const payload: Record<string, unknown> = {
        title: input.title,
        priority: input.priority ?? null,
        note: input.note ?? "",
        dueISO: input.dueISO ?? "",
        completedAt: null,
        completedBy: null,
        recurrence: input.recurrence ?? null,
        createdBy: userPubkey,
        lastEditedBy: userPubkey,
        createdAt: now,
        streak: null,
        longestStreak: null,
        seriesId: null,
        dueDateEnabled: input.dueISO ? true : null,
        dueTimeEnabled: input.dueTimeEnabled ?? null,
        dueTimeZone: input.dueTimeZone ?? null,
        hiddenUntilISO: input.hiddenUntilISO ?? null,
        images: null,
        documents: input.documents ?? null,
        bounty: null,
        subtasks: input.subtasks ?? null,
        assignees: input.assignees ?? null,
        inboxItem: input.inboxItem === true ? true : null,
      };
      // Resolve column: explicit > first list column > week-board canonical day marker > ""
      let colId = "";
      if (input.columnId !== undefined) {
        colId = input.columnId;
      } else if (entry.kind === "lists" && Array.isArray(entry.columns) && entry.columns.length > 0) {
        colId = entry.columns[0].id;
      } else if (entry.kind === "week") {
        colId = "day";
      }
      const published = await publishTaskEvent(boardId, taskId, payload, "open", colId);
      const result: FullTaskRecord = {
        id: taskId,
        boardId,
        boardName: entry.name,
        title: input.title,
        note: input.note || undefined,
        dueISO: input.dueISO ?? "",
        dueDateEnabled: input.dueISO ? true : undefined,
        dueTimeEnabled: input.dueTimeEnabled ?? undefined,
        dueTimeZone: input.dueTimeZone ?? undefined,
        hiddenUntilISO: input.hiddenUntilISO ?? undefined,
        priority: input.priority,
        completed: false,
        createdAt: published.created_at ?? Math.floor(now / 1000),
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : undefined,
        nostrEventId: published.id,
        createdBy: userPubkey,
        lastEditedBy: userPubkey,
        subtasks: input.subtasks,
        recurrence: input.recurrence as Recurrence | undefined,
        documents: input.documents,
        column: colId || undefined,
        inboxItem: input.inboxItem === true ? true : undefined,
        assignees: input.assignees,
      };
      // Update cache with the new task
      const cache = readCache();
      const boardCache = cache.boards[boardId] ?? { tasks: [], fetchedAt: Date.now() };
      boardCache.tasks = boardCache.tasks.filter((t) => t.id !== taskId);
      boardCache.tasks.push(recordToCache(result));
      cache.boards[boardId] = boardCache;
      writeCache(cache);
      return result;
    },

    async updateTask(
      taskId: string,
      boardId: string,
      patch: AgentTaskPatchInput,
    ): Promise<FullTaskRecord | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      const resolvedId = await resolveTaskId(entry.id, taskId);
      if (!resolvedId) return null;
      taskId = resolvedId;
      const events = await fetchBoardEvents(entry.id, taskId);
      const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, entry.id, entry.name));
      if (!latest) return null;
      const { event, parsed: existing } = latest;
      const rawPayload = await decryptTaskEventPayload(event, entry.id);
      const userPubkey = getUserPubkeyHex(config);
      const merged: DecryptedPayload = {
        ...rawPayload,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.note !== undefined ? { note: patch.note ?? "" } : {}),
        ...(patch.dueISO !== undefined ? { dueISO: patch.dueISO ?? "" } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority ?? null } : {}),
        ...(patch.inboxItem !== undefined ? { inboxItem: patch.inboxItem } : {}),
        ...(patch.assignees !== undefined ? { assignees: patch.assignees } : {}),
        ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
        ...(patch.documents !== undefined ? { documents: patch.documents } : {}),
        ...(patch.dueTimeEnabled !== undefined ? { dueTimeEnabled: patch.dueTimeEnabled } : {}),
        ...(patch.dueTimeZone !== undefined ? { dueTimeZone: patch.dueTimeZone } : {}),
        ...(patch.hiddenUntilISO !== undefined ? { hiddenUntilISO: patch.hiddenUntilISO } : {}),
        lastEditedBy: userPubkey,
      };
      // reminders are device-local only — strip from published payload
      delete merged.reminders;
      const statusTag = event.tags.find((t) => t[0] === "status");
      const status = (statusTag?.[1] ?? "open") as "open" | "done" | "deleted";
      const colTag = event.tags.find((t) => t[0] === "col");
      const existingColId = colTag?.[1] ?? "";
      const colId = patch.columnId !== undefined ? (patch.columnId ?? "") : existingColId;
      const published = await publishTaskEvent(entry.id, taskId, merged, status, colId, event.created_at);
      // Build updated FullTaskRecord — keep assignees as string[] (extract pubkeys)
      const updatedAssignees: TaskAssignee[] | undefined = patch.assignees !== undefined
        ? patch.assignees
        : existing.assignees;
      const updated: FullTaskRecord = {
        ...existing,
        title: merged.title ?? existing.title,
        note: merged.note || undefined,
        dueISO: merged.dueISO ?? existing.dueISO,
        priority: merged.priority ?? undefined,
        inboxItem: merged.inboxItem === true ? true : undefined,
        assignees: updatedAssignees,
        recurrence: (merged.recurrence as Recurrence | null | undefined) ?? undefined,
        documents: (merged.documents as Record<string, unknown>[] | null | undefined) ?? undefined,
        dueTimeEnabled: merged.dueTimeEnabled ?? existing.dueTimeEnabled,
        dueTimeZone: (merged.dueTimeZone as string | null | undefined) ?? existing.dueTimeZone,
        hiddenUntilISO: (merged.hiddenUntilISO as string | null | undefined) ?? existing.hiddenUntilISO,
        lastEditedBy: merged.lastEditedBy,
        createdAt: published.created_at ?? existing.createdAt,
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : existing.updatedAt,
        nostrEventId: published.id,
      };
      if (patch.columnId !== undefined) updated.column = colId || undefined;
      // Invalidate cache entry
      const cache = readCache();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId);
        bc.tasks.push(recordToCache(updated));
        writeCache(cache);
      }
      return updated;
    },

    async setTaskStatus(
      taskId: string,
      status: AgentTaskStatus,
      boardId: string,
    ): Promise<FullTaskRecord | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      const resolvedId = await resolveTaskId(entry.id, taskId);
      if (!resolvedId) return null;
      taskId = resolvedId;
      const events = await fetchBoardEvents(entry.id, taskId);
      const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, entry.id, entry.name));
      if (!latest) return null;
      const { event, parsed: existing } = latest;
      const rawPayload = await decryptTaskEventPayload(event, entry.id);
      const userPubkey = getUserPubkeyHex(config);
      const completed = status === "done";
      const merged = {
        ...rawPayload,
        completedAt: completed ? nowISO() : null,
        lastEditedBy: userPubkey,
      };
      const nostrStatus: "open" | "done" | "deleted" = completed ? "done" : "open";
      const colTag = event.tags.find((t) => t[0] === "col");
      const colId = colTag?.[1] ?? "";
      const published = await publishTaskEvent(entry.id, taskId, merged, nostrStatus, colId, event.created_at);
      const updated = {
        ...existing,
        completed,
        completedAt: merged.completedAt ?? undefined,
        createdAt: published.created_at ?? existing.createdAt,
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : existing.updatedAt,
        nostrEventId: published.id,
      };
      // Update cache
      const cache = readCache();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId);
        bc.tasks.push(recordToCache(updated));
        writeCache(cache);
      }
      return updated;
    },

    async deleteTask(taskId: string, boardId: string): Promise<FullTaskRecord | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      const resolvedId = await resolveTaskId(entry.id, taskId);
      if (!resolvedId) return null;
      taskId = resolvedId;
      const events = await fetchBoardEvents(entry.id, taskId);
      const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, entry.id, entry.name));
      if (!latest) return null;
      const { event, parsed: existing } = latest;
      const rawPayload = await decryptTaskEventPayload(event, entry.id);
      const colTag = event.tags.find((t) => t[0] === "col");
      const colId = colTag?.[1] ?? "";

      // Step 1: publish kind 30301 status=deleted (app-level soft delete)
      await publishTaskEvent(entry.id, taskId, rawPayload, "deleted", colId, event.created_at);

      // Step 2: publish NIP-09 kind 5 deletion request (matches PWA's publishTaskDeletionRequest)
      const boardKeys = deriveBoardKeyPair(entry.id);
      const aTag = `30301:${boardKeys.pk}:${taskId}`;
      try {
        const nip09Event = session.createEvent();
        nip09Event.kind = 5;
        nip09Event.content = "Task deleted";
        nip09Event.tags = [["a", aTag]];
        nip09Event.created_at = Math.floor(Date.now() / 1000);
        await nip09Event.sign(boardKeys.signer);
        await session.publishRaw(nip09Event.rawEvent(), { relayUrls: boardRelays(entry.id) });
      } catch {
        // Non-fatal: NIP-09 relay support varies; soft delete already published
      }

      // Remove from cache
      const cache = readCache();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId);
        writeCache(cache);
      }

      return existing;
    },

    async toggleSubtask(
      taskId: string,
      boardId: string,
      subtaskRef: string,
      completed: boolean,
    ): Promise<FullTaskRecord | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      const resolvedId = await resolveTaskId(entry.id, taskId);
      if (!resolvedId) return null;
      taskId = resolvedId;
      const events = await fetchBoardEvents(entry.id, taskId);
      const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, entry.id, entry.name));
      if (!latest) return null;
      const { event, parsed: existing } = latest;
      const rawPayload = await decryptTaskEventPayload(event, entry.id);
      const subtasks: Array<{ id: string; title: string; completed: boolean }> =
        rawPayload.subtasks ?? [];
      // Resolve by 1-based index or title substring
      const indexNum = parseInt(subtaskRef, 10);
      let targetIdx = -1;
      if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= subtasks.length) {
        targetIdx = indexNum - 1;
      } else {
        const lower = subtaskRef.toLowerCase();
        targetIdx = subtasks.findIndex((s) => s.title.toLowerCase().includes(lower));
      }
      if (targetIdx === -1) {
        throw new Error(`Subtask not found: ${subtaskRef}`);
      }
      subtasks[targetIdx] = { ...subtasks[targetIdx], completed };
      rawPayload.subtasks = subtasks;
      const statusTag = event.tags.find((t) => t[0] === "status");
      const status = (statusTag?.[1] ?? "open") as "open" | "done" | "deleted";
      const colTag = event.tags.find((t) => t[0] === "col");
      const colId = colTag?.[1] ?? "";
      const published = await publishTaskEvent(entry.id, taskId, rawPayload, status, colId, event.created_at);
      return {
        ...existing,
        subtasks,
        createdAt: published.created_at ?? existing.createdAt,
        updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : existing.updatedAt,
        nostrEventId: published.id,
      };
    },

    async getTask(taskId: string, boardId?: string): Promise<FullTaskRecord | null> {
      await ensureConnected();
      const boards: BoardEntry[] = [];
      if (boardId) {
        const entry = resolveBoardEntry(config, boardId);
        if (entry) boards.push(entry);
      } else {
        boards.push(...config.boards);
      }
      for (const board of boards) {
        const resolvedId = await resolveTaskId(board.id, taskId);
        if (!resolvedId) continue;
        const events = await fetchBoardEvents(board.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, board.id, board.name));
        if (latest) return latest.parsed;
      }
      return null;
    },

    async applyTaskAssignmentResponse(taskId: string, senderPubkey: string, status: "accepted" | "declined" | "tentative", respondedAt?: string): Promise<FullTaskRecord | null> {
      await ensureConnected();
      for (const entry of config.boards) {
        const resolvedId = await resolveTaskId(entry.id, taskId);
        if (!resolvedId) continue;
        const events = await fetchBoardEvents(entry.id, resolvedId);
        const latest = await pickLatestParsedEvent(events, (event) => parseDecryptedEvent(event, entry.id, entry.name));
        if (!latest) continue;
        const { event, parsed: existing } = latest;
        const rawPayload = await decryptTaskEventPayload(event, entry.id);
        const assignees = Array.isArray(rawPayload.assignees) ? rawPayload.assignees : [];
        const idx = assignees.findIndex((a: any) => (typeof a === "string" ? a : a?.pubkey) === senderPubkey);
        const respondedEpoch = respondedAt ? Math.floor(new Date(respondedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
        if (idx >= 0) {
          const prev = assignees[idx];
          assignees[idx] = typeof prev === "string" ? { pubkey: prev, status, respondedAt: respondedEpoch } : { ...prev, status, respondedAt: respondedEpoch };
        } else {
          assignees.push({ pubkey: senderPubkey, status, respondedAt: respondedEpoch });
        }
        rawPayload.assignees = assignees;
        const statusTag = event.tags.find((t) => t[0] === "status");
        const nostrStatus = (statusTag?.[1] ?? "open") as "open" | "done" | "deleted";
        const colId = readTagValue(event.tags, "col") ?? "";
        const published = await publishTaskEvent(entry.id, resolvedId, rawPayload, nostrStatus, colId, event.created_at);
        return {
          ...existing,
          assignees: assignees as TaskAssignee[],
          createdAt: published.created_at ?? existing.createdAt,
          updatedAt: published.created_at ? new Date(published.created_at * 1000).toISOString() : existing.updatedAt,
          nostrEventId: published.id,
        };
      }
      return null;
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
        rawPayload.rsvpCreatedAt = respondedAt ? Math.floor(new Date(respondedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
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
      await saveConfig(config);
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
        updatedISO: nowISO(),
      };
    },

    async setAgentSecurityConfig(secCfg: AgentSecurityConfig): Promise<AgentSecurityConfig> {
      config.securityEnabled = secCfg.enabled;
      config.securityMode = secCfg.mode;
      config.trustedNpubs = secCfg.trustedNpubs;
      await saveConfig(config);
      return secCfg;
    },

    async getRelayStatus(): Promise<{ url: string; connected: boolean }[]> {
      await ensureConnected();
      return session.relayStatuses().map(({ url, connected }) => ({ url, connected }));
    },

    async createBoard(input: {
      name: string;
      kind: "lists" | "week" | "compound";
      columns?: { id: string; name: string }[];
      children?: string[];
    }): Promise<{ boardId: string }> {
      await ensureConnected();
      const boardId = crypto.randomUUID();

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
      await saveConfig(config);
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
      await saveConfig(config);
      return entry;
    },

    async clearCompleted(boardId: string): Promise<number> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return 0;
      if (entry.clearCompletedDisabled === true) {
        throw new Error("Clear completed is disabled on this board.");
      }
      const events = await fetchBoardEvents(entry.id);
      const latestByTask = await pickLatestParsedEventsByKey(
        events,
        (event) => readTagValue(event.tags, "d"),
        (event) => parseDecryptedEvent(event, entry.id, entry.name),
      );
      let removed = 0;
      for (const { event, parsed: task } of latestByTask.values()) {
        if (!task.completed || task.deleted) continue;
        const plaintext = await decryptContent(entry.id, event.content);
        const rawPayload = JSON.parse(plaintext);
        const colTag = event.tags.find((t) => t[0] === "col");
        const colId = colTag?.[1] ?? "";
        await publishTaskEvent(entry.id, task.id, rawPayload, "deleted", colId, event.created_at);
        removed += 1;
      }
      return removed;
    },
  };
}
