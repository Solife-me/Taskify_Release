/**
 * The relay sync rules, tested on the code App and useBoardSync run (these scenarios used to be
 * checked against copies of that code in relaySyncBehavior.test.ts).
 */
import { describe, expect, test, vi } from "vitest";
import type { Board } from "../domains/tasks/taskTypes";
import { BoardSyncLedger } from "./boardSyncLedger";
import { taskEventBody } from "./boardWire";
import { parseTaskEvent } from "./taskEventMerge";
import {
  addToRelayBatch,
  applyIncomingTask,
  LiveUpdateBatcher,
  mergeRelayBatches,
  mergeRelayBatchIntoTasks,
  type IncomingTaskUpdate,
  type RelayBatchEntry,
  type SyncedTask,
} from "./taskSyncMerge";

const BOARD = { id: "board1", name: "Team", kind: "lists", columns: [{ id: "todo", name: "Todo" }, { id: "doing", name: "Doing" }] } as unknown as Board;
const TAG = "tag1";

const task = (id: string, at: number, extra: Partial<SyncedTask> = {}): SyncedTask =>
  ({ id, boardId: "board1", title: `Task ${id}`, dueISO: "2026-10-19T12:00:00.000Z", _nostrAt: at, ...extra }) as SyncedTask;
const deletion = (at: number): RelayBatchEntry => ({ _deleted: true, _nostrAt: at });
const batch = (entries: Array<[string, RelayBatchEntry]>) => new Map<string, RelayBatchEntry>(entries);
// Stand-ins for the ledger's rule: no known version, or a clock per task.
const noClock = () => true;
const clockOf = (entries: Record<string, number>) => (taskId: string, version: { createdAt: number }) =>
  version.createdAt >= (entries[taskId] ?? 0);

function incoming(id: string, at: number, title: string, columnId = "todo"): IncomingTaskUpdate {
  return {
    deleted: false,
    at,
    incoming: parseTaskEvent({ title, dueISO: "2026-10-19T12:00:00.000Z" }, { taskId: id, column: columnId, createdAt: at }, BOARD, new Date()),
    eventPubkey: "b".repeat(64),
    incomingIsNewerOnTie: true,
    now: at * 1000,
  };
}

describe("merging a relay's batch never regresses local data", () => {
  test("an older relay copy does not overwrite a newer local task", () => {
    const result = mergeRelayBatchIntoTasks([task("t1", 1000)], batch([["board1::t1", task("t1", 500, { title: "STALE" })]]), noClock);
    expect(result).toEqual([task("t1", 1000)]);
  });

  test("a newer relay copy updates it; an equal one applies (idempotent re-sync)", () => {
    expect(mergeRelayBatchIntoTasks([task("t1", 500)], batch([["board1::t1", task("t1", 1000, { title: "Updated" })]]), noClock)[0].title).toBe("Updated");
    expect(mergeRelayBatchIntoTasks([task("t1", 1000)], batch([["board1::t1", task("t1", 1000, { title: "Same" })]]), noClock)[0].title).toBe("Same");
  });

  test("a stale create does not resurrect a task deleted later (the clock remembers the deletion)", () => {
    expect(mergeRelayBatchIntoTasks([], batch([["board1::gone", task("gone", 100)]]), clockOf({ gone: 200 }))).toEqual([]);
  });

  test("a create newer than the deletion re-opens the task", () => {
    expect(mergeRelayBatchIntoTasks([], batch([["board1::t1", task("t1", 300)]]), clockOf({ t1: 200 }))).toHaveLength(1);
  });

  test("a local edit is protected while its publish is in flight (the ledger clock is ahead)", () => {
    const result = mergeRelayBatchIntoTasks(
      [task("t1", 200, { title: "Edited locally" })],
      batch([["board1::t1", task("t1", 200, { title: "Stale pre-edit copy" })]]),
      clockOf({ t1: 500 }),
    );
    expect(result[0].title).toBe("Edited locally");
  });

  test("tombstones loaded at startup block resurrection after a reload", () => {
    const ledger = new BoardSyncLedger({ load: () => JSON.stringify({ [TAG]: { gone: 800 } }), save: () => {} });
    expect(mergeRelayBatchIntoTasks([], batch([["board1::gone", task("gone", 300)]]), (id, version) => ledger.isTaskEventCurrent(TAG, id, version.createdAt, version.id))).toEqual([]);
  });

  test("undo after delete survives the old tombstone", () => {
    const result = mergeRelayBatchIntoTasks(
      [task("t1", 1200, { title: "Restored by undo" })],
      batch([["board1::t1", task("t1", 300, { title: "Stale" })]]),
      clockOf({ t1: 800 }),
    );
    expect(result[0].title).toBe("Restored by undo");
  });

  test("a newer deletion removes the task; an older one does not", () => {
    expect(mergeRelayBatchIntoTasks([task("t1", 500)], batch([["board1::t1", deletion(800)]]), noClock)).toEqual([]);
    expect(mergeRelayBatchIntoTasks([task("t1", 800)], batch([["board1::t1", deletion(500)]]), noClock)).toHaveLength(1);
  });

  test("relays merge as each finishes: relay A's EOSE does not include relay B's events", () => {
    const afterA = mergeRelayBatchIntoTasks(
      [task("shared", 100)],
      batch([["board1::shared", task("shared", 200, { title: "Updated by A" })], ["board1::only-a", task("only-a", 150)]]),
      noClock,
    );
    expect(afterA.map((t) => t.id).sort()).toEqual(["only-a", "shared"]);
    const afterB = mergeRelayBatchIntoTasks(afterA, batch([["board1::only-b", task("only-b", 300)]]), noClock);
    expect(afterB).toHaveLength(3);
  });

  test("the timeout fallback merges what stuck relays sent, newest per task", () => {
    const combined = mergeRelayBatches(
      new Map([
        ["wss://a", batch([["board1::t1", task("t1", 100)]])],
        ["wss://b", batch([["board1::t1", task("t1", 200, { title: "Newer from B" })], ["board1::t2", task("t2", 150)]])],
      ]),
      false,
    );
    const result = mergeRelayBatchIntoTasks([], combined, noClock);
    expect(result.find((t) => t.id === "t1")?.title).toBe("Newer from B");
    expect(result).toHaveLength(2);
  });

  test("a same-second version replaces the held one only when its id is lower (C7-3)", () => {
    const low = "0a".repeat(32);
    const high = "f0".repeat(32);
    const held = task("t1", 100, { title: "Held", _nostrId: low } as Partial<SyncedTask>);
    const higher = task("t1", 100, { title: "Higher id", _nostrId: high } as Partial<SyncedTask>);
    expect(mergeRelayBatchIntoTasks([held], batch([["board1::t1", higher]]), noClock)[0].title).toBe("Held");
    const heldHigh = task("t1", 100, { title: "Held", _nostrId: high } as Partial<SyncedTask>);
    const lower = task("t1", 100, { title: "Lower id", _nostrId: low } as Partial<SyncedTask>);
    expect(mergeRelayBatchIntoTasks([heldHigh], batch([["board1::t1", lower]]), noClock)[0].title).toBe("Lower id");
  });

  test("two relays' same-second versions: the lower id wins whichever relay sent it", () => {
    const low = "0a".repeat(32);
    const high = "f0".repeat(32);
    const relays = new Map([
      ["wss://a", batch([["board1::t1", task("t1", 100, { title: "Low", _nostrId: low } as Partial<SyncedTask>)]])],
      ["wss://b", batch([["board1::t1", task("t1", 100, { title: "High", _nostrId: high } as Partial<SyncedTask>)]])],
    ]);
    expect((mergeRelayBatches(relays, true).get("board1::t1") as SyncedTask).title).toBe("Low");
  });

  test("equal versions from two relays: the later relay wins only when asked to", () => {
    const relays = new Map([
      ["wss://a", batch([["board1::t1", task("t1", 100, { title: "A" })]])],
      ["wss://b", batch([["board1::t1", task("t1", 100, { title: "B" })]])],
    ]);
    expect((mergeRelayBatches(relays, false).get("board1::t1") as SyncedTask).title).toBe("A");
    expect((mergeRelayBatches(relays, true).get("board1::t1") as SyncedTask).title).toBe("B");
  });
});

describe("collecting a relay's events before EOSE", () => {
  test("re-syncing a Scripture Memory review from the relays keeps its passage link", () => {
    const review = task("r1", 300, {
      seriesId: "scripture-memory",
      scriptureMemoryId: "entry-1",
      scriptureMemoryStage: 1,
    } as Partial<SyncedTask>);
    const payload = JSON.parse(JSON.stringify(taskEventBody(review, { attachments: { images: null, documents: null } })));
    const relayBatch = new Map<string, RelayBatchEntry>();
    addToRelayBatch(relayBatch, "board1::r1", {
      deleted: false,
      at: 300,
      incoming: parseTaskEvent(payload, { taskId: "r1", column: "todo", createdAt: 300 }, BOARD, new Date()),
      eventPubkey: "b".repeat(64),
      incomingIsNewerOnTie: true,
      now: 300_000,
    });
    const [after] = mergeRelayBatchIntoTasks([review], relayBatch, noClock);
    expect(after).toMatchObject({ scriptureMemoryId: "entry-1", scriptureMemoryStage: 1 });
  });

  test("entries carry the event's version, so later merges can compare", () => {
    const relayBatch = new Map<string, RelayBatchEntry>();
    addToRelayBatch(relayBatch, "board1::t1", incoming("t1", 1_700_500_000, "From relay"));
    expect((relayBatch.get("board1::t1") as SyncedTask)._nostrAt).toBe(1_700_500_000);
  });

  test("a later deletion from the same relay replaces its create", () => {
    const relayBatch = new Map<string, RelayBatchEntry>();
    addToRelayBatch(relayBatch, "board1::t1", incoming("t1", 100, "Created"));
    addToRelayBatch(relayBatch, "board1::t1", { deleted: true, at: 200 });
    expect(mergeRelayBatchIntoTasks([], relayBatch, noClock)).toEqual([]);
  });
});

describe("live events after the first sync", () => {
  test("updates arriving together render once, last one winning", () => {
    vi.useFakeTimers();
    try {
      let state: SyncedTask[] = [task("t1", 100)];
      const commit = vi.fn((apply: (prev: SyncedTask[]) => SyncedTask[]) => { state = apply(state); });
      const batcher = new LiveUpdateBatcher<SyncedTask[]>(commit, 150);
      for (const title of ["Update 1", "Update 2", "Update 3"]) {
        batcher.enqueue(TAG, (prev) => prev.map((t) => ({ ...t, title })));
      }
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(160);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(state[0].title).toBe("Update 3");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a queued relay update is rechecked when applied: a local move made meanwhile wins", () => {
    const ledger = new BoardSyncLedger({ load: () => null, save: () => {} });
    ledger.acceptTaskEvent(TAG, "t1", 100);
    const update = incoming("t1", 100, "Stale relay copy", "todo");
    // The user moves the task before the queued update runs: the ledger reserves a newer version.
    ledger.reserveTaskPublish(TAG, "t1", 100, 150);
    const local = [task("t1", 100, { columnId: "doing", title: "Dropped locally" })];
    const result = applyIncomingTask(local, { boardId: "board1", taskId: "t1" }, update, () => ledger.isTaskEventCurrent(TAG, "t1", 100), () => 0);
    expect(result).toBe(local);
  });

  test("an event as new as a pending local edit does not override it", () => {
    const ledger = new BoardSyncLedger({ load: () => null, save: () => {} });
    const at = ledger.reserveTaskPublish(TAG, "t1", 200, 150); // clock moves past 200
    expect(at).toBe(201);
    const local = [task("t1", 201, { columnId: "doing" })];
    const result = applyIncomingTask(local, { boardId: "board1", taskId: "t1" }, incoming("t1", 201, "Echo", "todo"), () => ledger.isTaskEventCurrent(TAG, "t1", 201), () => 0);
    expect(result).toBe(local);
  });

  test("a current event updates the task, adds a new one at the given order, or removes a deleted one", () => {
    const current = () => true;
    const updated = applyIncomingTask([task("t1", 100)], { boardId: "board1", taskId: "t1" }, incoming("t1", 200, "Renamed"), current, () => 0);
    expect(updated[0].title).toBe("Renamed");
    const added = applyIncomingTask([], { boardId: "board1", taskId: "t2" }, incoming("t2", 200, "New"), current, () => 7);
    expect(added[0]).toMatchObject({ id: "t2", order: 7 });
    expect(applyIncomingTask([task("t1", 100)], { boardId: "board1", taskId: "t1" }, { deleted: true, at: 200 }, current, () => 0)).toEqual([]);
  });
});
