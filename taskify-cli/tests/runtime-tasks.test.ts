import test from "node:test";
import assert from "node:assert/strict";
import { boardEvents, boardTagHash, deriveBoardKeyPair, runtimeHarness, START, tag, taskPayload, userPubkey } from "./helpers/runtimeHarness.ts";

/**
 * C12-4: the runtime's task behaviour, through a real session on a loopback relay. These pin the
 * signed events and returned records so moving the code by domain can't change them.
 */

const BOARD = "board-lists-1";
const seconds = (ms: number) => Math.floor(ms / 1000);

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
