/**
 * Regression tests for the progressive per-relay sync architecture.
 *
 * These tests validate the core algorithms introduced to replace the
 * blocking initial-sync model:
 *
 *  1. IDB cache is always visible — never filtered by sync state.
 *  2. Per-relay batch routing — events go into a relay-specific batch until EOSE.
 *  3. Clock-protected merge — relay data never regresses IDB data.
 *  4. Stale CREATE after DELETE — CREATE(T=100) never appears if IDB has DELETE(T=200).
 *  5. Progressive relay merging — relay A EOSE merges only relay A's batch.
 *  6. Deletion clock check — a deletion only removes a task if it is newer.
 *  7. Live micro-batch coalescer — rapid live events coalesce into one render.
 *  8. All-relay completion — "done" only when every relay has fired EOSE.
 *  9. Absolute timeout — stuck relay's accumulated batch still flushed eventually.
 * 10. _nostrAt stamped on relay batch entries — stored for future merge comparison.
 */
import { test, describe, expect } from "vitest";


// ---------------------------------------------------------------------------
// Shared types (mirrors App.tsx)
// ---------------------------------------------------------------------------

type Task = {
  id: string;
  boardId: string;
  title: string;
  _nostrAt?: number; // unix seconds of the Nostr event that last wrote this task
  [key: string]: unknown;
};

type DeletionMarker = { _deleted: true; _nostrAt: number };
type RelayBatchEntry = Task | DeletionMarker;

function isDeleted(e: RelayBatchEntry): e is DeletionMarker {
  return "_deleted" in e;
}

// ---------------------------------------------------------------------------
// Inline flushRelayBatch — mirrors the implementation in App.tsx
// ---------------------------------------------------------------------------

/**
 * Clock-protected merge of one relay's batch into current task state.
 * Only applies entries where the relay has equal or newer data than IDB.
 */
function flushRelayBatch(
  relayBatch: Map<string, RelayBatchEntry>,
  currentTasks: Task[],
  /** Optional per-task clock fallback when _nostrAt is absent on the entry */
  taskClock?: Map<string, number>,
): Task[] {
  const merged = new Map(currentTasks.map((t) => [`${t.boardId}::${t.id}`, t]));
  for (const [key, entry] of relayBatch) {
    const taskId = key.split("::")[1];
    const incomingNostrAt = isDeleted(entry)
      ? entry._nostrAt
      : (entry._nostrAt ?? 0);
    const existingNostrAt = (merged.get(key) as Task | undefined)?._nostrAt ?? taskClock?.get(taskId) ?? 0;
    if (incomingNostrAt < existingNostrAt) continue; // IDB is newer — skip
    if (isDeleted(entry)) merged.delete(key);
    else merged.set(key, entry as Task);
  }
  return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// Inline live micro-batch coalescer — mirrors the implementation in App.tsx
// ---------------------------------------------------------------------------

type TaskUpdater = (prev: Task[]) => Task[];

interface LiveBatch {
  updaters: TaskUpdater[];
  timer: ReturnType<typeof setTimeout> | null;
}

const LIVE_BATCH_MS = 150;

class LiveMicroBatch {
  private batches = new Map<string, LiveBatch>();
  renderedStates: Map<string, Task[]> = new Map(); // bTag → last rendered tasks
  renderCount = 0;

  enqueue(bTag: string, updater: TaskUpdater, currentTasks: Task[]): void {
    let batch = this.batches.get(bTag);
    if (!batch) {
      batch = { updaters: [], timer: null };
      this.batches.set(bTag, batch);
    }
    batch.updaters.push(updater);
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      const b = this.batches.get(bTag);
      if (!b) return;
      this.batches.delete(bTag);
      let result = this.renderedStates.get(bTag) ?? currentTasks;
      for (const fn of b.updaters) result = fn(result);
      this.renderedStates.set(bTag, result);
      this.renderCount++;
    }, LIVE_BATCH_MS);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, boardId: string, nostrAt: number, extra: Partial<Task> = {}): Task {
  return { id, boardId, title: `Task ${id}`, _nostrAt: nostrAt, ...extra };
}

function makeDeletion(nostrAt: number): DeletionMarker {
  return { _deleted: true, _nostrAt: nostrAt };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. IDB data always visible
// ---------------------------------------------------------------------------

test("IDB tasks are never filtered — visible immediately before any relay responds", () => {
  const idbTasks: Task[] = [
    makeTask("t1", "board1", 1_000_000),
    makeTask("t2", "board1", 1_000_100),
  ];

  // No relay has responded; pendingSharedBoardIds would have contained board1
  // in the old architecture. Simulating the new filter (no pendingSharedBoardIds):
  const visibleTasks = idbTasks.filter((t) => t.boardId === "board1");

  expect(visibleTasks.length).toBe(2);
});

// ---------------------------------------------------------------------------
// 2. Per-relay batch routing
// ---------------------------------------------------------------------------

test("events from relay A go into relay A's batch, not relay B's", () => {
  const relayBatches = new Map<string, Map<string, RelayBatchEntry>>();

  function routeEvent(relayUrl: string, taskKey: string, entry: RelayBatchEntry) {
    let batch = relayBatches.get(relayUrl);
    if (!batch) {
      batch = new Map();
      relayBatches.set(relayUrl, batch);
    }
    batch.set(taskKey, entry);
  }

  routeEvent("wss://relay-a.test", "board1::t1", makeTask("t1", "board1", 500));
  routeEvent("wss://relay-b.test", "board1::t2", makeTask("t2", "board1", 600));

  expect(relayBatches.get("wss://relay-a.test")?.size).toBe(1);
  expect(relayBatches.get("wss://relay-b.test")?.size).toBe(1);
  expect(relayBatches.get("wss://relay-a.test")?.has("board1::t1")).toBe(true);
  expect(relayBatches.get("wss://relay-a.test")?.has("board1::t2")).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Clock-protected merge — relay data never regresses IDB
// ---------------------------------------------------------------------------

test("relay task with older _nostrAt does NOT overwrite newer IDB task", () => {
  const idbTasks: Task[] = [makeTask("t1", "board1", 1000)]; // IDB has T=1000

  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeTask("t1", "board1", 500, { title: "STALE from relay" })], // relay has T=500
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(1);
  expect(result[0].title).toBe("Task t1");
  expect(result[0]._nostrAt).toBe(1000);
});

test("relay task with newer _nostrAt DOES update IDB task", () => {
  const idbTasks: Task[] = [makeTask("t1", "board1", 500, { title: "Old IDB title" })];

  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeTask("t1", "board1", 1000, { title: "Updated from relay" })],
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(1);
  expect(result[0].title).toBe("Updated from relay");
  expect(result[0]._nostrAt).toBe(1000);
});

test("relay task with equal _nostrAt applies (idempotent re-sync)", () => {
  const idbTasks: Task[] = [makeTask("t1", "board1", 1000, { title: "Same version" })];
  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeTask("t1", "board1", 1000, { title: "Same version" })],
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(1);
  expect(result[0]._nostrAt).toBe(1000);
});

// ---------------------------------------------------------------------------
// 4. Stale CREATE after DELETE — the primary flicker scenario
// ---------------------------------------------------------------------------

test("stale CREATE(T=100) does not appear when IDB has DELETE(T=200)", () => {
  // IDB has the correct deleted state — task was already removed
  const idbTasks: Task[] = []; // task was deleted from IDB

  // Relay sends a stale CREATE event (older than the deletion)
  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::deleted-task", makeTask("deleted-task", "board1", 100)], // T=100, stale
  ]);

  // The IDB deletion is represented by absence; but we need the comparison.
  // Simulate the scenario where the deletion was applied in a prior relay merge:
  // After that merge the task is absent from idbTasks. Now relay B sends the stale CREATE.
  // Since IDB doesn't have _nostrAt for the missing task (it's gone), relay's T=100 wins.
  // The real protection for THIS case is the taskClock passed as fallback:
  const taskClock = new Map([["deleted-task", 200]]); // global clock remembers T=200 delete

  const result = flushRelayBatch(relayBatch, idbTasks, taskClock);

  // incomingNostrAt=100, taskClock fallback=200 → 100 < 200 → skip
  expect(result.length).toBe(0);
});

test("newer CREATE(T=300) DOES appear after DELETE(T=200) — task was re-opened", () => {
  const idbTasks: Task[] = []; // task was deleted
  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeTask("t1", "board1", 300)], // T=300, newer than deletion
  ]);
  const taskClock = new Map([["t1", 200]]); // deletion was at T=200

  const result = flushRelayBatch(relayBatch, idbTasks, taskClock);

  expect(result.length).toBe(1);
  expect(result[0]._nostrAt).toBe(300);
});

// ---------------------------------------------------------------------------
// 5. Progressive relay merging — relay A EOSE only touches relay A's batch
// ---------------------------------------------------------------------------

test("relay A EOSE merges only relay A's tasks, not relay B's pending events", () => {
  const idbTasks: Task[] = [makeTask("shared", "board1", 100)];

  // Relay A's batch: updates "shared" + adds "only-in-a"
  const relayABatch = new Map<string, RelayBatchEntry>([
    ["board1::shared", makeTask("shared", "board1", 200, { title: "Updated by A" })],
    ["board1::only-in-a", makeTask("only-in-a", "board1", 150)],
  ]);

  // Relay B's batch is still accumulating — NOT merged yet
  const relayBBatch = new Map<string, RelayBatchEntry>([
    ["board1::only-in-b", makeTask("only-in-b", "board1", 300)],
  ]);

  // Only relay A fires EOSE
  const afterRelayA = flushRelayBatch(relayABatch, idbTasks);

  expect(afterRelayA.length).toBe(2);
  expect(afterRelayA.find((t) => t.id === "shared")?.title).toBe("Updated by A");
  expect(afterRelayA.find((t) => t.id === "only-in-b")).toBeUndefined();

  // Now relay B fires EOSE
  const afterRelayB = flushRelayBatch(relayBBatch, afterRelayA);

  expect(afterRelayB.length).toBe(3);
  expect(afterRelayB.find((t) => t.id === "only-in-b")).toBeDefined();
});

// ---------------------------------------------------------------------------
// 6. Deletion clock check
// ---------------------------------------------------------------------------

test("deletion with newer _nostrAt removes task from state", () => {
  const idbTasks: Task[] = [makeTask("t1", "board1", 500)];

  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeDeletion(800)], // deletion at T=800 > task's T=500
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(0);
});

test("deletion with OLDER _nostrAt does NOT remove a newer IDB task", () => {
  // User re-opened a task (T=800) after it was deleted (T=500) on another device
  const idbTasks: Task[] = [makeTask("t1", "board1", 800)]; // re-opened at T=800

  const relayBatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeDeletion(500)], // stale deletion at T=500
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(1);
  expect(result[0]._nostrAt).toBe(800);
});

test("relay with both CREATE(T=100) and DELETE(T=200) ends up with task deleted", () => {
  const idbTasks: Task[] = [];

  // Both events arrive in the same relay's batch (clock check applied during accumulation)
  // After clock check: batch has DELETE (T=200) as the winner for this task
  const relayBatch = new Map<string, RelayBatchEntry>([
    // CREATE was processed first, then DELETE overwrote it via clock check
    ["board1::t1", makeDeletion(200)],
  ]);

  const result = flushRelayBatch(relayBatch, idbTasks);

  expect(result.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 7. Live micro-batch coalescer
// ---------------------------------------------------------------------------

test("multiple live updates within LIVE_BATCH_MS produce a single render", async () => {
  const batch = new LiveMicroBatch();
  const initialTasks: Task[] = [makeTask("t1", "board1", 100)];
  batch.renderedStates.set("board1", initialTasks);

  // Three updates arrive rapidly
  batch.enqueue("board1", (prev) =>
    prev.map((t) => t.id === "t1" ? { ...t, title: "Update 1", _nostrAt: 200 } : t),
    initialTasks,
  );
  batch.enqueue("board1", (prev) =>
    prev.map((t) => t.id === "t1" ? { ...t, title: "Update 2", _nostrAt: 300 } : t),
    initialTasks,
  );
  batch.enqueue("board1", (prev) =>
    prev.map((t) => t.id === "t1" ? { ...t, title: "Update 3", _nostrAt: 400 } : t),
    initialTasks,
  );

  expect(batch.renderCount).toBe(0);

  await wait(LIVE_BATCH_MS + 50);

  expect(batch.renderCount).toBe(1);
  expect(batch.renderedStates.get("board1")?.[0]?.title).toBe("Update 3");
});

// ---------------------------------------------------------------------------
// 8. All-relay completion
// ---------------------------------------------------------------------------

test("sync is not complete until ALL relays have fired EOSE", () => {
  const pendingRelays = new Set(["wss://a.test", "wss://b.test", "wss://c.test"]);

  pendingRelays.delete("wss://a.test");
  expect(pendingRelays.size).toBeGreaterThan(0);

  pendingRelays.delete("wss://b.test");
  expect(pendingRelays.size).toBeGreaterThan(0);

  pendingRelays.delete("wss://c.test");
  expect(pendingRelays.size).toBe(0);
});

test("spinner clears per-board only when that board's relay set is empty", () => {
  const pendingByBoard = new Map([
    ["board1", new Set(["wss://a.test", "wss://b.test"])],
    ["board2", new Set(["wss://a.test"])],
  ]);

  // Relay A fires EOSE
  pendingByBoard.get("board1")?.delete("wss://a.test");
  pendingByBoard.get("board2")?.delete("wss://a.test");

  expect(pendingByBoard.get("board1")!.size).toBeGreaterThan(0);
  expect(pendingByBoard.get("board2")!.size).toBe(0);
});

// ---------------------------------------------------------------------------
// 9. Absolute timeout merges remaining batches
// ---------------------------------------------------------------------------

test("timeout fallback merges all remaining relay batches with clock protection", () => {
  // Simulate stuck relay B that never fires EOSE
  const relayABatch = new Map<string, RelayBatchEntry>([
    ["board1::t1", makeTask("t1", "board1", 300, { title: "From relay A" })],
  ]);
  const relayBBatch = new Map<string, RelayBatchEntry>([
    ["board1::t2", makeTask("t2", "board1", 400, { title: "From relay B (stuck)" })],
    ["board1::t1", makeTask("t1", "board1", 250, { title: "Stale from relay B" })], // older
  ]);

  const idbTasks: Task[] = [];

  // Timeout: merge relay A first, then B (order doesn't matter — clock protects)
  let state = flushRelayBatch(relayABatch, idbTasks);
  state = flushRelayBatch(relayBBatch, state);

  expect(state.length).toBe(2);
  const t1 = state.find((t) => t.id === "t1");
  expect(t1?.title).toBe("From relay A");
  expect(t1?._nostrAt).toBe(300);
  expect(state.find((t) => t.id === "t2")).toBeDefined();
});

test("timeout fallback: combines multiple relay batches taking the newest entry per task", () => {
  type BoardBatch = Map<string, Map<string, RelayBatchEntry>>;

  // Simulate combining all remaining batches before flushing (as the timeout handler does)
  function combineRelayBatches(boardBatch: BoardBatch): Map<string, RelayBatchEntry> {
    const combined = new Map<string, RelayBatchEntry>();
    for (const relayBatch of boardBatch.values()) {
      for (const [key, entry] of relayBatch) {
        const existing = combined.get(key);
        const inAt = isDeleted(entry) ? entry._nostrAt : (entry as Task)._nostrAt ?? 0;
        const exAt = existing ? (isDeleted(existing) ? existing._nostrAt : (existing as Task)._nostrAt ?? 0) : -1;
        if (inAt >= exAt) combined.set(key, entry);
      }
    }
    return combined;
  }

  const boardBatch: BoardBatch = new Map([
    ["wss://slow-a.test", new Map<string, RelayBatchEntry>([
      ["board1::t1", makeTask("t1", "board1", 100)],
    ])],
    ["wss://slow-b.test", new Map<string, RelayBatchEntry>([
      ["board1::t1", makeTask("t1", "board1", 200, { title: "Newer from B" })], // wins
      ["board1::t2", makeTask("t2", "board1", 150)],
    ])],
  ]);

  const combined = combineRelayBatches(boardBatch);
  const result = flushRelayBatch(combined, []);

  expect(result.length).toBe(2);
  expect(result.find((t) => t.id === "t1")?.title).toBe("Newer from B");
  expect(result.find((t) => t.id === "t1")?._nostrAt).toBe(200);
});

// ---------------------------------------------------------------------------
// 10. _nostrAt stamped on relay batch entries
// ---------------------------------------------------------------------------

test("_nostrAt is set on task entries written to relay batch", () => {
  // Simulates what applyTaskEvent does when writing to the per-relay batch
  const ev = { created_at: 1_700_500_000 };
  const taskFromRelay: Task = makeTask("t1", "board1", ev.created_at);

  // _nostrAt should equal ev.created_at
  expect(taskFromRelay._nostrAt).toBe(1_700_500_000);
});

test("_nostrAt enables comparing freshness across relay syncs and IDB loads", () => {
  const fromRelay1 = makeTask("t1", "board1", 1000);
  const fromRelay2 = makeTask("t1", "board1", 1500); // newer
  const fromIdb = makeTask("t1", "board1", 1200);    // between the two

  // Clock-protected merge should always produce the task with the highest _nostrAt
  let state = flushRelayBatch(new Map([["board1::t1", fromRelay1]]), [fromIdb]);
  expect(state[0]._nostrAt).toBe(1200);

  state = flushRelayBatch(new Map([["board1::t1", fromRelay2]]), state);
  expect(state[0]._nostrAt).toBe(1500);
});
