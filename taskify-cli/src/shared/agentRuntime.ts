import type { AgentSecurityConfig } from "./agentSecurity.js";

export type AgentTaskRecord = {
  id: string;
  boardId: string;
  title: string;
  note?: string;
  dueISO: string;
  dueDateEnabled?: boolean;
  dueTimeEnabled?: boolean;
  completed?: boolean;
  completedAt?: string;
  createdAt?: number;
  updatedAt?: string;
  priority?: 1 | 2 | 3;
  createdBy?: string;
  lastEditedBy?: string;
};

export type AgentTaskStatus = "open" | "done";

export type AgentTaskCreateInput = {
  /** Reserved internally before publish so retries converge on one replaceable task event. */
  taskId?: string;
  title: string;
  note: string;
  boardId: string;
  dueISO?: string;
  priority?: 1 | 2 | 3;
  columnId?: string;
  idempotencyKey?: string;
  assignees?: Array<{ pubkey: string; relay?: string; status?: "pending" | "accepted" | "declined" | "tentative"; respondedAt?: number }>;
  recurrence?: Record<string, unknown>;
  reminders?: Array<string | number>;
  documents?: Array<Record<string, unknown>>;
};

export type AgentTaskPatchInput = {
  title?: string;
  note?: string;
  dueISO?: string | null;
  priority?: 1 | 2 | 3 | null;
  columnId?: string | null;
  inboxItem?: boolean;
  assignees?: Array<{ pubkey: string; relay?: string; status?: "pending" | "accepted" | "declined" | "tentative"; respondedAt?: number }>;
  recurrence?: Record<string, unknown> | null;
  reminders?: Array<string | number> | null;
  documents?: Array<Record<string, unknown>> | null;
  dueTimeEnabled?: boolean | null;
  dueTimeZone?: string | null;
  hiddenUntilISO?: string | null;
};

export type AgentRuntime = {
  getDefaultBoardId(): string | null;
  getTask(taskId: string): Promise<AgentTaskRecord | null> | AgentTaskRecord | null;
  listTasks(
    options: { boardId?: string; status: "open" | "done" | "any" },
  ): Promise<AgentTaskRecord[]> | AgentTaskRecord[];
  createTask(input: AgentTaskCreateInput): Promise<AgentTaskRecord>;
  updateTask(taskId: string, patch: AgentTaskPatchInput): Promise<AgentTaskRecord | null>;
  setTaskStatus(taskId: string, status: AgentTaskStatus): Promise<AgentTaskRecord | null>;
  getAgentSecurityConfig(): Promise<AgentSecurityConfig> | AgentSecurityConfig;
  setAgentSecurityConfig(config: AgentSecurityConfig): Promise<AgentSecurityConfig> | AgentSecurityConfig;
};

let currentAgentRuntime: AgentRuntime | null = null;

export function setAgentRuntime(runtime: AgentRuntime | null): void {
  currentAgentRuntime = runtime;
}

export function getAgentRuntime(): AgentRuntime | null {
  return currentAgentRuntime;
}
