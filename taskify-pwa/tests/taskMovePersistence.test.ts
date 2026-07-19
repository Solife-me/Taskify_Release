import { describe, expect, test } from "vitest";

import {
  reserveTaskMutationTimestamp,
  TaskPublishVersionTracker,
  taskMovePersistencePlan,
} from "../src/domains/tasks/taskMovePersistence";

describe("task move persistence", () => {
  test("never moves the optimistic relay clock backward", () => {
    expect(reserveTaskMutationTimestamp(150, 200)).toBe(201);
    expect(reserveTaskMutationTimestamp(250, 200)).toBe(250);
  });

  test("cross-board moves delete the source copy and publish the target copy", () => {
    const source = { id: "task-1", boardId: "child-a", columnId: "todo" };
    const target = { ...source, boardId: "child-b", columnId: "doing" };

    expect(taskMovePersistencePlan(source, target)).toEqual({
      sourceToDelete: source,
      targetToPublish: target,
    });
  });

  test("same-board list moves only publish the updated copy", () => {
    const source = { id: "task-1", boardId: "board-1", columnId: "todo" };
    const target = { ...source, columnId: "doing" };

    expect(taskMovePersistencePlan(source, target)).toEqual({
      sourceToDelete: null,
      targetToPublish: target,
    });
  });

  test("an overlapping newer move supersedes the older queued publish", () => {
    const versions = new TaskPublishVersionTracker();
    const firstMove = versions.reserve("board-1::task-1");
    const secondMove = versions.reserve("board-1::task-1");

    expect(versions.isCurrent("board-1::task-1", firstMove)).toBe(false);
    expect(versions.finish("board-1::task-1", firstMove)).toBe(false);
    expect(versions.isCurrent("board-1::task-1", secondMove)).toBe(true);
    expect(versions.finish("board-1::task-1", secondMove)).toBe(true);
  });
});
