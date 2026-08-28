import test from "node:test";
import assert from "node:assert/strict";
import { resolveBoardForCommand, requireResolvedTask, requireResolvedEvent } from "../src/shared/commandResolution.ts";

test("resolveBoardForCommand returns exitCode=1 on unresolved board", () => {
  const result = resolveBoardForCommand([{ id: "board-1", name: "Primary", relays: [] } as any], "missing");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /Board not found/);
  }
});

test("resolveBoardForCommand auto-selects single board", () => {
  const result = resolveBoardForCommand([{ id: "board-1", name: "Primary", relays: [] } as any]);
  assert.deepEqual(result, { ok: true, boardId: "board-1" });
});

test("resolveBoardForCommand uses a structured default with multiple boards", () => {
  const result = resolveBoardForCommand(
    [
      { id: "board-1", name: "Primary", relays: [] } as any,
      { id: "board-2", name: "Work", relays: [] } as any,
    ],
    undefined,
    { boardId: "board-2", listId: "list-2" },
  );
  assert.deepEqual(result, { ok: true, boardId: "board-2" });
});

test("resolveBoardForCommand does not select a compound default for writes", () => {
  const result = resolveBoardForCommand(
    [
      { id: "board-1", name: "Primary", kind: "lists", relays: [] } as any,
      { id: "board-all", name: "Everything", kind: "compound", relays: [] } as any,
    ],
    undefined,
    { boardId: "board-all" },
    { writable: true },
  );
  assert.equal(result.ok, false);
});

test("requireResolvedTask returns not-found error envelope with exit code", async () => {
  const runtime = { getTask: async () => null };
  const result = await requireResolvedTask(runtime, "task-123", "board-1");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, "Task not found: task-123");
  }
});

test("requireResolvedEvent returns not-found error envelope with exit code", async () => {
  const runtime = { getEvent: async () => null };
  const result = await requireResolvedEvent(runtime, "event-123", "board-1");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, "Event not found: event-123");
  }
});
