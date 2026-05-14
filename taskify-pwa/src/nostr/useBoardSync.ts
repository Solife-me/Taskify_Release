import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardTag } from "../boardCrypto";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { dedupeRecurringInstances } from "../domains/tasks/taskUtils";
import { TASKIFY_CALENDAR_EVENT_KIND } from "../lib/privateCalendar";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_TASKS } from "../storage/taskifyDb";

const LS_BOARD_SYNC_CURSORS = "taskify_board_sync_cursors_v1";
const NOSTR_MIGRATION_BUFFER_MS = 15000;
const NOSTR_INITIAL_SYNC_TIMEOUT_MS = 25000;
const NOSTR_CURSOR_LOOKBACK_SECS = 300;
const NOSTR_BOARD_YIELD_INTERVAL = 50;

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
  currentBoard: Board | null | undefined;
  boardsRef: MutableRef<Board[]>;
  tasksRef: MutableRef<BoardSyncTask[]>;
  setTasks: StateSetter<BoardSyncTask[]>;
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
  ensureMigrationState: (bTag: string) => unknown;
  migrateBoardRef: MutableRef<(bTag: string) => void>;
  tagValue: (ev: BoardSyncNostrEvent, name: string) => string | undefined;
  applyBoardEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
  applyTaskEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
  applyCalendarEvent: (ev: BoardSyncNostrEvent) => Promise<void>;
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

export function useBoardSync({
  boards,
  currentBoard,
  boardsRef,
  tasksRef,
  setTasks,
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
  ensureMigrationState,
  migrateBoardRef,
  tagValue,
  applyBoardEvent,
  applyTaskEvent,
  applyCalendarEvent,
}: UseBoardSyncParams): void {
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

  const [nostrRefresh, setNostrRefresh] = useState(0);

  useEffect(() => {
    if (!currentBoard?.nostr?.boardId) return;
    setNostrRefresh((n) => n + 1);
  }, [currentBoard?.nostr?.boardId]);

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
        return dedupeRecurringInstances(Array.from(merged.values())) as BoardSyncTask[];
      });
    },
    [nostrIdxRef, setTasks],
  );

  const verifyUnseenTasks = useCallback(
    (bTag: string, boardRelays: string[]) => {
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
      const unseenIds = tasksRef.current
        .filter((task) => {
          if (task.boardId !== boardId) return false;
          if (typeof task._nostrAt !== "number" || task._nostrAt <= 0) return false;
          if (seenIds.has(task.id)) return false;
          if (pendingNostrTasksRef.current.has(`${bTag}::${task.id}`)) return false;
          if (nowSecs - task._nostrAt < verifyRecentGraceSecs) return false;
          return true;
        })
        .map((task) => task.id);
      seenBoardTasksRef.current.delete(bTag);
      if (!unseenIds.length) return;

      const verifySeen = new Set<string>();
      let verifyUnsub: (() => void) | null = null;
      verifyUnsub = pool.subscribe(
        boardRelays,
        [{ kinds: [30301], "#b": [bTag], "#d": unseenIds }],
        (ev, evRelay) => {
          const taskId = tagValue(ev, "d");
          if (taskId) verifySeen.add(taskId);
          ev.__relay = evRelay;
          enqueueForBoard(bTag, () => applyTaskEvent(ev)).catch(() => {});
        },
        () => {
          verifyUnsub?.();
          const toRemove = unseenIds.filter((id) => !verifySeen.has(id));
          if (toRemove.length) {
            const removeSet = new Set(toRemove);
            setTasks((prev) => {
              const next = prev.filter((task) => !(task.boardId === boardId && removeSet.has(task.id)));
              return next.length === prev.length ? prev : (dedupeRecurringInstances(next) as BoardSyncTask[]);
            });
          }
        },
      );
      window.setTimeout(() => {
        try {
          verifyUnsub?.();
        } catch {
          // already closed
        }
      }, 15000);
    },
    [
      applyTaskEvent,
      boardsRef,
      enqueueForBoard,
      pendingNostrTasksRef,
      pool,
      seenBoardTasksRef,
      setTasks,
      tagValue,
      tasksRef,
    ],
  );

  useEffect(() => {
    let parsed: Array<{ id: string; relays: string }> = [];
    try {
      parsed = JSON.parse(nostrBoardsKey || "[]") as Array<{ id: string; relays: string }>;
    } catch {
      parsed = [];
    }
    const pendingRelaysByBoard = pendingRelaysByBoardRef.current;
    const unsubs: Array<() => void> = [];
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
      clearSyncTimeout(bTag);
      pendingRelaysByBoard.delete(bTag);
      completedNostrInitialSyncRef.current.add(bTag);
      markNostrBoardInitialSyncComplete(bTag);
      persistCursors();
      window.setTimeout(() => migrateBoardRef.current(bTag), NOSTR_MIGRATION_BUFFER_MS);
      window.setTimeout(() => verifyUnseenTasks(bTag, relayList), 500);
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

    for (const item of parsed) {
      const relayList = item.relays.split(",").filter(Boolean);
      if (!relayList.length) continue;

      pendingRelaysByBoard.set(item.id, new Set(relayList));

      const timeoutId = window.setTimeout(() => {
        clearSyncTimeout(item.id);
        const boardBatch = relayBatchRef.current.get(item.id);
        if (boardBatch?.size) {
          const combined = mergeRelayBatches(boardBatch, true);
          flushRelayBatch(item.id, combined);
          relayBatchRef.current.delete(item.id);
        }
        completeBoardSync(item.id, relayList);
      }, NOSTR_INITIAL_SYNC_TIMEOUT_MS);
      syncTimeoutByBoard.set(item.id, timeoutId);

      pool.setRelays(relayList);
      ensureMigrationState(item.id);

      const initialSyncFallbackDays = 30;
      const cursor = boardSyncCursorsRef.current[item.id];
      const sinceFilter = cursor
        ? { since: Math.max(0, cursor - NOSTR_CURSOR_LOOKBACK_SECS) }
        : { since: Math.floor(Date.now() / 1000) - initialSyncFallbackDays * 24 * 3600 };
      const filters = [
        { kinds: [30300, 30301], "#b": [item.id], ...sinceFilter },
        { kinds: [30300], "#d": [item.id], limit: 1 },
        { kinds: [TASKIFY_CALENDAR_EVENT_KIND], "#b": [item.id], ...sinceFilter },
      ];

      const unsub = pool.subscribe(
        relayList,
        filters,
        (ev, evRelay) => {
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
        (eoseRelay) => {
          if (!eoseRelay) {
            const boardBatch = relayBatchRef.current.get(item.id);
            if (boardBatch?.size) {
              const combined = mergeRelayBatches(boardBatch, false);
              relayBatchRef.current.delete(item.id);
              (boardEventQueuesRef.current.get(item.id)?.promise ?? Promise.resolve())
                .catch(() => {})
                .then(() => {
                  if (combined.size) flushRelayBatch(item.id, combined);
                });
            }
            completeBoardSync(item.id, relayList);
            return;
          }

          pendingRelaysByBoard.get(item.id)?.delete(eoseRelay);

          const boardBatch = relayBatchRef.current.get(item.id);
          const relayBatch = boardBatch?.get(eoseRelay);
          if (relayBatch?.size) {
            boardBatch!.delete(eoseRelay);
            (boardEventQueuesRef.current.get(item.id)?.promise ?? Promise.resolve())
              .catch(() => {})
              .then(() => {
                flushRelayBatch(item.id, relayBatch);
              });
          }

          const pendingRelays = pendingRelaysByBoard.get(item.id);
          if (!pendingRelays?.size) {
            completeBoardSync(item.id, relayList);
          }
        },
      );
      unsubs.push(unsub);
    }

    return () => {
      unsubs.forEach((unsub) => unsub());
      syncTimeoutByBoard.forEach((timeoutId) => window.clearTimeout(timeoutId));
      for (const item of parsed) pendingRelaysByBoard.delete(item.id);
    };
  }, [
    applyBoardEvent,
    applyCalendarEvent,
    applyTaskEvent,
    boardSyncCursorsRef,
    completedNostrInitialSyncRef,
    enqueueForBoard,
    ensureMigrationState,
    flushRelayBatch,
    markNostrBoardInitialSyncComplete,
    migrateBoardRef,
    nostrBoardsKey,
    nostrRefresh,
    pendingRelaysByBoardRef,
    pool,
    relayBatchRef,
    setPendingNostrInitialSyncByBoardTag,
    verifyUnseenTasks,
  ]);
}
