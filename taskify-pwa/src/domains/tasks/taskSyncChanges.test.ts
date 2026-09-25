import { describe, expect, it } from "vitest";
import type { Task } from "./taskTypes";
import { hasSyncedTaskChange } from "./taskSyncChanges";

const base = {
  id: "t1", boardId: "b", title: "Task", createdAt: 1, dueISO: "2026-09-24T00:00:00.000Z",
  completed: false, order: 3, columnId: "c1", lastEditedBy: "a".repeat(64),
} as Task;

describe("hasSyncedTaskChange", () => {
  it("ignores changes that never reach other devices", () => {
    // Order is device-local: it is not part of the published task payload.
    expect(hasSyncedTaskChange(base, { ...base, order: 0 })).toBe(false);
    expect(hasSyncedTaskChange(base, { ...base, order: 0, lastEditedBy: "b".repeat(64) })).toBe(false);
    expect(hasSyncedTaskChange(base, { ...base, _nostrAt: 99 } as Task)).toBe(false);
  });

  it("reports changes other devices would see", () => {
    expect(hasSyncedTaskChange(base, { ...base, columnId: "c2" })).toBe(true);
    expect(hasSyncedTaskChange(base, { ...base, boardId: "other" })).toBe(true);
    expect(hasSyncedTaskChange(base, { ...base, dueISO: "2026-09-25T00:00:00.000Z" })).toBe(true);
    expect(hasSyncedTaskChange(base, { ...base, completed: true })).toBe(true);
    expect(hasSyncedTaskChange(base, { ...base, hiddenUntilISO: "2026-09-30T00:00:00.000Z" })).toBe(true);
  });
});
