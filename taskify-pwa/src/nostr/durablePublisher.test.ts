import { describe, expect, test, vi } from "vitest";
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";
import { DurablePublisher, type DurablePublisherDeps, type PublishTarget } from "./durablePublisher";

const shared = { id: "b1", name: "Team", kind: "lists", columns: [], nostr: { boardId: "nb1", relays: ["wss://r"] } } as unknown as Board;

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return { load: () => value, save: (next: string) => { value = next; }, peek: () => value };
}

function setup(options: { failures?: number; storage?: ReturnType<typeof memoryStorage>; tasks?: Task[]; online?: boolean } = {}) {
  let failuresLeft = options.failures ?? 0;
  const calls: Array<{ method: string; id: string; title?: string; boardId?: string }> = [];
  const attempt = (method: string) => async (item: Task | CalendarEvent, board?: Board) => {
    calls.push({ method, id: item.id, title: item.title, boardId: board?.id });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("Failed to fetch");
    }
  };
  const target: PublishTarget = {
    publishTask: attempt("task"),
    publishTaskDeleted: attempt("taskDelete"),
    publishCalendarEvent: attempt("event"),
    publishCalendarEventDeleted: attempt("eventDelete"),
  };
  let tasks = options.tasks ?? [];
  const timers: Array<{ at: number; run: () => void }> = [];
  let now = 1_000_000;
  const pending = new Set<string>();
  const storage = options.storage ?? memoryStorage();
  const deps: DurablePublisherDeps = {
    target,
    storage,
    boards: () => [shared],
    task: (id) => tasks.find((task) => task.id === id),
    event: () => undefined,
    now: () => now,
    setTimer: (run, delayMs) => {
      timers.push({ at: now + delayMs, run });
      return timers.length;
    },
    clearTimer: () => {},
    onPending: (kind, id, isPending) => {
      if (isPending) pending.add(`${kind}:${id}`);
      else pending.delete(`${kind}:${id}`);
    },
    log: vi.fn(),
  };
  const durable = new DurablePublisher(deps);
  return {
    durable,
    calls,
    pending,
    storage,
    setTasks: (next: Task[]) => { tasks = next; },
    /** Moves the clock and runs due timers. */
    advance: async (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers.splice(0, timers.length, ...timers.filter((t) => t.at > now));
      for (const timer of due) timer.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const task = (fields: Partial<Task> = {}) => ({ id: "t1", boardId: "b1", title: "Ship", ...fields }) as Task;

describe("DurablePublisher", () => {
  test("an edit whose publish fails before it is sent is retried until it goes out", async () => {
    const run = setup({ failures: 1, tasks: [task({ title: "Edited offline" })] });
    await run.durable.publishTask(task({ title: "Edited offline" }));
    expect(run.calls).toHaveLength(1);
    expect(run.pending.has("task:t1")).toBe(true); // not shown as synced

    await run.durable.retryNow(); // e.g. the connection came back
    expect(run.calls.map((c) => c.method)).toEqual(["task", "task"]);
    expect(run.pending.has("task:t1")).toBe(false);
    expect(run.durable.intentCount()).toBe(0);
  });

  test("a retry publishes the task as it is now, not as it was", async () => {
    const run = setup({ failures: 1, tasks: [task({ title: "First" })] });
    await run.durable.publishTask(task({ title: "First" }));
    run.setTasks([task({ title: "Second" })]);
    await run.durable.retryNow();
    expect(run.calls[run.calls.length - 1]?.title).toBe("Second");
  });

  test("intents survive a reload and are sent on start", async () => {
    const storage = memoryStorage();
    const first = setup({ failures: 1, storage, tasks: [task()] });
    await first.durable.publishTask(task());
    expect(storage.peek()).toContain("t1");

    const second = setup({ storage, tasks: [task()] });
    expect(second.pending.size).toBe(0);
    await second.durable.start();
    expect(second.calls.map((c) => c.method)).toEqual(["task"]);
    expect(second.durable.intentCount()).toBe(0);
  });

  test("failures back off and retry on their own", async () => {
    const run = setup({ failures: 2, tasks: [task()] });
    await run.durable.publishTask(task());
    await run.advance(4_000);
    expect(run.calls).toHaveLength(1);
    await run.advance(2_000); // first retry after 5 s
    expect(run.calls).toHaveLength(2);
    await run.advance(15_000); // then later
    expect(run.calls).toHaveLength(3);
    expect(run.durable.intentCount()).toBe(0);
  });

  test("deleting a task replaces its pending edit; the deletion is retried from a snapshot", async () => {
    const run = setup({ failures: 2, tasks: [task()] });
    await run.durable.publishTask(task());
    run.setTasks([]);
    await run.durable.publishTaskDeleted(task({ images: ["data:image/png;base64,AAAA"] }));
    await run.durable.retryNow();
    expect(run.calls.map((c) => c.method)).toEqual(["task", "taskDelete", "taskDelete"]);
    expect(run.durable.intentCount()).toBe(0);
    expect(run.storage.peek()).not.toContain("base64");
  });

  test("a pending edit for a task removed locally is dropped", async () => {
    const run = setup({ failures: 1, tasks: [task()] });
    await run.durable.publishTask(task());
    run.setTasks([]);
    await run.durable.retryNow();
    expect(run.calls).toHaveLength(1);
    expect(run.durable.intentCount()).toBe(0);
  });

  test("a board that is not stored (a share template) is published directly and reports failure", async () => {
    const run = setup({ failures: 1, tasks: [task()] });
    const template = { ...shared, id: "template" } as Board;
    await expect(run.durable.publishTask(task(), template)).rejects.toThrow("Failed to fetch");
    expect(run.durable.intentCount()).toBe(0);
  });

  test("publishing never rejects for stored items: the change is kept for retry", async () => {
    const run = setup({ failures: 1, tasks: [task()] });
    await expect(run.durable.publishTask(task())).resolves.toBeUndefined();
  });
});
