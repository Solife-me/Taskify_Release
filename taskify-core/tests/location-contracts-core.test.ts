import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskLocation,
  resolveTaskLocation,
  type TaskifyLocationBoard,
} from "../src/locationContracts.ts";

const boards: TaskifyLocationBoard[] = [
  {
    id: "board-work",
    name: "Client Work",
    kind: "lists",
    lists: [
      { id: "list-queue", name: "Agent Queue" },
      { id: "list-doing", name: "Doing" },
    ],
  },
  {
    id: "board-personal",
    name: "Personal",
    kind: "lists",
    lists: [{ id: "list-inbox", name: "Inbox" }],
  },
  {
    id: "board-everything",
    name: "Everything",
    kind: "compound",
    lists: [],
  },
];

test("parseTaskLocation preserves multi-word board and list names", () => {
  assert.deepEqual(parseTaskLocation("Client Work/Agent Queue"), {
    boardRef: "Client Work",
    listRef: "Agent Queue",
  });
});

test("resolveTaskLocation resolves a Board/List path deterministically", () => {
  assert.deepEqual(resolveTaskLocation({ boards, location: "Client Work/Agent Queue" }), {
    ok: true,
    location: {
      boardId: "board-work",
      boardName: "Client Work",
      listId: "list-queue",
      listName: "Agent Queue",
    },
    source: "explicit",
  });
});

test("resolveTaskLocation uses a structured default before the sole-board fallback", () => {
  const result = resolveTaskLocation({
    boards,
    defaultLocation: { boardId: "board-personal", listId: "list-inbox" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.location.boardId, "board-personal");
    assert.equal(result.location.listId, "list-inbox");
    assert.equal(result.source, "default");
  }
});

test("resolveTaskLocation never chooses silently when writable boards are ambiguous", () => {
  const result = resolveTaskLocation({ boards });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "AMBIGUOUS_BOARD");
    assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["board-work", "board-personal"]);
  }
});

test("resolveTaskLocation rejects compound boards as write targets", () => {
  const result = resolveTaskLocation({ boards, location: "Everything" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "READ_ONLY_BOARD");
});

test("resolveTaskLocation chooses the only list when a list board has one", () => {
  const result = resolveTaskLocation({ boards, location: "Personal" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.location.listId, "list-inbox");
});

test("read resolution can target an entire list or compound board without choosing a list", () => {
  const listBoard = resolveTaskLocation({ boards, location: "Client Work", intent: "read" });
  assert.equal(listBoard.ok, true);
  if (listBoard.ok) assert.equal(listBoard.location.listId, undefined);

  const compound = resolveTaskLocation({ boards, location: "Everything", intent: "read" });
  assert.equal(compound.ok, true);
  if (compound.ok) assert.equal(compound.location.boardId, "board-everything");
});
