import { sanitizeRemote } from "./shared/displaySafe.js";
import { boardTagHash, collectRuntimeRelayUrls, deriveBoardKeyPair, type RelayRuntimeStatus } from "taskify-runtime-nostr";
import type { ReminderPreset } from "./shared/taskTypes.js";
import type { AgentTaskCreateInput, AgentTaskPatchInput, AgentTaskStatus } from "./shared/agentRuntime.js";
import type { AgentSecurityConfig } from "./shared/agentSecurity.js";
import type { TaskifyConfig, BoardEntry } from "./config.js";
import { saveConfig } from "./config.js";
import { readCache, writeCache } from "./taskCache.js";
import { pickBestBoardMeta } from "./shared/boardMeta.js";
import { createCliNostrSession, type CliNostrSession } from "./shared/nodeRuntimeSession.js";
import { cliProofOfWorkSettings, cliRelayInfoCache } from "./shared/relaySettings.js";
import { decryptContent, encryptContent, resolveBoardEntry, type RuntimeContext } from "./runtime/context.js";
import type { ExtendedCreateInput, FullTaskRecord } from "./runtime/taskCodec.js";
import { createTaskRepository, type ListTasksOptions } from "./runtime/taskRepository.js";
import type { EventInvitation, FullEventRecord } from "./runtime/calendarCodec.js";
import type { CalendarRsvpResponse as EventRsvp } from "taskify-core";
import { createCalendarRepository, type CreateEventInput, type EventPatch } from "./runtime/calendarRepository.js";

export type { ExtendedCreateInput, FullTaskRecord } from "./runtime/taskCodec.js";
export type { EventInvitation, FullEventRecord } from "./runtime/calendarCodec.js";
export type { CalendarRsvpResponse as EventRsvp } from "taskify-core";

// ---- Public types ----

export type NostrRuntime = {
  getDefaultBoardId(): string | null;
  disconnect(): Promise<void>;
  listTasks(options: ListTasksOptions): Promise<FullTaskRecord[]>;
  listEvents(options: { boardId?: string }): Promise<FullEventRecord[]>;
  getEvent(eventId: string, boardId?: string): Promise<FullEventRecord | null>;
  createEvent(input: CreateEventInput): Promise<FullEventRecord>;
  updateEvent(eventId: string, boardId: string | undefined, patch: EventPatch): Promise<FullEventRecord | null>;
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
  /** Each attendee's newest published RSVP to the event; null when the event isn't found. */
  listEventRsvps(eventId: string, boardId?: string): Promise<EventRsvp[] | null>;
  remindTask(taskId: string, presets: ReminderPreset[]): Promise<void>;
  getLocalReminders(taskId: string): ReminderPreset[];
  getAgentSecurityConfig(): Promise<AgentSecurityConfig>;
  setAgentSecurityConfig(cfg: AgentSecurityConfig): Promise<AgentSecurityConfig>;
  getRelayStatus(): Promise<RelayRuntimeStatus[]>;
};

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

  function boardRelays(boardId: string): string[] {
    const configured = config.boards.find((board) => board.id === boardId)?.relays;
    return configured?.length ? configured : config.relays;
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
    // Tags are public: they carry only what the PWA and iOS put there. Lists and child boards are
    // in the encrypted payload. A child's id is that board's key, and list names are the user's.
    event.tags = [
      ["d", bTag],
      ["b", bTag],
      ["k", board.kind ?? "lists"],
      ["name", board.name],
      ...(board.sortMode ? [["sort", board.sortMode, board.sortDirection ?? "asc"]] : []),
    ];
    await session.publishSigned(event, signer, board.relays?.length ? board.relays : config.relays);
  }

  const context: RuntimeContext = { config, session, ensureConnected, boardRelays, taskCache, persistConfig, clock, randomUUID, isoNow };
  const tasks = createTaskRepository(context);
  const calendar = createCalendarRepository(context);

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

    listEvents: calendar.listEvents,
    getEvent: calendar.getEvent,
    createEvent: calendar.createEvent,
    updateEvent: calendar.updateEvent,
    inviteToEvent: calendar.inviteToEvent,
    deleteEvent: calendar.deleteEvent,
    listEventRsvps: calendar.listEventRsvps,

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
