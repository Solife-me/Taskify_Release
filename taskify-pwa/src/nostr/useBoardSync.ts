import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NDKKind } from "@nostr-dev-kit/ndk";
import { recoverRelayHistory } from "taskify-runtime-nostr";
import { NostrSession } from "./NostrSession";
import { useSyncResume } from "./useSyncResume";
import { historyRecoverySince, setHistoryWatermark } from "./historyWatermarks";
import { boardTag } from "../boardCrypto";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { dedupeRecurringInstances } from "../domains/tasks/taskUtils";
import { TASKIFY_CALENDAR_EVENT_KIND } from "../lib/privateCalendar";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_TASKS } from "../storage/taskifyDb";

const LS_BOARD_SYNC_CURSORS = "taskify_board_sync_cursors_v1";
const NOSTR_INITIAL_SYNC_TIMEOUT_MS = 25000;
const NOSTR_CURSOR_LOOKBACK_SECS = 300;
const NOSTR_BOARD_YIELD_INTERVAL = 50;
/** Re-read this much before the last complete recovery, for clock skew between devices. */
const BOARD_HISTORY_LOOKBACK_SECS = 300;
/** Task ids per verify REQ, well inside relays' filter and message limits. */
const VERIFY_UNSEEN_BATCH = 100;

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((prev: T) => T)) => void;

export type BoardSyncTask = Task & { _nostrAt?: number };
export type BoardSyncRelayBatchEntry = BoardSyncTask | { _deleted: true; _nostrAt: number };
export type BoardSyncNostrIndex = {
  boardMeta: Map<string, number>;
  taskClock: Map<string, Map<string, number>>;
  calendarClock: Map<string, Map<string, number>>;
};
export type BoardSyncNostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
  __relay?: string;
};
export type BoardSyncNostrPool = {
  setRelays: (urls: string[]) => void;
  subscribe: (
    relays: string[],
    filters: Array<Record<string, unknown>>,
    onEvent: (ev: BoardSyncNostrEvent, from?: string) => void,
    onEose?: (from?: string) => void,
  ) => () => void;
};

type UseBoardSyncParams = {
  boards: Board[];
  boardsRef: MutableRef<Board[]>;
  tasksRef: MutableRef<BoardSyncTask[]>;
  setTasks: StateSetter<BoardSyncTask[]>;
  sanitizeTasks?: (tasks: BoardSyncTask[]) => BoardSyncTask[];
  pool: BoardSyncNostrPool;
  getBoardRelays: (board: Board) => string[];
  nostrIdxRef: MutableRef<BoardSyncNostrIndex>;
  boardSyncCursorsRef: MutableRef<Record<string, number>>;
  relayBatchRef: MutableRef<Map<string, Map<string, Map<string, BoardSyncRelayBatchEntry>>>>;
  pendingRelaysByBoardRef: MutableRef<Map<string, Set<string>>>;
  seenBoardTasksRef: MutableRef<Map<string, Set<string>>>;
  pendingNostrTasksRef: MutableRef<Set<string>>;
  completedNostrInitialSyncRef: MutableRef<Set<string>>;
  setPendingNostrInitialSyncByBoardTag: StateSetter<Record<string, true>>;
  markNostrBoardInitialSyncComplete: (bTag: string) => void;
  tagValue: (ev: BoardSyncNostrEvent, name: string) => string | undefined;
  applyBoardEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
  applyTaskEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
  applyCalendarEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
  fullHistorySyncNonce?: number;
};

function relayBatchEventAt(entry: BoardSyncRelayBatchEntry | undefined): number {
  if (!entry) return -1;
  return "_deleted" in entry ? entry._nostrAt : entry._nostrAt ?? 0;
}

function mergeRelayBatches(
  batches: Map<string, Map<string, BoardSyncRelayBatchEntry>>,
  replaceOnEqual: boolean,
): Map<string, BoardSyncRelayBatchEntry> {
  const combined = new Map<string, BoardSyncRelayBatchEntry>();
  for (const relayBatch of batches.values()) {
    for (const [key, entry] of relayBatch) {
      const existing = combined.get(key);
      const incomingAt = relayBatchEventAt(entry);
      const existingAt = relayBatchEventAt(existing);
      if (!existing || incomingAt > existingAt || (replaceOnEqual && incomingAt >= existingAt)) {
        combined.set(key, entry);
      }
    }
  }
  return combined;
}

export function buildBoardSyncFilters({
  bTag,
  cursor,
  fullHistory,
}: {
  bTag: string;
  cursor?: number;
  fullHistory?: boolean;
}): Array<Record<string, unknown>> {
  const sinceFilter = fullHistory
    ? {}
    : cursor
      ? { since: Math.max(0, cursor - NOSTR_CURSOR_LOOKBACK_SECS) }
      : {};
  return [
    { kinds: [30300, 30301], "#b": [bTag], ...sinceFilter },
    { kinds: [30300], "#d": [bTag], limit: 1 },
    { kinds: [TASKIFY_CALENDAR_EVENT_KIND], "#b": [bTag], ...sinceFilter },
  ];
}

/**
 * Relays cap concurrent REQs per connection (strfry: "too many concurrent REQs"), and an account
 * with compound boards easily has dozens of boards. Boards on the same relays share a REQ, up to
 * this many, each keeping its own filters and cursors. Matches native `BoardSubscriptionGrouping`.
 */
export const BOARDS_PER_SUBSCRIPTION = 10;

export function groupBoardsForSubscription<T extends { id: string; relays: string }>(items: T[]): T[][] {
  const byRelays = new Map<string, T[]>();
  for (const item of items) {
    const group = byRelays.get(item.relays) ?? [];
    group.push(item);
    byRelays.set(item.relays, group);
  }
  const chunks: T[][] = [];
  for (const group of byRelays.values()) {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let index = 0; index < sorted.length; index += BOARDS_PER_SUBSCRIPTION) {
      chunks.push(sorted.slice(index, index + BOARDS_PER_SUBSCRIPTION));
    }
  }
  return chunks;
}

/** Which board an event from a grouped board REQ belongs to. */
export function boardTagForSyncEvent(event: { kind: number; tags?: string[][] }): string | null {
  const tag = (name: string) => (event.tags ?? []).find((entry) => entry[0] === name)?.[1] ?? null;
  return tag("b") ?? (event.kind === 30300 ? tag("d") : null);
}

/**
 * History catch-up runs one REQ per board per relay. Started for every board at once, that is
 * dozens of concurrent REQs on each relay; this keeps a few in flight per relay.
 */
export const MAX_CONCURRENT_HISTORY_RECOVERIES_PER_RELAY = 3;
const historyRecoverySlots = new Map<string, { active: number; waiting: Array<() => void> }>();

export async function withHistoryRecoverySlot<T>(relay: string, work: () => Promise<T>): Promise<T> {
  let slots = historyRecoverySlots.get(relay);
  if (!slots) {
    slots = { active: 0, waiting: [] };
    historyRecoverySlots.set(relay, slots);
  }
  const state = slots;
  if (state.active >= MAX_CONCURRENT_HISTORY_RECOVERIES_PER_RELAY) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.active += 1;
  try {
    return await work();
  } finally {
    state.active -= 1;
    state.waiting.shift()?.();
  }
}

export function useBoardSync({
  boards,
  boardsRef,
  tasksRef,
  setTasks,
  sanitizeTasks,
  pool,
  getBoardRelays,
  nostrIdxRef,
  boardSyncCursorsRef,
  relayBatchRef,
  pendingRelaysByBoardRef,
  seenBoardTasksRef,
  pendingNostrTasksRef,
  completedNostrInitialSyncRef,
  setPendingNostrInitialSyncByBoardTag,
  markNostrBoardInitialSyncComplete,
  tagValue,
  applyBoardEvent,
  applyTaskEvent,
  applyCalendarEvent,
  fullHistorySyncNonce = 0,
}: UseBoardSyncParams): void {
  const resumeEpoch = useSyncResume();
  const nostrBoardsKey = useMemo(() => {
    const items = boards
      .filter((board) => board.nostr?.boardId)
      .map((board) => ({
        id: boardTag(board.nostr!.boardId),
        relays: getBoardRelays(board).join(","),
      }))
      .sort((a, b) => (a.id + a.relays).localeCompare(b.id + b.relays));
    return JSON.stringify(items);
  }, [boards, getBoardRelays]);

  const handledFullHistorySyncNonceRef = useRef(0);

  const boardEventQueuesRef = useRef<Map<string, { promise: Promise<void>; count: number }>>(new Map());
  const enqueueForBoard = useCallback((boardId: string, fn: () => Promise<void>): Promise<void> => {
    const entry = boardEventQueuesRef.current.get(boardId) ?? { promise: Promise.resolve(), count: 0 };
    entry.count++;
    const shouldYield = entry.count % NOSTR_BOARD_YIELD_INTERVAL === 0;
    const next = entry.promise.catch(() => {}).then(async () => {
      if (shouldYield) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      return fn();
    });
    entry.promise = next.then(() => {}, () => {});
    boardEventQueuesRef.current.set(boardId, entry);
    return next;
  }, []);

  const flushRelayBatch = useCallback(
    (bTag: string, relayBatch: Map<string, BoardSyncRelayBatchEntry>) => {
      if (!relayBatch.size) return;
      const bTagClock = nostrIdxRef.current.taskClock.get(bTag);
      setTasks((prev) => {
        const merged = new Map<string, BoardSyncTask>(
          prev.map((task) => [`${task.boardId}::${task.id}`, task]),
        );
        for (const [key, entry] of relayBatch) {
          const taskId = key.split("::")[1] ?? "";
          const incomingNostrAt =
            "_deleted" in entry ? entry._nostrAt : entry._nostrAt ?? bTagClock?.get(taskId) ?? 0;
          const existingTask = merged.get(key);
          const existingNostrAt = Math.max(existingTask?._nostrAt ?? 0, bTagClock?.get(taskId) ?? 0);
          if (incomingNostrAt < existingNostrAt) continue;
          if ("_deleted" in entry) merged.delete(key);
          else merged.set(key, entry);
        }
        const deduped = dedupeRecurringInstances(Array.from(merged.values())) as BoardSyncTask[];
        return sanitizeTasks ? sanitizeTasks(deduped) : deduped;
      });
    },
    [nostrIdxRef, sanitizeTasks, setTasks],
  );

  const verifyUnseenTasks = useCallback(
    // `isDisposed` reports whether the subscription effect that started this check has since been
    // torn down; late verify events are dropped then.
    (bTag: string, boardRelays: string[], isDisposed: () => boolean) => {
      const seenIds = seenBoardTasksRef.current.get(bTag) ?? new Set<string>();
      const board = boardsRef.current.find(
        (candidate) => candidate.nostr?.boardId && boardTag(candidate.nostr.boardId) === bTag,
      );
      if (!board) {
        seenBoardTasksRef.current.delete(bTag);
        return;
      }
      const boardId = board.id;
      const verifyRecentGraceSecs = 60;
      const nowSecs = Math.floor(Date.now() / 1000);
      // Open tasks only: a completion or deletion that reached the relays after this device's
      // cursor passed it is what leaves a stale task showing. Asking about every task this board
      // ever held put thousands of ids in one REQ, more than relays accept, so nothing was checked.
      const unseenIds = tasksRef.current
        .filter((task) => {
          if (task.boardId !== boardId) return false;
          if (task.completed) return false;
          if (typeof task._nostrAt !== "number" || task._nostrAt <= 0) return false;
          if (seenIds.has(task.id)) return false;
          if (pendingNostrTasksRef.current.has(`${bTag}::${task.id}`)) return false;
          if (nowSecs - task._nostrAt < verifyRecentGraceSecs) return false;
          return true;
        })
        .map((task) => task.id);
      seenBoardTasksRef.current.delete(bTag);
      if (!unseenIds.length) return;

      for (let start = 0; start < unseenIds.length; start += VERIFY_UNSEEN_BATCH) {
        const batch = unseenIds.slice(start, start + VERIFY_UNSEEN_BATCH);
        let verifyUnsub: (() => void) | null = null;
        verifyUnsub = pool.subscribe(
          boardRelays,
          [{ kinds: [30301], "#b": [bTag], "#d": batch }],
          (ev, evRelay) => {
            if (isDisposed()) return;
            ev.__relay = evRelay;
            enqueueForBoard(bTag, () => applyTaskEvent(ev)).catch(() => {});
          },
          () => {
            verifyUnsub?.();
          },
        );
        window.setTimeout(() => {
          try {
            verifyUnsub?.();
          } catch {
            // already closed
          }
        }, 15000);
      }
    },
    [
      applyTaskEvent,
      boardsRef,
      enqueueForBoard,
      pendingNostrTasksRef,
      pool,
      seenBoardTasksRef,
      tasksRef,
    ],
  );

  useEffect(() => {
    let disposed = false;
    let parsed: Array<{ id: string; relays: string }> = [];
    try {
      parsed = JSON.parse(nostrBoardsKey || "[]") as Array<{ id: string; relays: string }>;
    } catch {
      parsed = [];
    }
    const forceFullHistorySync =
      fullHistorySyncNonce > 0 && fullHistorySyncNonce !== handledFullHistorySyncNonceRef.current;
    if (forceFullHistorySync) {
      handledFullHistorySyncNonceRef.current = fullHistorySyncNonce;
    }
    const pendingRelaysByBoard = pendingRelaysByBoardRef.current;
    const relayBatches = relayBatchRef.current;
    const unsubs: Array<() => void> = [];
    const recovery = new AbortController();
    const syncTimeoutByBoard = new Map<string, number>();
    const clearSyncTimeout = (bTag: string) => {
      const timeoutId = syncTimeoutByBoard.get(bTag);
      if (timeoutId == null) return;
      window.clearTimeout(timeoutId);
      syncTimeoutByBoard.delete(bTag);
    };
    const persistCursors = () => {
      try {
        idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current));
      } catch {
        // non-fatal
      }
    };
    const completeBoardSync = (bTag: string, relayList: string[]) => {
      if (disposed) return;
      clearSyncTimeout(bTag);
      pendingRelaysByBoard.delete(bTag);
      completedNostrInitialSyncRef.current.add(bTag);
      markNostrBoardInitialSyncComplete(bTag);
      persistCursors();
      window.setTimeout(() => { if (!disposed) verifyUnseenTasks(bTag, relayList, () => disposed); }, 500);
    };

    setPendingNostrInitialSyncByBoardTag((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const item of parsed) {
        if (next[item.id]) continue;
        next[item.id] = true;
        changed = true;
      }
      return changed ? next : prev;
    });

    const boardHandlers = new Map<string, { onEvent: (ev: any, relay?: string) => void; onEose: (relay?: string) => void }>();
    for (const item of parsed) {
      const relayList = item.relays.split(",").filter(Boolean);
      if (!relayList.length) continue;

      pendingRelaysByBoard.set(item.id, new Set(relayList));

      const timeoutId = window.setTimeout(() => {
        clearSyncTimeout(item.id);
        void enqueueForBoard(item.id, async () => {
          if (disposed) return;
          const boardBatch = relayBatchRef.current.get(item.id);
          if (boardBatch?.size) {
            flushRelayBatch(item.id, mergeRelayBatches(boardBatch, true));
            relayBatchRef.current.delete(item.id);
          }
          completeBoardSync(item.id, relayList);
        });
      }, NOSTR_INITIAL_SYNC_TIMEOUT_MS);
      syncTimeoutByBoard.set(item.id, timeoutId);

      pool.setRelays(relayList);
      boardHandlers.set(item.id, {
        onEvent: (ev: any, evRelay?: string) => {
          if (disposed) return;
          ev.__relay = evRelay;
          if (ev.kind === 30300) enqueueForBoard(item.id, () => applyBoardEvent(ev)).catch(() => {});
          else if (ev.kind === 30301) {
            const taskId = tagValue(ev, "d");
            if (taskId) {
              const seen = seenBoardTasksRef.current.get(item.id) ?? new Set<string>();
              seen.add(taskId);
              seenBoardTasksRef.current.set(item.id, seen);
            }
            enqueueForBoard(item.id, () => applyTaskEvent(ev)).catch(() => {});
          }
          else if (ev.kind === TASKIFY_CALENDAR_EVENT_KIND) {
            enqueueForBoard(item.id, () => applyCalendarEvent(ev)).catch(() => {});
          }
        },
        onEose: (eoseRelay?: string) => {
          // Decryption is asynchronous. Keep the relay pending until every
          // earlier event has entered its batch, then read and flush that batch.
          void enqueueForBoard(item.id, async () => {
            if (disposed) return;
            const boardBatch = relayBatchRef.current.get(item.id);
            if (!eoseRelay) {
              if (boardBatch?.size) flushRelayBatch(item.id, mergeRelayBatches(boardBatch, false));
              relayBatchRef.current.delete(item.id);
              completeBoardSync(item.id, relayList);
              return;
            }
            const relayBatch = boardBatch?.get(eoseRelay);
            if (relayBatch?.size) flushRelayBatch(item.id, relayBatch);
            boardBatch?.delete(eoseRelay);
            if (!boardBatch?.size) relayBatchRef.current.delete(item.id);
            pendingRelaysByBoard.get(item.id)?.delete(eoseRelay);
            if (!pendingRelaysByBoard.get(item.id)?.size) completeBoardSync(item.id, relayList);
          });
        },
      });
      // Live cursors can skip records (a capped, newest-first response advances them past
      // older events), so retained history is reconciled independently of them. The first
      // complete pass reads everything; after that each relay is read from its last complete
      // recovery, so a resume costs only what changed.
      void (async () => {
        const session = await NostrSession.init(relayList);
        for (const relay of relayList) {
          if (recovery.signal.aborted) return;
          const watermarkKey = `board:${item.id}:${relay}`;
          const startedAt = Math.floor(Date.now() / 1000);
          const since = historyRecoverySince(watermarkKey, BOARD_HISTORY_LOOKBACK_SECS, forceFullHistorySync);
          try {
            // Taskify's board, task and calendar kinds are not members of NDK's kind enum.
            const historyKinds = [30300, 30301, TASKIFY_CALENDAR_EVENT_KIND] as number[] as NDKKind[];
            const filter = { kinds: historyKinds, "#b": [item.id], ...(since != null ? { since } : {}) };
            await withHistoryRecoverySlot(relay, () => recoverRelayHistory(session, filter, relay, async (event) => {
              if (recovery.signal.aborted) return;
              await enqueueForBoard(item.id, async () => {
                if (recovery.signal.aborted) return;
                // Recovery delivers directly; it is independent of live EOSE batches.
                if (event.kind === 30300) await applyBoardEvent(event);
                else if (event.kind === 30301) await applyTaskEvent(event);
                else await applyCalendarEvent(event);
              });
            }, { signal: recovery.signal }));
            if (recovery.signal.aborted) return;
            if (!recovery.signal.aborted) setHistoryWatermark(watermarkKey, startedAt);
          } catch (error) {
            if (!recovery.signal.aborted) console.warn("[nostr] board history recovery incomplete", error);
          }
        }
      })().catch(error => {
        if (!recovery.signal.aborted) console.warn("[nostr] board history recovery failed", error);
      });
    }

    for (const chunk of groupBoardsForSubscription(parsed.filter((item) => boardHandlers.has(item.id)))) {
      const relayList = chunk[0].relays.split(",").filter(Boolean);
      const filters = chunk.flatMap((item) => buildBoardSyncFilters({
        bTag: item.id,
        cursor: boardSyncCursorsRef.current[item.id],
        fullHistory: forceFullHistorySync,
      }));
      const members = chunk.map((item) => item.id);
      const unsub = pool.subscribe(
        relayList,
        filters as any,
        (ev, evRelay) => {
          const bTag = boardTagForSyncEvent(ev as any);
          if (!bTag || !members.includes(bTag)) return;
          boardHandlers.get(bTag)?.onEvent(ev, evRelay);
        },
        // One EOSE per relay covers every board in the REQ.
        (eoseRelay) => members.forEach((bTag) => boardHandlers.get(bTag)?.onEose(eoseRelay)),
      );
      unsubs.push(unsub);
    }

    return () => {
      disposed = true;
      recovery.abort();
      unsubs.forEach((unsub) => unsub());
      syncTimeoutByBoard.forEach((timeoutId) => window.clearTimeout(timeoutId));
      for (const item of parsed) {
        pendingRelaysByBoard.delete(item.id);
        // Drain work already decrypting before a replacement subscription begins.
        void enqueueForBoard(item.id, async () => {
          const batch = relayBatches.get(item.id);
          if (batch?.size) flushRelayBatch(item.id, mergeRelayBatches(batch, false));
          relayBatches.delete(item.id);
        });
      }
    };
  }, [
    applyBoardEvent,
    applyCalendarEvent,
    applyTaskEvent,
    boardSyncCursorsRef,
    completedNostrInitialSyncRef,
    enqueueForBoard,
    flushRelayBatch,
    markNostrBoardInitialSyncComplete,
    nostrBoardsKey,
    fullHistorySyncNonce,
    resumeEpoch,
    pendingRelaysByBoardRef,
    pool,
    relayBatchRef,
    seenBoardTasksRef,
    setPendingNostrInitialSyncByBoardTag,
    tagValue,
    verifyUnseenTasks,
  ]);
}
