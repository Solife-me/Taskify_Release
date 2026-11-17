import { type NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { boardTagHash, deriveBoardKeyPair, normalizeRelayUrls, recoverRelayHistory } from "taskify-runtime-nostr";
import { nextEventCreatedAt, readTagValue, resolveIdentifierReference } from "taskify-core";
import type { BoardEntry } from "../config.js";
import type { AgentTaskCreateInput, AgentTaskPatchInput, AgentTaskStatus } from "../shared/agentRuntime.js";
import { MAX_CONCURRENT_BOARD_FETCHES, mapWithConcurrency } from "../shared/concurrency.js";
import { compareReplaceableEvents, pickLatestParsedEvent, pickLatestParsedEventsByKey } from "../shared/latestEvent.js";
import { nextRecurringTaskPayload } from "../shared/recurringCompletion.js";
import type { Recurrence, TaskAssignee } from "../shared/taskTypes.js";
import { incrementalSyncSince, type TaskCache } from "../taskCache.js";
import { decryptContent, encryptContent, getUserPubkeyHex, resolveBoardEntry, type DecryptedPayload, type RuntimeContext } from "./context.js";
import {
  cacheToRecord,
  decryptTaskEventPayload,
  parseDecryptedEvent,
  recordToCache,
  type ExtendedCreateInput,
  type FullTaskRecord,
} from "./taskCodec.js";

export type ListTasksOptions = {
  boardId?: string;
  status: "open" | "done" | "any";
  columnId?: string;
  refresh?: boolean;
  noCache?: boolean;
};

/**
 * Tasks on boards: kind 30301 events signed by the board's key, read through the local task cache.
 * The `NostrRuntime` facade exposes these methods as they are.
 */
export function createTaskRepository(context: RuntimeContext) {
  const { config, session, ensureConnected, boardRelays, taskCache, clock, randomUUID, isoNow } = context;

  function taskFilter(boardId: string): NDKFilter {
    return {
      kinds: [30301],
      authors: [deriveBoardKeyPair(boardId).pk],
      "#b": [boardTagHash(boardId)],
    };
  }

  async function fetchBoardEvents(boardId: string, taskId: string): Promise<Set<NDKEvent>> {
    const events = await session.fetchEvents(
      [{ ...taskFilter(boardId), "#d": [taskId] }],
      boardRelays(boardId),
      8_000,
      200,
      2_000,
    );
    return new Set(events.map((event) => session.createEvent(event)));
  }

  async function recoverBoardTasks(boardId: string, since?: number, relays = normalizeRelayUrls(boardRelays(boardId))) {
    const events = new Map<string, NDKEvent>();
    const filter = {
      ...taskFilter(boardId),
      ...(since === undefined ? {} : { since }),
      until: Math.floor(Date.now() / 1000) + 300,
    };
    const results = await Promise.allSettled(relays.map((relay) =>
      recoverRelayHistory(session, filter, relay, async (event) => {
        if (!events.has(event.id)) events.set(event.id, session.createEvent(event));
      }, { timeoutMs: since === undefined ? 12_000 : 5_000 }),
    ));
    const failedRelays = relays.filter((_, index) => results[index].status === "rejected");
    if (failedRelays.length) {
      process.stderr.write(`⚠ Task history incomplete for board ${boardId} on ${failedRelays.join(", ")}\n`);
    }
    return { events: events.values(), completed: relays.length > 0 && failedRelays.length === 0 };
  }

  // Resolve from the local full-state cache first, then fall back to relay tags.
  async function resolveTaskId(boardId: string, taskIdOrPrefix: string): Promise<string | null> {
    const exact = taskIdOrPrefix.trim();
    // Standard UUID (36 chars) — return directly without a relay lookup
    if (exact.length === 36) return exact;

    const cachedTasks = taskCache.read().boards[boardId]?.tasks ?? [];
    const cached = resolveIdentifierReference(cachedTasks, exact);
    if (cached) return cached.id;

    const { events: allEvents } = await recoverBoardTasks(boardId);
    const entries = Array.from(allEvents)
      .map((event) => ({ id: readTagValue(event.tags, "d") ?? "" }))
      .filter((entry) => entry.id);

    // For recurring instance IDs ("recurrence:...") the full ID can be >36 chars.
    // resolveIdentifierReference does an exact-match first, so passing the full
    // recurrence ID will always land on the right instance.
    return resolveIdentifierReference(entries, taskIdOrPrefix)?.id ?? null;
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
    event.created_at = nextEventCreatedAt(clock() / 1000, afterCreatedAt);
    event.kind = 30301;
    event.content = encrypted;
    event.tags = [
      ["d", taskId],
      ["b", bTag],
      ["col", colId],
      ["status", status],
    ];
    await session.publishSigned(event, signer, boardRelays(boardId));
    return event;
  }

  async function readBoardTasks(
    cache: TaskCache,
    board: Pick<BoardEntry, "id" | "name">,
    { refresh, noCache }: Pick<ListTasksOptions, "refresh" | "noCache">,
  ): Promise<FullTaskRecord[]> {
    const boardCache = cache.boards[board.id];

    const relays = normalizeRelayUrls(boardRelays(board.id));
    const relayKey = JSON.stringify(relays);
    // Rebuild baselines written by older clients or established against a different relay set.
    const since = boardCache?.historyRelayKey === relayKey
      ? incrementalSyncSince(boardCache, { refresh, noCache })
      : undefined;
    const { events, completed } = await recoverBoardTasks(board.id, since, relays);
    const latestIncoming = await pickLatestParsedEventsByKey(
      events,
      (event) => readTagValue(event.tags, "d"),
      (event) => parseDecryptedEvent(event, board.id, board.name),
    );

    const baseline = noCache ? undefined : boardCache;
    const byId = new Map<string, FullTaskRecord>();
    for (const task of baseline?.tasks ?? []) byId.set(task.id, cacheToRecord(task, board.name));
    let maxCreatedAt = baseline?.lastSyncAt ?? 0;
    for (const { parsed: record, event } of latestIncoming.values()) {
      maxCreatedAt = Math.max(maxCreatedAt, event.created_at ?? 0);
      const existing = byId.get(record.id);
      if (!existing || compareReplaceableEvents(
        { created_at: record.createdAt, id: record.nostrEventId },
        { created_at: existing.createdAt, id: existing.nostrEventId },
      ) > 0) {
        byId.set(record.id, record);
      }
    }
    const mergedRecords = Array.from(byId.values());

    // An interrupted relay response can be newest-first. Keep the previous checkpoint so
    // the next read can still reach the older records it missed.
    const lastSyncAt = completed ? maxCreatedAt : baseline?.lastSyncAt;
    const historyRelayKey = completed ? relayKey : baseline?.historyRelayKey;
    if (!noCache || completed) {
      cache.boards[board.id] = {
        tasks: mergedRecords.map(recordToCache),
        fetchedAt: completed ? clock() : (baseline?.fetchedAt ?? 0),
        ...(lastSyncAt ? { lastSyncAt } : {}),
        ...(historyRelayKey ? { historyRelayKey } : {}),
      };
    }
    return mergedRecords;
  }

  const repository = {
    async listTasks({ boardId, status, columnId, refresh, noCache }: ListTasksOptions): Promise<FullTaskRecord[]> {
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

      const cache = taskCache.read();
      const records: FullTaskRecord[] = [];
      const boardReads = new Map<string, Promise<FullTaskRecord[]>>();
      await ensureConnected();

      function read(board: Pick<BoardEntry, "id" | "name">): Promise<FullTaskRecord[]> {
        const pending = boardReads.get(board.id);
        if (pending) return pending;
        const lookup = readBoardTasks(cache, board, { refresh, noCache });
        boardReads.set(board.id, lookup);
        return lookup;
      }

      function matchesListing(record: FullTaskRecord): boolean {
        return !record.deleted
          && (columnId === undefined || record.column === columnId)
          && (status === "any" || record.completed === (status === "done"));
      }

      for (const board of boards) {
        if (board.kind !== "compound") {
          for (const record of await read(board)) {
            if (matchesListing(record)) records.push(record);
          }
          continue;
        }
        const seen = new Set<string>();
        const childResults = await mapWithConcurrency(board.children ?? [], MAX_CONCURRENT_BOARD_FETCHES, async (childId) => {
          const child = resolveBoardEntry(config, childId) ?? { id: childId, name: childId };
          return { childId, tasks: await read(child) };
        });
        for (const { childId, tasks } of childResults) {
          for (const record of tasks) {
            if (seen.has(record.id)) continue;
            seen.add(record.id);
            if (matchesListing(record)) records.push({ ...record, sourceBoardId: childId });
          }
        }
      }

      taskCache.write(cache);
      records.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
      return records;
    },

    async createTask(input: AgentTaskCreateInput): Promise<FullTaskRecord> {
      return repository.createTaskFull(input);
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
      const taskId = input.taskId?.trim() || randomUUID();
      const userPubkey = getUserPubkeyHex(config);
      if (!userPubkey) {
        process.stderr.write(
          "\x1b[33m(warning: no nsec configured — createdBy/lastEditedBy will be empty)\x1b[0m\n",
        );
      }
      const now = clock();
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
      const cache = taskCache.read();
      const boardCache = cache.boards[boardId] ?? { tasks: [], fetchedAt: clock() };
      boardCache.tasks = boardCache.tasks.filter((t) => t.id !== taskId);
      boardCache.tasks.push(recordToCache(result));
      cache.boards[boardId] = boardCache;
      taskCache.write(cache);
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
        ...(patch.order !== undefined ? { order: patch.order } : {}),
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
      // `reminders` stays as received: the PWA and iOS sync them in the payload, so an edit here must
      // not drop theirs. This device's own reminders are local (`remindTask`) and never published.
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
        order: merged.order,
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
      const cache = taskCache.read();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId);
        bc.tasks.push(recordToCache(updated));
        taskCache.write(cache);
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
        completedAt: completed ? isoNow() : null,
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
      // Completing a recurring task opens its next occurrence, as the PWA and iOS do. The id is
      // derived from the series and date, so a copy another device already made is left alone.
      let nextRecord: FullTaskRecord | null = null;
      const next = completed && !existing.completed ? nextRecurringTaskPayload(taskId, rawPayload, { now: clock() }) : null;
      if (next) {
        const existingNext = await pickLatestParsedEvent(
          await fetchBoardEvents(entry.id, next.taskId),
          (evt) => parseDecryptedEvent(evt, entry.id, entry.name),
        );
        if (!existingNext || existingNext.parsed.deleted) {
          const nextPayload = { ...next.payload, lastEditedBy: userPubkey };
          const nextEvent = await publishTaskEvent(
            entry.id,
            next.taskId,
            nextPayload,
            "open",
            colId,
            existingNext?.event.created_at,
          );
          const parsedNext = await parseDecryptedEvent(nextEvent, entry.id, entry.name);
          if (parsedNext) nextRecord = { ...parsedNext, nostrEventId: nextEvent.id };
        }
      }
      // Update cache
      const cache = taskCache.read();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId && t.id !== nextRecord?.id);
        bc.tasks.push(recordToCache(updated));
        if (nextRecord) bc.tasks.push(recordToCache(nextRecord));
        taskCache.write(cache);
      }
      return nextRecord ? { ...updated, nextOccurrence: { id: nextRecord.id, dueISO: nextRecord.dueISO } } : updated;
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

      // Publish the status=deleted tombstone only. It replaces the task at its address on every
      // relay and every client reads it; a NIP-09 deletion on top doubled each delete and made
      // strfry refuse the tombstone ("deleted:") when it arrived first. Matches the PWA and native.
      await publishTaskEvent(entry.id, taskId, rawPayload, "deleted", colId, event.created_at);

      // Remove from cache
      const cache = taskCache.read();
      const bc = cache.boards[entry.id];
      if (bc) {
        bc.tasks = bc.tasks.filter((t) => t.id !== taskId);
        taskCache.write(cache);
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
        const respondedEpoch = respondedAt ? Math.floor(new Date(respondedAt).getTime() / 1000) : Math.floor(clock() / 1000);
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

    async clearCompleted(boardId: string): Promise<number> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return 0;
      if (entry.clearCompletedDisabled === true) {
        throw new Error("Clear completed is disabled on this board.");
      }
      const { events } = await recoverBoardTasks(entry.id);
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
  return repository;
}
