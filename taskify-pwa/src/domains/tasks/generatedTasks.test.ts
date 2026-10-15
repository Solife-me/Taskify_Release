import { describe, expect, it } from "vitest";
import { FASTING_REMINDER_SERIES_ID, SCRIPTURE_MEMORY_SERIES_ID } from "taskify-core";
import { planFastingReminders, planScriptureReviewTask, type FastingReminderSettings } from "./generatedTasks";
import type { Board, Task } from "./taskTypes";

const NOW = new Date(2026, 9, 15, 10, 0, 0);
const week = { id: "w", name: "Week", kind: "week" } as Board;
const lists = { id: "l", name: "Lists", kind: "lists", columns: [{ id: "c1", name: "A" }] } as Board;

const fasting: FastingReminderSettings = {
  fastingRemindersEnabled: true,
  fastingRemindersMode: "weekday",
  fastingRemindersWeekday: 3,
  fastingRemindersPerMonth: 2,
  fastingRemindersRandomSeed: "seed",
  weekStart: 0,
  newTaskPosition: "bottom",
};

describe("planFastingReminders", () => {
  it("creates this month's and next month's future reminders on the board, then is stable", () => {
    const plan = planFastingReminders([], { targetBoard: lists, now: NOW, settings: fasting })!;
    expect(plan.publish.length).toBeGreaterThan(0);
    for (const reminder of plan.tasks) {
      expect(reminder).toMatchObject({ boardId: "l", columnId: "c1", seriesId: FASTING_REMINDER_SERIES_ID, title: "Fasting" });
      expect(new Date(reminder.dueISO).getTime()).toBeGreaterThanOrEqual(new Date(2026, 9, 15).getTime());
      expect(reminder.id.startsWith(`${FASTING_REMINDER_SERIES_ID}:`)).toBe(true);
    }
    expect(planFastingReminders(plan.tasks, { targetBoard: lists, now: NOW, settings: fasting })).toBeNull();
  });

  it("deletes open reminders everywhere when turned off, keeping completed ones", () => {
    const created = planFastingReminders([], { targetBoard: week, now: NOW, settings: fasting })!.tasks;
    const done = { ...created[0], completed: true };
    const plan = planFastingReminders([done, ...created.slice(1)], {
      targetBoard: week,
      now: NOW,
      settings: { ...fasting, fastingRemindersEnabled: false },
    })!;
    expect(plan.tasks).toEqual([done]);
    expect(plan.publishDeleted).toHaveLength(created.length - 1);
  });

  it("deletes a future reminder no longer wanted and moves the rest to the reminder board", () => {
    const created = planFastingReminders([], { targetBoard: week, now: NOW, settings: fasting })!.tasks;
    const stray = { ...created[0], id: "fasting-reminder:stray", dueISO: new Date(2026, 9, 30).toISOString() } as Task;
    const plan = planFastingReminders([...created, stray], { targetBoard: lists, now: NOW, settings: fasting })!;
    expect(plan.publishDeleted.map((t) => t.id)).toEqual(["fasting-reminder:stray"]);
    expect(plan.tasks.every((t) => t.boardId === "l" && t.columnId === "c1")).toBe(true);
    expect(plan.publish).toHaveLength(created.length);
  });
});

describe("planScriptureReviewTask", () => {
  const entries = [
    { id: "e1", bookId: "JHN", chapter: 3, startVerse: 16, endVerse: 16, addedAtISO: "2026-09-01T00:00:00.000Z", stage: 0, totalReviews: 0 },
  ];
  const input = { targetBoard: lists, entries, baseDays: 1, now: NOW, settings: { weekStart: 0 as const, newTaskPosition: "bottom" as const } };

  it("creates one review task with a date-derived id when none is open", () => {
    const plan = planScriptureReviewTask([], {}, input)!;
    expect(plan.created).toMatchObject({
      boardId: "l",
      columnId: "c1",
      seriesId: SCRIPTURE_MEMORY_SERIES_ID,
      scriptureMemoryId: "e1",
      recurrence: { type: "daily" },
    });
    expect(plan.created!.id.startsWith(`recurrence:${SCRIPTURE_MEMORY_SERIES_ID}:`)).toBe(true);
    expect(plan.scheduledEntryId).toBe("e1");
    expect(planScriptureReviewTask(plan.tasks, {}, input)).toBeNull();
  });

  it("moves existing review tasks to the chosen board without creating another", () => {
    const open = { id: "r", boardId: "w", title: "Review", dueISO: NOW.toISOString(), seriesId: SCRIPTURE_MEMORY_SERIES_ID, recurrence: { type: "daily" } } as Task;
    const plan = planScriptureReviewTask([open], {}, input)!;
    expect(plan.created).toBeNull();
    expect(plan.tasks[0]).toMatchObject({ boardId: "l", columnId: "c1" });
  });

  it("does nothing without passages or on a list board without lists", () => {
    expect(planScriptureReviewTask([], {}, { ...input, entries: [] })).toBeNull();
    expect(planScriptureReviewTask([], {}, { ...input, targetBoard: { ...lists, columns: [] } as Board })).toBeNull();
  });
});
