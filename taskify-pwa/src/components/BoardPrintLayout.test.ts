import { expect, test } from "vitest";
import {
  BOARD_PRINT_DETAIL_LAYOUT_VERSION,
  BOARD_PRINT_LAYOUT_VERSION,
  buildBoardPrintLayout,
  composeBoardPrintDetail,
  isTaskPrintable,
  tasksForBoardPrintScope,
  type BoardPrintTask,
  type BoardPrintTaskRow,
} from "./BoardPrintLayout";

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


test("the detail line carries the due date and note on one line", () => {
  expect(composeBoardPrintDetail(undefined, undefined)).toBeUndefined();
  expect(composeBoardPrintDetail("Sep 4, 2026", "  buy   milk\nand eggs ")).toBe("Sep 4, 2026 · buy milk and eggs");
  expect(composeBoardPrintDetail(undefined, "a note")).toBe("a note");
});

test("a task's detail prints beneath its title", () => {
  const layout = buildBoardPrintLayout([{ id: "a", title: "A", detail: "Sep 4, 2026 · buy milk" }], { jobId: "detail-print" });
  const row = layout.pages[0].rows.find((entry) => entry.kind === "task");
  expect(row?.kind).toBe("task");
  expect(row?.kind === "task" ? row.detail : undefined).toBe("Sep 4, 2026 · buy milk");
});

test("detailed sheets grow a row for subtasks and photo thumbnails", () => {
  const tasksWithDetail: BoardPrintTask[] = [
    {
      id: "a",
      title: "A",
      subtasks: [{ title: "one" }, { title: "two", completed: true }],
      photos: ["data:image/jpeg;base64,AA"],
    },
    { id: "b", title: "B" },
  ];
  const layout = buildBoardPrintLayout(tasksWithDetail, {
    layoutVersion: BOARD_PRINT_DETAIL_LAYOUT_VERSION,
    jobId: "detail-print",
  });
  const taskRows = layout.pages
    .flatMap((page) => page.rows)
    .filter((row): row is BoardPrintTaskRow => row.kind === "task");

  expect(layout.version).toBe(BOARD_PRINT_DETAIL_LAYOUT_VERSION);
  expect(layout.jobCode?.pattern).toHaveLength(10);
  expect(taskRows[0].heightMm).toBeGreaterThan(taskRows[1].heightMm);
  expect(taskRows[0].subtasks).toEqual([{ title: "one" }, { title: "two", completed: true }]);
  expect(taskRows[0].photos).toEqual(["data:image/jpeg;base64,AA"]);
  expect(taskRows[1].heightMm).toBe(7);
  // The circle stays with the title band, so scanning still finds it.
  expect(taskRows[0].circleY).toBeGreaterThanOrEqual(taskRows[0].y);
  expect(taskRows[0].circleY).toBeLessThan(taskRows[0].y + 7);
});

test("detailed rows paginate by their own height", () => {
  const tallTasks: BoardPrintTask[] = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    subtasks: Array.from({ length: 6 }, (_, subIndex) => ({ title: `Subtask ${subIndex}` })),
    photos: ["data:image/jpeg;base64,AA"],
  }));
  const layout = buildBoardPrintLayout(tallTasks, {
    layoutVersion: BOARD_PRINT_DETAIL_LAYOUT_VERSION,
    paperSize: "a6",
    jobId: "paged-print",
  });
  expect(layout.page.count).toBeGreaterThan(1);
  const bottomMm = layout.content.topMm + layout.content.heightMm;
  for (const page of layout.pages) {
    for (const row of page.rows) {
      expect(row.y + row.heightMm).toBeLessThanOrEqual(bottomMm + 0.001);
    }
  }
});

test("v3 sheets carry a job-validation code while legacy jobs remain readable", () => {
  const current = buildBoardPrintLayout(tasks, { jobId: "current-print" });
  const legacy = buildBoardPrintLayout(tasks, { jobId: "legacy-print", layoutVersion: "v2" });
  expect(BOARD_PRINT_LAYOUT_VERSION).toBe("v3");
  expect(current.version).toBe("v3");
  expect(current.jobCode?.pattern).toHaveLength(10);
  expect(legacy.version).toBe("v2");
  expect(legacy.jobCode).toBeUndefined();
  expect(() => buildBoardPrintLayout(tasks, { layoutVersion: "v5" })).toThrow(/unsupported/i);
});
