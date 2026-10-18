import { describe, expect, test } from "vitest";
import type { Board, Task } from "../../domains/tasks/taskTypes";
import { taskArrivalDestination } from "./flyAnimations";

const week = { id: "w", name: "Week", kind: "week" } as unknown as Board;
const lists = { id: "l", name: "Projects", kind: "lists", columns: [{ id: "c1", name: "Inbox" }] } as unknown as Board;
const compound = { id: "x", name: "All", kind: "compound", children: ["l"] } as unknown as Board;
const task = (fields: Partial<Task>) => ({ id: "t", boardId: "l", title: "Pay rent", completed: false, ...fields }) as Task;
const noSource = () => undefined;

describe("taskArrivalDestination", () => {
  test("a week task flies to its day", () => {
    // 2026-10-20 is a Tuesday (weekday 2).
    expect(taskArrivalDestination(task({ boardId: "w", dueISO: "2026-10-20T12:00:00.000Z" }), week, noSource))
      .toEqual({ type: "column", key: "week-day-2", label: "Pay rent" });
  });

  test("a list task flies to its list; on a compound board, to the list it comes from", () => {
    expect(taskArrivalDestination(task({ columnId: "c1" }), lists, noSource))
      .toEqual({ type: "column", key: "list-c1", label: "Pay rent" });
    expect(taskArrivalDestination(task({ columnId: "c1" }), compound, () => ({ boardId: "l", columnId: "c1" })))
      .toEqual({ type: "column", key: "list-l::c1", label: "Pay rent" });
  });

  test("a task hidden until later flies to Upcoming", () => {
    expect(taskArrivalDestination(task({ columnId: "c1", hiddenUntilISO: "2099-01-01T00:00:00.000Z" }), lists, noSource))
      .toEqual({ type: "upcoming", label: "Pay rent" });
  });

  test("completed tasks and untitled media tasks", () => {
    expect(taskArrivalDestination(task({ completed: true, columnId: "c1" }), lists, noSource)).toBeNull();
    expect(taskArrivalDestination(task({ title: "", images: ["data:,"], columnId: "c1" }), lists, noSource)?.label).toBe("Image");
  });
});
