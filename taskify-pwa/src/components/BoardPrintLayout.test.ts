import { expect, test } from "vitest";
import { BOARD_PRINT_LAYOUT_VERSION, buildBoardPrintLayout, isTaskPrintable, tasksForBoardPrintScope, type BoardPrintTask } from "./BoardPrintLayout";

const tasks: BoardPrintTask[] = [
  { id: "a", title: "A", listId: "list-a" },
  { id: "b", title: "B", listId: "list-b" },
  { id: "c", title: "C" },
];

test("whole-board and selected-task print scopes keep the prepared task list", () => {
  expect(tasksForBoardPrintScope(tasks, { kind: "board" })).toEqual(tasks);
  expect(tasksForBoardPrintScope(tasks, { kind: "selection" })).toEqual(tasks);
  expect(tasksForBoardPrintScope(tasks, undefined)).toEqual(tasks);
});

test("selected-list print scope includes only matching lists and never the whole board by accident", () => {
  expect(tasksForBoardPrintScope(tasks, { kind: "lists", listIds: ["list-b"] })).toEqual([tasks[1]]);
  expect(tasksForBoardPrintScope(tasks, { kind: "lists", listIds: ["list-a", "list-b"] })).toEqual(tasks.slice(0, 2));
  expect(tasksForBoardPrintScope(tasks, { kind: "lists", listIds: [] })).toEqual([]);
});

test("completed tasks require the Completed-tab print setting", () => {
  expect(isTaskPrintable({ completed: true }, false)).toBe(false);
  expect(isTaskPrintable({ completed: true }, true)).toBe(true);
  expect(isTaskPrintable({ completed: false }, false)).toBe(true);
});


test("v3 sheets carry a job-validation code while legacy jobs remain readable", () => {
  const current = buildBoardPrintLayout(tasks, { jobId: "current-print" });
  const legacy = buildBoardPrintLayout(tasks, { jobId: "legacy-print", layoutVersion: "v2" });
  expect(BOARD_PRINT_LAYOUT_VERSION).toBe("v3");
  expect(current.version).toBe("v3");
  expect(current.jobCode?.pattern).toHaveLength(10);
  expect(legacy.version).toBe("v2");
  expect(legacy.jobCode).toBeUndefined();
  expect(() => buildBoardPrintLayout(tasks, { layoutVersion: "v4" })).toThrow(/unsupported/i);
});
