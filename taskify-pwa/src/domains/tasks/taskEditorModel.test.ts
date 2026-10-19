import { describe, expect, test } from "vitest";
import type { Board, Task } from "./taskTypes";
import { buildTaskFromEditor, normalizeAssigneeList, taskEditorStart, type TaskEditorDraft } from "./taskEditorModel";

const listBoard = { id: "l", name: "Projects", kind: "lists", columns: [{ id: "c1", name: "Inbox" }, { id: "c2", name: "Later" }] } as unknown as Board;
const weekBoard = { id: "w", name: "Week", kind: "week" } as unknown as Board;
const CHICAGO = "America/Chicago";

const timedTask = {
  id: "t1",
  boardId: "l",
  columnId: "c2",
  title: "Call Sam",
  // 15:07:33 in Chicago; the seconds would be lost if the time were rebuilt.
  dueISO: "2026-10-20T20:07:33.123Z",
  dueDateEnabled: true,
  dueTimeEnabled: true,
  dueTimeZone: CHICAGO,
  reminders: ["15m"],
  completed: false,
} as unknown as Task;

function draftFrom(task: Task, board: Board, changes: Partial<TaskEditorDraft> = {}): TaskEditorDraft {
  const start = taskEditorStart(task, CHICAGO);
  return {
    title: task.title,
    note: task.note ?? "",
    priority: 0,
    images: [],
    documents: [],
    subtasks: [],
    assignees: [],
    rule: task.recurrence ?? { type: "none" },
    boardId: task.boardId,
    board,
    boardKind: board.kind,
    columnId: task.columnId ?? "",
    dateEnabled: start.dateEnabled,
    date: start.date,
    time: start.time,
    timeZone: start.timeZone,
    reminders: start.reminders,
    reminderTime: start.reminderTime,
    ...changes,
  };
}

describe("task editor model", () => {
  test("starts from the task's date, time and zone", () => {
    expect(taskEditorStart(timedTask, "UTC")).toMatchObject({
      dateEnabled: true,
      date: "2026-10-20",
      time: "15:07",
      hadTime: true,
      timeZone: CHICAGO,
      reminders: ["15m"],
    });
  });

  test("saving an untouched schedule keeps the exact due instant", () => {
    const saved = buildTaskFromEditor(timedTask, taskEditorStart(timedTask, CHICAGO), draftFrom(timedTask, listBoard), 0);
    expect(saved.dueISO).toBe(timedTask.dueISO);
    expect(saved).toMatchObject({ dueTimeEnabled: true, dueTimeZone: CHICAGO, columnId: "c2", reminders: ["15m"] });
  });

  test("a new time is set in the chosen zone", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, listBoard, { time: "09:30" }), 0);
    expect(saved.dueISO).toBe("2026-10-20T14:30:00.000Z");
  });

  test("turning the time off keeps the date and sets the reminder time", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, listBoard, { time: "", reminderTime: "08:00" }), 0);
    expect(saved.dueTimeEnabled).toBeUndefined();
    expect(saved.dueTimeZone).toBeUndefined();
    expect(saved.reminderTime).toBe("08:00");
  });

  test("on a lists board without a date, the due date is off and reminders are cleared", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, listBoard, { dateEnabled: false }), 0);
    expect(saved).toMatchObject({ dueDateEnabled: false, reminders: [], hiddenUntilISO: undefined, dueISO: timedTask.dueISO });
  });

  test("week boards always have a date and place the task by day", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, weekBoard, { boardId: "w", dateEnabled: false }), 0);
    expect(saved).toMatchObject({ boardId: "w", dueDateEnabled: true, column: "day", columnId: undefined });
  });

  test("moving to a lists board without a list chooses its first list", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, listBoard, { columnId: "" }), 0);
    expect(saved.columnId).toBe("c1");
  });

  test("empty fields are dropped and priority 0 means none", () => {
    const start = taskEditorStart(timedTask, CHICAGO);
    const saved = buildTaskFromEditor(timedTask, start, draftFrom(timedTask, listBoard, { note: "", priority: 0 }), 0);
    expect(saved.note).toBeUndefined();
    expect(saved.priority).toBeUndefined();
    expect(saved.images).toBeUndefined();
  });

  test("assignees are de-duplicated and invalid keys dropped", () => {
    const hex = "a".repeat(64);
    expect(normalizeAssigneeList([{ pubkey: hex }, { pubkey: hex.toUpperCase() }, { pubkey: "nope" }])).toEqual([{ pubkey: hex }]);
  });
});
