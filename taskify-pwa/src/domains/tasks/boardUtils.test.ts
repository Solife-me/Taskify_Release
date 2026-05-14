import { describe, expect, test } from "vitest";
import { migrateBoards, withBoardOrder } from "./boardUtils";
import type { Board } from "./taskTypes";

describe("board ordering", () => {
  test("migrateBoards restores persisted board order", () => {
    const migrated = migrateBoards([
      { id: "b", name: "B", kind: "lists", columns: [], order: 1 },
      { id: "a", name: "A", kind: "week", order: 0 },
      { id: "c", name: "C", kind: "compound", children: [], order: 2 },
    ]);

    expect(migrated?.map((board) => board.id)).toEqual(["a", "b", "c"]);
    expect(migrated?.map((board) => board.order)).toEqual([0, 1, 2]);
  });

  test("withBoardOrder writes order onto moved board rows", () => {
    const a = { id: "a", name: "A", kind: "week", order: 0 } as Board;
    const b = { id: "b", name: "B", kind: "week", order: 1 } as Board;

    const reordered = withBoardOrder([b, a]);

    expect(reordered.map((board) => board.order)).toEqual([0, 1]);
    expect(reordered[0]).not.toBe(b);
    expect(reordered[1]).not.toBe(a);
  });
});
