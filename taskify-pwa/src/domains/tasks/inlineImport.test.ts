import { describe, expect, test } from "vitest";
import type { Board } from "taskify-core";
import {
  buildImportedCalendarEventFromPayload,
  buildImportedTaskFromPayload,
  parseInlineImportItems,
  type InlineImportContext,
} from "./inlineImport";

const listBoard = { id: "b1", name: "Projects", kind: "lists", columns: [{ id: "c1", name: "Inbox" }] } as unknown as Board;
const context: InlineImportContext = {
  board: listBoard,
  weekStart: 0,
  newTaskPosition: "bottom",
  actorPubkey: null,
};

describe("parseInlineImportItems", () => {
  test("plain text is not an import", () => {
    expect(parseInlineImportItems("Buy milk")).toEqual([]);
    expect(parseInlineImportItems("")).toEqual([]);
  });

  test("one object, a list, and grouped tasks and events", () => {
    expect(parseInlineImportItems('{"title":"A"}')).toEqual([{ type: "task", payload: { title: "A" } }]);
    expect(parseInlineImportItems('[{"title":"A"},{"title":"B","startDate":"2026-10-20"}]').map((item) => item.type))
      .toEqual(["task", "event"]);
    const grouped = parseInlineImportItems('{"tasks":[{"title":"T"}],"events":[{"title":"E"}]}');
    expect(grouped.map((item) => [item.type, item.payload.title])).toEqual([["task", "T"], ["event", "E"]]);
  });

  test("smart quotes, full-width punctuation and code fences from chat apps", () => {
    expect(parseInlineImportItems("{“title”：“Smart”}")).toEqual([{ type: "task", payload: { title: "Smart" } }]);
    expect(parseInlineImportItems('Here you go:\n```json\n{"title":"Fenced"}\n```')[0]?.payload.title).toBe("Fenced");
  });

  test("one object per line", () => {
    expect(parseInlineImportItems('{"title":"One"}\n{"title":"Two"}').map((item) => item.payload.title)).toEqual(["One", "Two"]);
  });

  test("boards and contacts are not imported as tasks", () => {
    expect(parseInlineImportItems('{"type":"board","title":"X"}')).toEqual([]);
    expect(parseInlineImportItems('{"type":"contact","title":"X"}')).toEqual([]);
  });

  test("a Taskify share envelope imports its item", () => {
    expect(parseInlineImportItems('{"v":1,"kind":"taskify-share","item":{"title":"Shared"}}')[0]?.payload.title).toBe("Shared");
  });
});

describe("building imported items", () => {
  test("a task needs a title and lands on the open board", () => {
    expect(buildImportedTaskFromPayload({ title: "  " }, { taskPool: [] }, context)).toBeNull();
    const task = buildImportedTaskFromPayload({ title: "Write report", priority: 2 }, { taskPool: [] }, context);
    expect(task).toMatchObject({ title: "Write report", boardId: "b1" });
  });

  test("overrides choose the board and list", () => {
    const task = buildImportedTaskFromPayload(
      { title: "Moved" },
      { taskPool: [], overrides: { boardId: "b2", columnId: "c9" } },
      context,
    );
    expect(task).toMatchObject({ boardId: "b2", columnId: "c9" });
  });

  test("an all-day event keeps its date", () => {
    const event = buildImportedCalendarEventFromPayload(
      { title: "Offsite", startDate: "2026-10-20" },
      { boardId: "b1", boardKind: "lists", columnId: "c1", fallbackDateKey: "2026-10-18", eventPool: [] },
      context,
    );
    expect(event).toMatchObject({ title: "Offsite", kind: "date", startDate: "2026-10-20", boardId: "b1" });
  });
});
