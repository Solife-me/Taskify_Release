import { test, expect } from "vitest";

import { recurrenceSeriesKey } from "../src/domains/tasks/taskUtils";
import type { Task } from "../src/domains/tasks/taskTypes";

test("recurrenceSeriesKey ignores untilISO when identifying a recurring series", () => {
  const base: Task = {
    id: "task-1",
    boardId: "board-1",
    title: "Recurring",
    note: "",
    dueISO: "2026-03-12T00:00:00.000Z",
    recurrence: { type: "daily" },
  };

  expect(
    recurrenceSeriesKey({
      ...base,
      recurrence: { type: "daily", untilISO: "2026-03-12T00:00:00.000Z" },
    }),
  ).toBe(recurrenceSeriesKey(base));
});
