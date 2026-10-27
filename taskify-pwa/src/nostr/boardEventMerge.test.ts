import { describe, expect, test } from "vitest";
import type { Board } from "../domains/tasks/taskTypes";
import { applyBoardMetadata } from "./boardEventMerge";

let n = 0;
const context = { defaultRelays: ["wss://default"], newId: () => `id-${++n}` };
const lists = { id: "b1", name: "Team", kind: "lists", columns: [{ id: "c1", name: "Todo" }], nostr: { boardId: "nb1", relays: ["wss://team"] }, order: 0 } as unknown as Board;
const child = { id: "b2", name: "Child", kind: "lists", columns: [], nostr: { boardId: "nb2", relays: [] }, order: 1 } as unknown as Board;

describe("applying a board's metadata event", () => {
  test("renames and replaces the lists, keeping local-only fields", () => {
    const [board] = applyBoardMetadata([{ ...lists, archived: true } as Board], "b1", {
      kindTag: "lists",
      name: "Renamed",
      payload: { columns: [{ id: "c9", name: "Doing" }], clearCompletedDisabled: true, listIndex: true },
    }, context);
    expect(board).toMatchObject({ name: "Renamed", kind: "lists", columns: [{ id: "c9", name: "Doing" }], archived: true, clearCompletedDisabled: true, indexCardEnabled: true });
  });

  test("without a name or columns, keeps the board's own", () => {
    const [board] = applyBoardMetadata([lists], "b1", { kindTag: "lists", name: undefined, payload: {} }, context);
    expect(board).toMatchObject({ name: "Team", columns: [{ id: "c1", name: "Todo" }] });
  });

  test("a board that became a week board", () => {
    const [board] = applyBoardMetadata([lists], "b1", { kindTag: "week", name: undefined, payload: {} }, context);
    expect(board.kind).toBe("week");
    expect(board).not.toHaveProperty("columns");
  });

  test("compound children resolve to known boards, unknown ones get hidden linked stubs, duplicates drop", () => {
    const result = applyBoardMetadata([lists, child], "b1", {
      kindTag: "compound",
      name: undefined,
      payload: { children: ["nb2", "nb3", "nb2", 7], hideBoardNames: true },
    }, context);
    const compound = result.find((board) => board.id === "b1");
    expect(compound).toMatchObject({ kind: "compound", children: ["b2", "nb3"], hideChildBoardNames: true });
    const stub = result.find((board) => board.id === "nb3");
    expect(stub).toMatchObject({ name: "Linked board", hidden: true, archived: true, nostr: { boardId: "nb3", relays: ["wss://team"] } });
  });

  test("an event for a board this device no longer has changes nothing", () => {
    const boards = [lists];
    expect(applyBoardMetadata(boards, "missing", { kindTag: "lists", name: "X", payload: {} }, context)).toBe(boards);
  });

  test("an unknown kind keeps the board's kind and updates the rest", () => {
    const [board] = applyBoardMetadata([lists], "b1", { kindTag: undefined, name: "Kept kind", payload: { clearCompletedDisabled: true } }, context);
    expect(board).toMatchObject({ kind: "lists", name: "Kept kind", clearCompletedDisabled: true });
  });
});
