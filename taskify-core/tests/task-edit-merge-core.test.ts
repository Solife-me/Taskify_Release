/**
 * C8-2: saving the task editor applies only what the user changed, so a change that arrived
 * while the editor was open (another device, a widget, Siri) is not reverted. Swift has the same
 * rule in TaskEditorFields.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeTaskEdit } from "../dist/index.js";

const base = () => ({
  id: "t1",
  boardId: "b1",
  title: "Pack for the trip",
  note: "Passport first",
  dueISO: "2026-10-22T12:00:00.000Z",
  subtasks: [
    { id: "s1", title: "Passport", completed: false },
    { id: "s2", title: "Charger", completed: false },
  ],
});

test("a subtask ticked elsewhere survives saving a priority change", () => {
  const opened = base();
  const edited = { ...base(), priority: 3 as const };
  const current = base();
  current.subtasks[0].completed = true;
  const merged = mergeTaskEdit(opened, edited, current);
  assert.equal(merged.priority, 3);
  assert.deepEqual(merged.subtasks?.map((s) => s.completed), [true, false]);
});

test("subtasks merge item by item", () => {
  const opened = base();
  const edited = { ...base(), subtasks: [base().subtasks[0], { id: "s3", title: "Snacks", completed: false }] };
  const current = base();
  current.subtasks[0].completed = true;
  current.subtasks.push({ id: "s4", title: "Umbrella", completed: false });
  const merged = mergeTaskEdit(opened, edited, current);
  assert.deepEqual(merged.subtasks?.map((s) => s.id), ["s1", "s3", "s4"]);
  assert.equal(merged.subtasks?.[0].completed, true);
});

test("a field changed here wins; one changed only elsewhere stays", () => {
  const merged = mergeTaskEdit(base(), { ...base(), note: "Passport and visa" }, { ...base(), note: "Tickets", title: "Pack for Lisbon", completed: true });
  assert.equal(merged.note, "Passport and visa");
  assert.equal(merged.title, "Pack for Lisbon");
  assert.equal(merged.completed, true);
});

test("the schedule moves as one group", () => {
  const edited = { ...base(), dueISO: "2026-10-25T12:00:00.000Z", dueTimeEnabled: true, dueTimeZone: "America/Chicago" };
  const current = { ...base(), recurrence: { type: "daily" as const } };
  const merged = mergeTaskEdit(base(), edited, current);
  assert.equal(merged.dueISO, edited.dueISO);
  assert.equal(merged.dueTimeZone, "America/Chicago");
  assert.equal(merged.recurrence, undefined, "a schedule chosen here replaces the whole schedule");
});

test("a field cleared here is cleared", () => {
  const merged = mergeTaskEdit({ ...base(), priority: 2 as const }, base(), { ...base(), priority: 2 as const });
  assert.equal("priority" in merged && merged.priority !== undefined, false);
});
