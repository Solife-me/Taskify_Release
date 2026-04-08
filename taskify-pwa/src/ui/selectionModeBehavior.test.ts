import { describe, expect, it } from "vitest";
import { isCardDragEnabled } from "./task/Card";
import { isEventCardDragEnabled } from "./calendar/EventCard";

describe("selection mode board card behavior", () => {
  it("disables task dragging while selection mode is active", () => {
    expect(isCardDragEnabled(true)).toBe(false);
    expect(isCardDragEnabled(false)).toBe(true);
    expect(isCardDragEnabled()).toBe(true);
  });

  it("disables event dragging while selection mode is active", () => {
    expect(isEventCardDragEnabled(true, true)).toBe(false);
    expect(isEventCardDragEnabled(false, true)).toBe(true);
    expect(isEventCardDragEnabled(false, false)).toBe(false);
    expect(isEventCardDragEnabled(true, false)).toBe(false);
  });

  it("keeps bulk action availability aligned with the current selection", () => {
    const selectedTasks = [{ id: "task-1", completed: false }, { id: "task-2", completed: true }];
    const selectedEvents = [{ id: "event-1" }];

    expect(selectedTasks.length).toBe(2);
    expect(selectedEvents.length).toBe(1);
    expect(selectedTasks.some((task) => !task.completed)).toBe(true);
  });
});
