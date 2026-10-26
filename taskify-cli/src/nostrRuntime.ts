import { collectRuntimeRelayUrls, type RelayRuntimeStatus } from "taskify-runtime-nostr";
import type { ReminderPreset } from "./shared/taskTypes.js";
import type { AgentTaskCreateInput, AgentTaskPatchInput, AgentTaskStatus } from "./shared/agentRuntime.js";
import type { AgentSecurityConfig } from "./shared/agentSecurity.js";
import type { TaskifyConfig, BoardEntry } from "./config.js";
import { saveConfig } from "./config.js";
import { readCache, writeCache } from "./taskCache.js";
import { createCliNostrSession, type CliNostrSession } from "./shared/nodeRuntimeSession.js";
import { cliProofOfWorkSettings, cliRelayInfoCache } from "./shared/relaySettings.js";
import type { RuntimeContext } from "./runtime/context.js";
import type { ExtendedCreateInput, FullTaskRecord } from "./runtime/taskCodec.js";
import { createTaskRepository, type ListTasksOptions } from "./runtime/taskRepository.js";
import type { EventInvitation, FullEventRecord } from "./runtime/calendarCodec.js";
import type { CalendarRsvpResponse as EventRsvp } from "taskify-core";
import { createCalendarRepository, type CreateEventInput, type EventPatch } from "./runtime/calendarRepository.js";
import { createBoardRepository, type BoardPatch, type CreateBoardInput, type SyncedBoard } from "./runtime/boardRepository.js";

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
  syncBoard(boardId: string): Promise<SyncedBoard>;
  createTask(input: AgentTaskCreateInput): Promise<FullTaskRecord>;
  createTaskFull(input: ExtendedCreateInput): Promise<FullTaskRecord>;
  createBoard(input: CreateBoardInput): Promise<{ boardId: string }>;
  updateBoard(boardId: string, patch: BoardPatch): Promise<BoardEntry | null>;
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

  const context: RuntimeContext = { config, session, ensureConnected, boardRelays, taskCache, persistConfig, clock, randomUUID, isoNow };
  const tasks = createTaskRepository(context);
  const calendar = createCalendarRepository(context);
  const boards = createBoardRepository(context);

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

    syncBoard: boards.syncBoard,
    createBoard: boards.createBoard,
    updateBoard: boards.updateBoard,

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

  };
}
