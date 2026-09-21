import test from "node:test";
import assert from "node:assert/strict";
import { planTaskReorder, parseTaskOrder } from "../src/shared/taskOrdering.ts";

const tasks = [
  { id: "aaaa", boardId: "board", order: 0, title: "First" },
  { id: "bbbb", boardId: "board", order: 1, title: "Second" },
  { id: "cccc", boardId: "board", order: 2, title: "Third" },
];
test("reorder moves both directions, preserves fields and does not mutate input", () => {
  const changes = planTaskReorder(tasks, "cc", 1);
  assert.deepEqual(changes.map(t => [t.id, t.order]), [["cccc", 0], ["aaaa", 1], ["bbbb", 2]]);
  assert.equal(changes[0].title, "Third");
  assert.equal(tasks[2].order, 2);
  assert.deepEqual(planTaskReorder(tasks, "aaaa", 3).map(t => [t.id, t.order]), [["bbbb", 0], ["cccc", 1], ["aaaa", 2]]);
  assert.deepEqual(planTaskReorder(tasks, "bbbb", 2), []);
});
test("reorder rejects invalid positions, missing and ambiguous IDs, and mixed boards", () => {
  for (const position of [0, -1, 4, 1.5, NaN]) assert.throws(() => planTaskReorder(tasks, "aaaa", position));
  assert.throws(() => planTaskReorder(tasks, "missing", 1), /not found/);
  assert.throws(() => planTaskReorder([...tasks, { id: "aaab", boardId: "board", order: 3, title: "Other" }], "aaa", 1), /Ambiguous/);
  assert.throws(() => planTaskReorder([...tasks, { id: "other", boardId: "other", order: 0, title: "Other" }], "aaaa", 1), /single source board/);
});
test("legacy missing orders and tied positions are normalized deterministically", () => {
  const legacy = [{ id: "b", boardId: "board" }, { id: "a", boardId: "board" }];
  assert.deepEqual(planTaskReorder(legacy, "b", 1).map(t => [t.id, t.order]), [["b", 0], ["a", 1]]);
});
test("order parsing rejects malformed, negative, fractional and unsafe numbers", () => {
  assert.equal(parseTaskOrder("0"), 0);
  assert.equal(parseTaskOrder("42"), 42);
  for (const value of ["", "-1", "1.5", "2abc", "Infinity", "9007199254740992"]) assert.throws(() => parseTaskOrder(value));
});
