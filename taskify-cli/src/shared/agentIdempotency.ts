import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// CLI-adapted version of agentIdempotency.ts (in-memory + file-based persistence)

export const AGENT_IDEMPOTENCY_STORAGE_KEY = "taskify.agent.idempotency.v1";
const MAX_AGENT_IDEMPOTENCY_ENTRIES = 100;
const AGENT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type AgentIdempotencyEntry = {
  key: string;
  taskId: string;
  createdAt: number;
};

export type AgentIdempotencyStore = {
  get(key: string): Promise<string | null>;
  set(key: string, taskId: string): Promise<void>;
  reserve(key: string, proposedTaskId: string): Promise<{ taskId: string; created: boolean }>;
};

function normalizeIdempotencyKey(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

type IdempotencyFile = {
  version: 1;
  entries: AgentIdempotencyEntry[];
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readEntries(filePath: string): Promise<AgentIdempotencyEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Partial<IdempotencyFile>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry): entry is AgentIdempotencyEntry =>
      !!entry
      && typeof entry.key === "string"
      && typeof entry.taskId === "string"
      && typeof entry.createdAt === "number");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error(`Idempotency store is malformed: ${filePath}`, { cause: error });
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error("Timed out waiting for the idempotency store lock.");
}

async function writeEntries(filePath: string, entries: AgentIdempotencyEntry[]): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, entries }, null, 2), "utf-8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function createFileAgentIdempotencyStore(
  filePath: string,
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): AgentIdempotencyStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? AGENT_IDEMPOTENCY_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_AGENT_IDEMPOTENCY_ENTRIES;
  const liveEntries = (entries: AgentIdempotencyEntry[]) =>
    entries.filter((entry) => now() - entry.createdAt < ttlMs);

  return {
    async get(key: string) {
      const normalizedKey = normalizeIdempotencyKey(key);
      if (!normalizedKey) return null;
      const entry = liveEntries(await readEntries(filePath)).find((candidate) => candidate.key === normalizedKey);
      return entry?.taskId ?? null;
    },

    async set(key: string, taskId: string) {
      const normalizedKey = normalizeIdempotencyKey(key);
      const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
      if (!normalizedKey || !normalizedTaskId) return;

      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await acquireLock(`${filePath}.lock`);
      try {
        const entries = liveEntries(await readEntries(filePath))
          .filter((entry) => entry.key !== normalizedKey);
        entries.push({ key: normalizedKey, taskId: normalizedTaskId, createdAt: now() });
        entries.sort((left, right) => right.createdAt - left.createdAt);
        await writeEntries(filePath, entries.slice(0, maxEntries));
      } finally {
        await release();
      }
    },

    async reserve(key: string, proposedTaskId: string) {
      const normalizedKey = normalizeIdempotencyKey(key);
      const normalizedTaskId = typeof proposedTaskId === "string" ? proposedTaskId.trim() : "";
      if (!normalizedKey || !normalizedTaskId) {
        throw new Error("An idempotency key and proposed task ID are required.");
      }

      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await acquireLock(`${filePath}.lock`);
      try {
        const entries = liveEntries(await readEntries(filePath));
        const existing = entries.find((entry) => entry.key === normalizedKey);
        if (existing) return { taskId: existing.taskId, created: false };

        entries.push({ key: normalizedKey, taskId: normalizedTaskId, createdAt: now() });
        entries.sort((left, right) => right.createdAt - left.createdAt);
        await writeEntries(filePath, entries.slice(0, maxEntries));
        return { taskId: normalizedTaskId, created: true };
      } finally {
        await release();
      }
    },
  };
}

// In-memory store for CLI use
const inMemoryEntries: Map<string, AgentIdempotencyEntry> = new Map();

const inMemoryIdempotencyStore: AgentIdempotencyStore = {
  async get(key: string) {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (!normalizedKey) return null;
    const entry = inMemoryEntries.get(normalizedKey);
    if (!entry) return null;
    if (Date.now() - entry.createdAt >= AGENT_IDEMPOTENCY_TTL_MS) {
      inMemoryEntries.delete(normalizedKey);
      return null;
    }
    return entry.taskId;
  },

  async set(key: string, taskId: string) {
    const normalizedKey = normalizeIdempotencyKey(key);
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!normalizedKey || !normalizedTaskId) return;

    inMemoryEntries.set(normalizedKey, {
      key: normalizedKey,
      taskId: normalizedTaskId,
      createdAt: Date.now(),
    });

    // Trim to max entries (keep newest)
    if (inMemoryEntries.size > MAX_AGENT_IDEMPOTENCY_ENTRIES) {
      const sorted = Array.from(inMemoryEntries.values()).sort((a, b) => a.createdAt - b.createdAt);
      const toRemove = sorted.slice(0, inMemoryEntries.size - MAX_AGENT_IDEMPOTENCY_ENTRIES);
      for (const entry of toRemove) {
        inMemoryEntries.delete(entry.key);
      }
    }
  },

  async reserve(key: string, proposedTaskId: string) {
    const normalizedKey = normalizeIdempotencyKey(key);
    const normalizedTaskId = typeof proposedTaskId === "string" ? proposedTaskId.trim() : "";
    if (!normalizedKey || !normalizedTaskId) {
      throw new Error("An idempotency key and proposed task ID are required.");
    }
    const existing = inMemoryEntries.get(normalizedKey);
    if (existing && Date.now() - existing.createdAt < AGENT_IDEMPOTENCY_TTL_MS) {
      return { taskId: existing.taskId, created: false };
    }
    if (existing) inMemoryEntries.delete(normalizedKey);
    inMemoryEntries.set(normalizedKey, {
      key: normalizedKey,
      taskId: normalizedTaskId,
      createdAt: Date.now(),
    });
    if (inMemoryEntries.size > MAX_AGENT_IDEMPOTENCY_ENTRIES) {
      const oldest = Array.from(inMemoryEntries.values())
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, inMemoryEntries.size - MAX_AGENT_IDEMPOTENCY_ENTRIES);
      for (const entry of oldest) inMemoryEntries.delete(entry.key);
    }
    return { taskId: normalizedTaskId, created: true };
  },
};

let currentAgentIdempotencyStore: AgentIdempotencyStore = inMemoryIdempotencyStore;

export function getAgentIdempotencyStore(): AgentIdempotencyStore {
  return currentAgentIdempotencyStore;
}

export function setAgentIdempotencyStore(store: AgentIdempotencyStore | null | undefined): void {
  currentAgentIdempotencyStore = store ?? inMemoryIdempotencyStore;
}
