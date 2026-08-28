import { toNpub } from "./nostr.js";
import { getAgentIdempotencyStore } from "./agentIdempotency.js";
import {
  addTrustedNpub,
  annotateTrust,
  clearTrustedNpubs,
  getEffectiveAgentSecurityMode,
  isLooselyValidTrustedNpub,
  removeTrustedNpub,
  summarizeTrustCounts,
  type AgentSecurityConfig,
} from "./agentSecurity.js";
import {
  getAgentRuntime,
  type AgentTaskRecord,
  type AgentTaskCreateInput,
  type AgentTaskPatchInput,
  type AgentTaskStatus,
} from "./agentRuntime.js";

type AgentErrorCode =
  | "PARSE_JSON"
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL";

type AgentProtocolVersion = number;

type MetaHelpCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "meta.help";
  params: Record<string, never>;
};

type TaskCreateCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "task.create";
  params: {
    title: string;
    note?: string;
    boardId?: string;
    dueISO?: string;
    priority?: 1 | 2 | 3;
    idempotencyKey?: string;
  };
};

type TaskUpdateCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "task.update";
  params: {
    taskId: string;
    patch: {
      title?: string;
      note?: string;
      dueISO?: string | null;
      priority?: 1 | 2 | 3 | null;
    };
  };
};

type TaskSetStatusCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "task.setStatus";
  params: {
    taskId: string;
    status: AgentTaskStatus;
  };
};

type TaskListCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "task.list";
  params: {
    boardId?: string;
    status?: "open" | "done" | "any";
    query?: string;
    limit?: number;
    cursor?: string;
  };
};

type TaskGetCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "task.get";
  params: {
    taskId: string;
  };
};

type AgentSecurityGetCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.security.get";
  params: Record<string, never>;
};

type AgentSecuritySetCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.security.set";
  params: {
    enabled?: boolean;
    mode?: "off" | "moderate" | "strict";
  };
};

type AgentTrustAddCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.trust.add";
  params: {
    npub: string;
  };
};

type AgentTrustRemoveCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.trust.remove";
  params: {
    npub: string;
  };
};

type AgentTrustListCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.trust.list";
  params: Record<string, never>;
};

type AgentTrustClearCommand = {
  v: AgentProtocolVersion;
  id: string;
  op: "agent.trust.clear";
  params: Record<string, never>;
};

export type AgentCommandV1 =
  | MetaHelpCommand
  | TaskCreateCommand
  | TaskUpdateCommand
  | TaskSetStatusCommand
  | TaskListCommand
  | TaskGetCommand
  | AgentSecurityGetCommand
  | AgentSecuritySetCommand
  | AgentTrustAddCommand
  | AgentTrustRemoveCommand
  | AgentTrustListCommand
  | AgentTrustClearCommand;

export type AgentResponseV1 = {
  v: AgentProtocolVersion;
  id: string | null;
  ok: boolean;
  result: Record<string, unknown> | null;
  error: {
    code: AgentErrorCode;
    message: string;
    details?: Record<string, string>;
  } | null;
};

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; details: Record<string, string>; id: string | null; version: AgentProtocolVersion };

type AgentTaskSummary = {
  id: string;
  title: string;
  note: string;
  boardId: string;
  status: "open" | "done";
  dueISO: string | null;
  priority: number | null;
  updatedISO: string;
  createdByNpub: string | null;
  lastEditedByNpub: string | null;
  provenance: "trusted" | "untrusted" | "unknown";
  trusted: boolean;
  agentSafe: boolean;
};

function success(
  id: string | null,
  result: Record<string, unknown>,
  version: AgentProtocolVersion = 1,
): AgentResponseV1 {
  return { v: version, id, ok: true, result, error: null };
}

function failure(
  id: string | null,
  code: AgentErrorCode,
  message: string,
  details?: Record<string, string>,
  version: AgentProtocolVersion = 1,
): AgentResponseV1 {
  return {
    v: version,
    id,
    ok: false,
    result: null,
    error: {
      code,
      message,
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function toUpdatedISO(task: AgentTaskRecord): string {
  const rawUpdatedAt = (task as any).updatedAt;
  if (typeof rawUpdatedAt === "string" && !Number.isNaN(Date.parse(rawUpdatedAt))) {
    return new Date(rawUpdatedAt).toISOString();
  }
  if (typeof task.completedAt === "string" && !Number.isNaN(Date.parse(task.completedAt))) {
    return new Date(task.completedAt).toISOString();
  }
  if (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)) {
    return new Date(task.createdAt).toISOString();
  }
  if (typeof task.dueISO === "string" && !Number.isNaN(Date.parse(task.dueISO))) {
    return new Date(task.dueISO).toISOString();
  }
  return new Date(0).toISOString();
}

function toNullableDueISO(task: AgentTaskRecord): string | null {
  if (task.dueDateEnabled === false) return null;
  if (typeof task.dueISO === "string" && !Number.isNaN(Date.parse(task.dueISO))) {
    return new Date(task.dueISO).toISOString();
  }
  return null;
}

function buildTaskBaseSummary(task: AgentTaskRecord) {
  return {
    id: task.id,
    title: task.title,
    note: task.note ?? "",
    boardId: task.boardId,
    status: (task.completed ? "done" : "open") as "open" | "done",
    dueISO: toNullableDueISO(task),
    priority: task.priority ?? null,
    updatedISO: toUpdatedISO(task),
    createdByNpub: toNpub(task.createdBy ?? null),
    lastEditedByNpub: toNpub(task.lastEditedBy ?? null),
  };
}

function encodeCursor(offset: number): string {
  const payload = JSON.stringify({ offset });
  if (typeof Buffer !== "undefined") {
    return Buffer.from(payload, "utf8").toString("base64");
  }
  return btoa(payload);
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded =
      typeof Buffer !== "undefined"
        ? Buffer.from(cursor, "base64").toString("utf8")
        : atob(cursor);
    const parsed = JSON.parse(decoded);
    if (!isPlainObject(parsed)) return null;
    const offset = parsed.offset;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  details: Record<string, string>,
  options?: { allowEmpty?: boolean },
): string | undefined {
  const value = source[field];
  if (typeof value !== "string") {
    details[`params.${field}`] = "Expected string";
    return undefined;
  }
  const trimmed = value.trim();
  if (!options?.allowEmpty && !trimmed) {
    details[`params.${field}`] = "Required";
    return undefined;
  }
  return trimmed;
}

function parseProtocolVersion(value: unknown): AgentProtocolVersion | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return null;
}

function validateCommand(raw: unknown): ValidationResult<AgentCommandV1> {
  if (!isPlainObject(raw)) {
    return { ok: false, details: { root: "Expected a JSON object" }, id: null, version: 1 };
  }

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const version = parseProtocolVersion(raw.v ?? (raw as any).version);
  const details: Record<string, string> = {};

  if (version === null) details.v = "Expected positive integer version";
  if (!id) details.id = "Required string";
  if (typeof raw.op !== "string" || !raw.op.trim()) details.op = "Required string";
  if (!isPlainObject(raw.params)) details.params = "Expected object";

  if (Object.keys(details).length > 0) {
    return { ok: false, details, id, version: version ?? 1 };
  }

  const op = String(raw.op).trim();
  const params = raw.params as Record<string, unknown>;

  switch (op) {
    case "meta.help":
    case "agent.security.get":
    case "agent.trust.list":
    case "agent.trust.clear":
      return {
        ok: true,
        value: { v: version!, id: id!, op, params: {} } as AgentCommandV1,
      };

    case "task.create": {
      const nextDetails: Record<string, string> = {};
      const title = requireString(params, "title", nextDetails);
      const note =
        params.note === undefined
          ? ""
          : typeof params.note === "string"
            ? params.note
            : (nextDetails["params.note"] = "Expected string", "");
      const boardId =
        params.boardId === undefined
          ? undefined
          : typeof params.boardId === "string" && params.boardId.trim()
            ? params.boardId.trim()
            : (nextDetails["params.boardId"] = "Expected string", undefined);
      const dueISO =
        params.dueISO === undefined
          ? undefined
          : parseIsoString(params.dueISO) ?? (nextDetails["params.dueISO"] = "Expected ISO 8601 string", undefined);
      const priority =
        params.priority === undefined
          ? undefined
          : params.priority === 1 || params.priority === 2 || params.priority === 3
            ? params.priority
            : (nextDetails["params.priority"] = "Expected number 1-3", undefined);
      const idempotencyKey =
        params.idempotencyKey === undefined
          ? undefined
          : typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
            ? params.idempotencyKey.trim()
            : (nextDetails["params.idempotencyKey"] = "Expected string", undefined);
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: {
          v: version!,
          id: id!,
          op,
          params: { title: title!, note, ...(boardId ? { boardId } : {}), ...(dueISO ? { dueISO } : {}), ...(priority ? { priority } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) },
        } as AgentCommandV1,
      };
    }

    case "task.update": {
      const nextDetails: Record<string, string> = {};
      const taskId = requireString(params, "taskId", nextDetails);
      if (!isPlainObject(params.patch)) {
        nextDetails["params.patch"] = "Expected object";
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      const rawPatch = params.patch as Record<string, unknown>;
      const patch: AgentTaskPatchInput = {};
      if (rawPatch.title !== undefined) {
        if (typeof rawPatch.title === "string" && rawPatch.title.trim()) patch.title = rawPatch.title.trim();
        else nextDetails["params.patch.title"] = "Expected non-empty string";
      }
      if (rawPatch.note !== undefined) {
        if (typeof rawPatch.note === "string") patch.note = rawPatch.note;
        else nextDetails["params.patch.note"] = "Expected string";
      }
      if (rawPatch.dueISO !== undefined) {
        if (rawPatch.dueISO === null) patch.dueISO = null;
        else {
          const dueISO = parseIsoString(rawPatch.dueISO);
          if (dueISO) patch.dueISO = dueISO;
          else nextDetails["params.patch.dueISO"] = "Expected ISO 8601 string or null";
        }
      }
      if (rawPatch.priority !== undefined) {
        if (rawPatch.priority === null) patch.priority = null;
        else if (rawPatch.priority === 1 || rawPatch.priority === 2 || rawPatch.priority === 3) patch.priority = rawPatch.priority;
        else nextDetails["params.patch.priority"] = "Expected number 1-3 or null";
      }
      if (Object.keys(patch).length === 0) {
        nextDetails["params.patch"] = "At least one patch field is required";
      }
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: {
          v: version!,
          id: id!,
          op,
          params: { taskId: taskId!, patch },
        } as AgentCommandV1,
      };
    }

    case "task.setStatus": {
      const nextDetails: Record<string, string> = {};
      const taskId = requireString(params, "taskId", nextDetails);
      const status =
        params.status === "open" || params.status === "done"
          ? params.status
          : (nextDetails["params.status"] = 'Expected "open" or "done"', undefined);
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: {
          v: version!,
          id: id!,
          op,
          params: { taskId: taskId!, status: status as AgentTaskStatus },
        } as AgentCommandV1,
      };
    }

    case "task.list": {
      const nextDetails: Record<string, string> = {};
      const boardId =
        params.boardId === undefined
          ? undefined
          : typeof params.boardId === "string" && params.boardId.trim()
            ? params.boardId.trim()
            : (nextDetails["params.boardId"] = "Expected string", undefined);
      const status =
        params.status === undefined
          ? "open"
          : params.status === "open" || params.status === "done" || params.status === "any"
            ? params.status
            : (nextDetails["params.status"] = 'Expected "open", "done", or "any"', "open");
      const query =
        params.query === undefined
          ? undefined
          : typeof params.query === "string" && params.query.trim()
            ? params.query.trim()
            : (nextDetails["params.query"] = "Expected non-empty string", undefined);
      const limit =
        params.limit === undefined
          ? 50
          : typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 1
            ? Math.min(200, params.limit)
            : (nextDetails["params.limit"] = "Expected integer 1-200", 50);
      const cursor =
        params.cursor === undefined
          ? undefined
          : typeof params.cursor === "string" && params.cursor.trim()
            ? params.cursor.trim()
            : (nextDetails["params.cursor"] = "Expected string", undefined);
      if (cursor && decodeCursor(cursor) === null) {
        nextDetails["params.cursor"] = "Invalid cursor";
      }
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: {
          v: version!,
          id: id!,
          op,
          params: {
            ...(boardId ? { boardId } : {}),
            status,
            ...(query ? { query } : {}),
            limit,
            ...(cursor ? { cursor } : {}),
          },
        } as AgentCommandV1,
      };
    }

    case "task.get": {
      const nextDetails: Record<string, string> = {};
      const taskId = requireString(params, "taskId", nextDetails);
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: { v: version!, id: id!, op, params: { taskId: taskId! } } as AgentCommandV1,
      };
    }

    case "agent.security.set": {
      const nextDetails: Record<string, string> = {};
      const nextParams: Record<string, unknown> = {};
      if (params.enabled !== undefined) {
        if (typeof params.enabled === "boolean") nextParams.enabled = params.enabled;
        else nextDetails["params.enabled"] = "Expected boolean";
      }
      if (params.mode !== undefined) {
        if (params.mode === "off" || params.mode === "moderate" || params.mode === "strict") nextParams.mode = params.mode;
        else nextDetails["params.mode"] = 'Expected "off", "moderate", or "strict"';
      }
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: { v: version!, id: id!, op, params: nextParams } as AgentCommandV1,
      };
    }

    case "agent.trust.add":
    case "agent.trust.remove": {
      const nextDetails: Record<string, string> = {};
      const npub = requireString(params, "npub", nextDetails);
      if (npub && !isLooselyValidTrustedNpub(npub)) {
        nextDetails["params.npub"] = 'Expected string starting with "npub1"';
      }
      if (Object.keys(nextDetails).length > 0) {
        return { ok: false, details: nextDetails, id, version: version ?? 1 };
      }
      return {
        ok: true,
        value: { v: version!, id: id!, op, params: { npub: npub!.toLowerCase() } } as AgentCommandV1,
      };
    }

    default:
      return {
        ok: false,
        details: { op: "Unsupported operation" },
        id,
        version: version ?? 1,
      };
  }
}

function buildHelpResult(): Record<string, unknown> {
  return {
    ops: [
      { op: "meta.help", paramsSchema: {} },
      { op: "task.create", paramsSchema: { title: "string (required)", note: "string (optional)", boardId: "string (optional)", dueISO: "ISO 8601 string (optional)", priority: "number 1-3 (optional)", idempotencyKey: "string (optional)" } },
      { op: "task.update", paramsSchema: { taskId: "string (required)", patch: { title: "string (optional)", note: "string (optional)", dueISO: "ISO 8601 string|null (optional)", priority: "1|2|3|null (optional)" } } },
      { op: "task.setStatus", paramsSchema: { taskId: "string (required)", status: '"open"|"done" (required)' } },
      { op: "task.list", paramsSchema: { boardId: "string (optional)", status: '"open"|"done"|"any" (optional, default "open")', query: "string (optional)", limit: "number 1-200 (optional, default 50)", cursor: "string (optional)" } },
      { op: "task.get", paramsSchema: { taskId: "string (required)" } },
      { op: "agent.security.get", paramsSchema: {} },
      { op: "agent.security.set", paramsSchema: { enabled: "boolean (optional)", mode: '"off"|"moderate"|"strict" (optional)' } },
      { op: "agent.trust.add", paramsSchema: { npub: 'string starting with "npub1" (required)' } },
      { op: "agent.trust.remove", paramsSchema: { npub: 'string starting with "npub1" (required)' } },
      { op: "agent.trust.list", paramsSchema: {} },
      { op: "agent.trust.clear", paramsSchema: {} },
    ],
  };
}

async function getSecurityConfig(runtime: NonNullable<ReturnType<typeof getAgentRuntime>>): Promise<AgentSecurityConfig> {
  return await runtime.getAgentSecurityConfig();
}

function summarizeTaskWithTrust(task: AgentTaskRecord, securityConfig: AgentSecurityConfig): AgentTaskSummary {
  return annotateTrust(buildTaskBaseSummary(task), securityConfig);
}

function maybeForbidStrictSingleItem<T extends AgentTaskSummary>(
  item: T,
  securityConfig: AgentSecurityConfig,
  id: string,
  version: AgentProtocolVersion,
): AgentResponseV1 | null {
  if (getEffectiveAgentSecurityMode(securityConfig) === "strict" && !item.trusted) {
    return failure(id, "FORBIDDEN", "Item is not trusted in strict mode", undefined, version);
  }
  return null;
}

export async function dispatchAgentCommand(raw: string): Promise<AgentResponseV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure(null, "PARSE_JSON", "Invalid JSON");
  }

  if (Array.isArray(parsed)) {
    return failure(null, "VALIDATION", "Expected a single JSON object", { root: "Arrays are not supported" });
  }

  const validated = validateCommand(parsed);
  if (!validated.ok) {
    return failure(validated.id, "VALIDATION", "Command validation failed", validated.details, validated.version);
  }

  const command = validated.value;
  const runtime = getAgentRuntime();
  if (!runtime) {
    return failure(command.id, "INTERNAL", "Agent runtime is not available", undefined, command.v);
  }

  try {
    switch (command.op) {
      case "meta.help":
        return success(command.id, buildHelpResult(), command.v);

      case "task.create": {
        const { title, note = "", dueISO, priority, idempotencyKey } = command.params;
        const boardId = command.params.boardId ?? runtime.getDefaultBoardId() ?? "inbox";
        const idempotencyStore = getAgentIdempotencyStore();
        let reservedTaskId: string | undefined;

        if (idempotencyKey) {
          const reservation = await idempotencyStore.reserve(
            `${boardId}:${idempotencyKey}`,
            crypto.randomUUID(),
          );
          reservedTaskId = reservation.taskId;
          if (!reservation.created) {
            const existingTask = await runtime.getTask(reservation.taskId);
            if (existingTask) {
              const securityConfig = await getSecurityConfig(runtime);
              return success(command.id, {
                taskId: existingTask.id,
                task: summarizeTaskWithTrust(existingTask, securityConfig),
              }, command.v);
            }
          }
        }

        const createdTask = await runtime.createTask({
          taskId: reservedTaskId,
          title,
          note,
          boardId,
          ...(dueISO ? { dueISO } : {}),
          ...(priority ? { priority } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } satisfies AgentTaskCreateInput);
        const securityConfig = await getSecurityConfig(runtime);
        return success(command.id, {
          taskId: createdTask.id,
          task: summarizeTaskWithTrust(createdTask, securityConfig),
        }, command.v);
      }

      case "task.update": {
        const updatedTask = await runtime.updateTask(command.params.taskId, command.params.patch);
        if (!updatedTask) {
          return failure(command.id, "NOT_FOUND", "Task not found", undefined, command.v);
        }
        const securityConfig = await getSecurityConfig(runtime);
        return success(command.id, { task: summarizeTaskWithTrust(updatedTask, securityConfig) }, command.v);
      }

      case "task.setStatus": {
        const updatedTask = await runtime.setTaskStatus(command.params.taskId, command.params.status);
        if (!updatedTask) {
          return failure(command.id, "NOT_FOUND", "Task not found", undefined, command.v);
        }
        const securityConfig = await getSecurityConfig(runtime);
        return success(command.id, { task: summarizeTaskWithTrust(updatedTask, securityConfig) }, command.v);
      }

      case "task.list": {
        const securityConfig = await getSecurityConfig(runtime);
        const tasks = await runtime.listTasks({
          ...(command.params.boardId ? { boardId: command.params.boardId } : {}),
          status: command.params.status ?? "open",
        });

        const sorted = [...tasks].sort((left, right) => {
          const leftUpdated = toUpdatedISO(left);
          const rightUpdated = toUpdatedISO(right);
          if (leftUpdated !== rightUpdated) return rightUpdated.localeCompare(leftUpdated);
          return left.id.localeCompare(right.id);
        });

        const annotatedAll = sorted.map((task) => summarizeTaskWithTrust(task, securityConfig));
        const query = command.params.query?.toLowerCase();
        const queryFiltered = query
          ? annotatedAll.filter((item) => {
            const haystack = `${item.title}\n${item.note}`.toLowerCase();
            return haystack.includes(query);
          })
          : annotatedAll;
        const filtered = getEffectiveAgentSecurityMode(securityConfig) === "strict"
          ? queryFiltered.filter((item) => item.trusted)
          : queryFiltered;
        const offset = command.params.cursor ? decodeCursor(command.params.cursor) ?? 0 : 0;
        const limit = command.params.limit ?? 50;
        const items = filtered.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        const nextCursor = nextOffset < filtered.length ? encodeCursor(nextOffset) : null;
        return success(command.id, {
          items,
          nextCursor,
          counts: summarizeTrustCounts(filtered, items.length),
        }, command.v);
      }

      case "task.get": {
        const task = await runtime.getTask(command.params.taskId);
        if (!task) {
          return failure(command.id, "NOT_FOUND", "Task not found", undefined, command.v);
        }
        const securityConfig = await getSecurityConfig(runtime);
        const summary = summarizeTaskWithTrust(task, securityConfig);
        const strictError = maybeForbidStrictSingleItem(summary, securityConfig, command.id, command.v);
        if (strictError) return strictError;
        return success(command.id, { task: summary }, command.v);
      }

      case "agent.security.get": {
        const config = await getSecurityConfig(runtime);
        return success(command.id, {
          enabled: config.enabled,
          mode: config.mode,
          trustedNpubs: config.trustedNpubs,
          updatedISO: config.updatedISO,
        }, command.v);
      }

      case "agent.security.set": {
        const current = await getSecurityConfig(runtime);
        const next = {
          enabled: command.params.enabled ?? current.enabled,
          mode: command.params.mode ?? current.mode,
          trustedNpubs: current.trustedNpubs,
          updatedISO: new Date().toISOString(),
        } satisfies AgentSecurityConfig;
        const saved = await runtime.setAgentSecurityConfig(next);
        return success(command.id, {
          enabled: saved.enabled,
          mode: saved.mode,
          trustedNpubs: saved.trustedNpubs,
          updatedISO: saved.updatedISO,
        }, command.v);
      }

      case "agent.trust.add": {
        const current = await getSecurityConfig(runtime);
        const saved = await runtime.setAgentSecurityConfig(addTrustedNpub(current, command.params.npub));
        return success(command.id, {
          enabled: saved.enabled,
          mode: saved.mode,
          trustedNpubs: saved.trustedNpubs,
          updatedISO: saved.updatedISO,
        }, command.v);
      }

      case "agent.trust.remove": {
        const current = await getSecurityConfig(runtime);
        const saved = await runtime.setAgentSecurityConfig(removeTrustedNpub(current, command.params.npub));
        return success(command.id, {
          enabled: saved.enabled,
          mode: saved.mode,
          trustedNpubs: saved.trustedNpubs,
          updatedISO: saved.updatedISO,
        }, command.v);
      }

      case "agent.trust.list": {
        const config = await getSecurityConfig(runtime);
        return success(command.id, { trustedNpubs: config.trustedNpubs }, command.v);
      }

      case "agent.trust.clear": {
        const current = await getSecurityConfig(runtime);
        const saved = await runtime.setAgentSecurityConfig(clearTrustedNpubs(current));
        return success(command.id, {
          enabled: saved.enabled,
          mode: saved.mode,
          trustedNpubs: saved.trustedNpubs,
          updatedISO: saved.updatedISO,
        }, command.v);
      }

      default: {
        const _cmd = command as unknown as { id: string; v: number };
        return failure(_cmd.id, "VALIDATION", "Unsupported operation", { op: "Unsupported operation" }, _cmd.v);
      }
    }
  } catch (error: any) {
    const code = error?.code;
    const message = typeof error?.message === "string" && error.message ? error.message : "Internal error";
    if (
      code === "PARSE_JSON"
      || code === "VALIDATION"
      || code === "NOT_FOUND"
      || code === "CONFLICT"
      || code === "FORBIDDEN"
      || code === "INTERNAL"
    ) {
      return failure(command.id, code, message, undefined, command.v);
    }
    return failure(command.id, "INTERNAL", message, undefined, command.v);
  }
}
