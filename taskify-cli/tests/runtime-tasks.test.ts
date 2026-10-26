import test from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey } from "nostr-tools";
import { boardEvents, boardTagHash, deriveBoardKeyPair, runtimeHarness, START, tag, taskEvent, taskPayload, userPubkey } from "./helpers/runtimeHarness.ts";

/**
 * C12-4: the runtime's task behaviour, through a real session on a loopback relay. These pin the
 * signed events and returned records so moving the code by domain can't change them.
 */

const BOARD = "board-lists-1";
const seconds = (ms: number) => Math.floor(ms / 1000);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("creating a task publishes one board-signed event with its tags and encrypted payload", async () => {
  const h = await runtimeHarness();
  try {
    const created = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk", note: "2%", priority: 2, dueISO: "2026-10-26" });
    assert.equal(created.id, "00000000-0000-4000-8000-000000000001");
    assert.equal(created.column, "todo", "a list board's first list when none is given");
    assert.equal(created.createdBy, userPubkey);
    assert.equal(created.createdAt, seconds(START));

    const events = boardEvents(h.relay, BOARD, 30301);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.pubkey, deriveBoardKeyPair(BOARD).pk);
    assert.equal(event.created_at, seconds(START));
    assert.deepEqual(event.tags, [["d", created.id], ["b", boardTagHash(BOARD)], ["col", "todo"], ["status", "open"]]);
    assert.equal(event.id, created.nostrEventId);
    const payload = await taskPayload(event, BOARD);
    assert.equal(payload.title, "Milk");
    assert.equal(payload.note, "2%");
    assert.equal(payload.priority, 2);
    assert.equal(payload.dueISO, "2026-10-26");
    assert.equal(payload.dueDateEnabled, true);
    assert.equal(payload.createdBy, userPubkey);
    assert.equal(payload.createdAt, START);

    const listed = await h.runtime.createTaskFull({ boardId: BOARD, title: "Eggs", columnId: "later" });
    assert.equal(tag(boardEvents(h.relay, BOARD, 30301).find((e) => tag(e, "d") === listed.id)!, "col"), "later");
  } finally {
    await h.close();
  }
});

test("listing reads tasks back, filters by status and list, and caches what it read", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    const eggs = await h.runtime.createTaskFull({ boardId: BOARD, title: "Eggs", columnId: "later" });
    h.advance(60_000);
    await h.runtime.setTaskStatus(eggs.id, "done", BOARD);

    const open = await h.runtime.listTasks({ boardId: BOARD, status: "open" });
    assert.deepEqual(open.map((task) => task.title), ["Milk"]);
    const done = await h.runtime.listTasks({ boardId: BOARD, status: "done" });
    assert.deepEqual(done.map((task) => task.title), ["Eggs"]);
    const later = await h.runtime.listTasks({ boardId: BOARD, status: "any", columnId: "later" });
    assert.deepEqual(later.map((task) => task.id), [eggs.id]);

    const cached = h.cache().boards[BOARD];
    assert.deepEqual(cached.tasks.map((task) => task.id).sort(), [milk.id, eggs.id].sort());
    assert.equal(cached.lastSyncAt, seconds(START + 60_000));

    await assert.rejects(h.runtime.listTasks({ boardId: "Nowhere", status: "open" }), /Board not found in config/);
  } finally {
    await h.close();
  }
});

test("a compound board lists its children's tasks", async () => {
  const h = await runtimeHarness();
  try {
    await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    await h.runtime.createTaskFull({ boardId: "board-week-1", title: "Gym", dueISO: "2026-10-26" });
    const all = await h.runtime.listTasks({ boardId: "board-compound-1", status: "open" });
    assert.deepEqual(all.map((task) => task.title).sort(), ["Gym", "Milk"]);
    assert.deepEqual(all.map((task) => task.sourceBoardId).sort(), [BOARD, "board-week-1"].sort());
  } finally {
    await h.close();
  }
});

test("an update republishes the same task later, keeping what it didn't change", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk", note: "2%", priority: 2 });
    h.advance(60_000);
    const updated = await h.runtime.updateTask(milk.id, BOARD, { title: "Oat milk" });
    assert.equal(updated?.title, "Oat milk");
    assert.equal(updated?.note, "2%");
    const [event] = boardEvents(h.relay, BOARD, 30301);
    assert.equal(tag(event, "d"), milk.id);
    assert.equal(event.created_at, seconds(START + 60_000));
    const payload = await taskPayload(event, BOARD);
    assert.equal(payload.title, "Oat milk");
    assert.equal(payload.priority, 2);
    assert.equal(payload.lastEditedBy, userPubkey);
  } finally {
    await h.close();
  }
});

test("an edit in the same second as the last still publishes a later version", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    await h.runtime.updateTask(milk.id, BOARD, { title: "Oat milk" });
    const [event] = boardEvents(h.relay, BOARD, 30301);
    assert.equal(event.created_at, seconds(START) + 1);
    assert.equal((await taskPayload(event, BOARD)).title, "Oat milk");
  } finally {
    await h.close();
  }
});

test("completing a recurring task publishes its next occurrence once", async () => {
  const h = await runtimeHarness();
  try {
    const standup = await h.runtime.createTaskFull({ boardId: BOARD, title: "Standup", dueISO: "2026-10-25T14:00:00.000Z", recurrence: { type: "daily" } });
    h.advance(60_000);
    const done = await h.runtime.setTaskStatus(standup.id, "done", BOARD);
    const nextId = `recurrence:${standup.id}:2026-10-26`;
    assert.equal(done?.completed, true);
    assert.equal(done?.completedAt, new Date(START + 60_000).toISOString());
    assert.equal(done?.nextOccurrence?.id, nextId);

    const events = boardEvents(h.relay, BOARD, 30301);
    const completed = events.find((e) => tag(e, "d") === standup.id)!;
    const next = events.find((e) => tag(e, "d") === nextId)!;
    assert.equal(tag(completed, "status"), "done");
    assert.equal(tag(next, "status"), "open");
    assert.equal((await taskPayload(next, BOARD)).title, "Standup");

    // Reopening and completing again doesn't make a second copy.
    h.advance(60_000);
    await h.runtime.setTaskStatus(standup.id, "open", BOARD);
    h.advance(60_000);
    await h.runtime.setTaskStatus(standup.id, "done", BOARD);
    assert.equal(boardEvents(h.relay, BOARD, 30301).filter((e) => tag(e, "d") === nextId).length, 1);
  } finally {
    await h.close();
  }
});

test("deleting publishes a deleted version that listing leaves out", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    h.advance(60_000);
    const deleted = await h.runtime.deleteTask(milk.id, BOARD);
    assert.equal(deleted?.id, milk.id);
    const [event] = boardEvents(h.relay, BOARD, 30301);
    assert.equal(tag(event, "status"), "deleted");
    assert.deepEqual(await h.runtime.listTasks({ boardId: BOARD, status: "any", refresh: true }), []);
  } finally {
    await h.close();
  }
});

test("tasks are found by id prefix, and subtasks and assignment responses are saved", async () => {
  const h = await runtimeHarness();
  try {
    const assignee = "ab".repeat(32);
    const trip = await h.runtime.createTaskFull({
      boardId: BOARD, title: "Trip",
      subtasks: [{ id: "s1", title: "Book", completed: false }],
      assignees: [{ pubkey: assignee }],
    });
    const found = await h.runtime.getTask(trip.id.slice(0, 8), BOARD);
    assert.equal(found?.id, trip.id);

    h.advance(60_000);
    const toggled = await h.runtime.toggleSubtask(trip.id, BOARD, "1", true);
    assert.equal(toggled?.subtasks?.[0].completed, true);

    h.advance(60_000);
    const responded = await h.runtime.applyTaskAssignmentResponse(trip.id, assignee, "accepted", "2026-10-25T13:00:00.000Z");
    assert.equal(responded?.assignees?.find((a) => a.pubkey === assignee)?.status, "accepted");
    const payload = await taskPayload(boardEvents(h.relay, BOARD, 30301)[0], BOARD);
    assert.equal((payload.assignees as Array<{ pubkey: string; status?: string }>)[0].status, "accepted");
  } finally {
    await h.close();
  }
});

test("clearing completed tasks deletes each of them", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    const eggs = await h.runtime.createTaskFull({ boardId: BOARD, title: "Eggs" });
    h.advance(60_000);
    await h.runtime.setTaskStatus(eggs.id, "done", BOARD);
    h.advance(60_000);
    assert.equal(await h.runtime.clearCompleted(BOARD), 1);
    const statuses = Object.fromEntries(boardEvents(h.relay, BOARD, 30301).map((e) => [tag(e, "d"), tag(e, "status")]));
    assert.deepEqual(statuses, { [milk.id]: "open", [eggs.id]: "deleted" });
  } finally {
    await h.close();
  }
});

test("a board is found by name, and a week board's task goes in its day column", async () => {
  const h = await runtimeHarness();
  try {
    const gym = await h.runtime.createTaskFull({ boardId: "Week", title: "Gym" });
    assert.equal(gym.boardId, "board-week-1");
    assert.equal(gym.boardName, "Week");
    assert.equal(gym.column, "day");
    assert.equal(tag(boardEvents(h.relay, "board-week-1", 30301)[0], "col"), "day");
    assert.deepEqual((await h.runtime.listTasks({ boardId: "Week", status: "open" })).map((task) => task.id), [gym.id]);
  } finally {
    await h.close();
  }
});

test("task events not signed with the board's key are ignored", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    const intruder = generateSecretKey();
    h.relay.events.push(
      await taskEvent(BOARD, { id: "forged-1", status: "open", column: "todo", payload: { title: "Pay me" }, createdAt: seconds(START), secretKey: intruder }),
      await taskEvent(BOARD, { id: milk.id, status: "open", column: "todo", payload: { title: "Hijacked" }, createdAt: seconds(START) + 600, secretKey: intruder }),
    );
    const listed = await h.runtime.listTasks({ boardId: BOARD, status: "any", refresh: true });
    assert.deepEqual(listed.map((task) => task.title), ["Milk"]);
    assert.equal(await h.runtime.getTask("forged-1", BOARD), null);
    assert.equal((await h.runtime.getTask(milk.id, BOARD))?.title, "Milk");
  } finally {
    await h.close();
  }
});

test("the task cache keeps every field and deleted tasks, so a read from it matches the relay's", async () => {
  const h = await runtimeHarness();
  try {
    const assignee = "ab".repeat(32);
    const payload = {
      title: "Run", note: "5k", priority: 3, order: 2,
      dueISO: "2026-10-26T07:00:00.000Z", dueDateEnabled: true, dueTimeEnabled: true, dueTimeZone: "Europe/London",
      hiddenUntilISO: "2026-10-25T00:00:00.000Z", completedAt: "2026-10-25T11:00:00.000Z", completedBy: assignee,
      createdBy: userPubkey, lastEditedBy: assignee, createdAt: START - 86_400_000,
      recurrence: { type: "daily" }, streak: 4, longestStreak: 9, seriesId: "series-1",
      images: ["https://example.test/a.png"], documents: [{ id: "doc-1", name: "plan.pdf" }], bounty: { amount: 21 },
      subtasks: [{ id: "s1", title: "Stretch", completed: true }],
      assignees: [{ pubkey: assignee, status: "accepted", respondedAt: 1_761_390_000 }], inboxItem: true,
    };
    h.relay.events.push(
      await taskEvent(BOARD, { id: "task-run", status: "done", column: "later", payload, createdAt: seconds(START) - 120 }),
      await taskEvent(BOARD, { id: "task-gone", status: "deleted", column: "todo", payload: { title: "Gone" }, createdAt: seconds(START) - 60 }),
    );

    const fromRelay = await h.runtime.listTasks({ boardId: BOARD, status: "any" });
    assert.deepEqual(fromRelay.map((task) => task.id), ["task-run"]);
    const [run] = fromRelay;
    assert.equal(run.completed, true);
    assert.equal(run.column, "later");
    assert.equal(run.createdAt, seconds(START) - 120, "the relay's time, not the payload's");
    assert.equal(run.streak, 4);
    assert.equal(run.seriesId, "series-1");
    assert.equal(run.dueTimeZone, "Europe/London");
    assert.deepEqual(run.images, payload.images);
    assert.equal(h.cache().boards[BOARD].tasks.find((task) => task.id === "task-gone")?.status, "deleted");

    // The relay has lost everything: the next read is the cache's alone.
    h.relay.events.length = 0;
    const fromCache = await h.runtime.listTasks({ boardId: BOARD, status: "any" });
    assert.deepEqual(plain(fromCache), plain(fromRelay));
  } finally {
    await h.close();
  }
});

test("another device's later version replaces the cached one by relay time, and its deletion hides it", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk" });
    await h.runtime.listTasks({ boardId: BOARD, status: "open" });

    // The edit keeps the task's original creation time in its payload, a day before this one's.
    h.advance(60_000);
    h.relay.events.push(await taskEvent(BOARD, {
      id: milk.id, status: "open", column: "todo",
      payload: { title: "Oat milk", createdAt: START - 86_400_000 }, createdAt: seconds(START + 60_000),
    }));
    assert.deepEqual((await h.runtime.listTasks({ boardId: BOARD, status: "open" })).map((task) => task.title), ["Oat milk"]);

    h.advance(60_000);
    h.relay.events.push(await taskEvent(BOARD, {
      id: milk.id, status: "deleted", column: "todo", payload: { title: "Oat milk" }, createdAt: seconds(START + 120_000),
    }));
    assert.deepEqual(await h.runtime.listTasks({ boardId: BOARD, status: "any" }), []);
  } finally {
    await h.close();
  }
});

test("changes build on the newest version when a relay still serves an older one", async () => {
  const h = await runtimeHarness();
  try {
    const milk = await h.runtime.createTaskFull({ boardId: BOARD, title: "Milk", note: "2%" });
    const [first] = boardEvents(h.relay, BOARD, 30301);
    h.advance(60_000);
    await h.runtime.updateTask(milk.id, BOARD, { title: "Oat milk" });
    h.relay.events.push(first);

    assert.equal((await h.runtime.getTask(milk.id, BOARD))?.title, "Oat milk");
    h.advance(60_000);
    const done = await h.runtime.setTaskStatus(milk.id, "done", BOARD);
    assert.equal(done?.title, "Oat milk");
    const newest = boardEvents(h.relay, BOARD, 30301)[0];
    assert.equal(tag(newest, "status"), "done");
    assert.equal((await taskPayload(newest, BOARD)).title, "Oat milk");
    assert.equal((await taskPayload(newest, BOARD)).note, "2%");
  } finally {
    await h.close();
  }
});
