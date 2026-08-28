import test from "node:test";
import assert from "node:assert/strict";
import { mergeBoardsFromShareInbox } from "../src/shared/backupSync.ts";

function boardShare(boardId: string, boardName: string, relays: string[]) {
  return {
    wrapId: `wrap-${boardId}`,
    rumorId: `rumor-${boardId}`,
    senderPubkey: "a".repeat(64),
    createdAt: 1,
    raw: "",
    envelope: {
      v: 1 as const,
      kind: "taskify-share" as const,
      item: { type: "board" as const, boardId, boardName, relays },
    },
  };
}

test("sync catalog can discover board capabilities from the NIP-17 inbox", () => {
  const config = { boards: [], relays: ["wss://account.example"] } as any;
  const result = mergeBoardsFromShareInbox(config, [
    boardShare("board-1", "Shared Work", ["wss://board.example"]),
  ]);

  assert.deepEqual(result, { sharesScanned: 1, boardSharesFound: 1, boardsAdded: 1 });
  assert.deepEqual(config.boards, [{
    id: "board-1",
    name: "Shared Work",
    kind: "lists",
    relays: ["wss://board.example"],
  }]);
});

test("sync catalog merges relay hints without duplicating an existing board", () => {
  const config = {
    boards: [{ id: "board-1", name: "Shared Work", relays: ["wss://one.example"] }],
    relays: [],
  } as any;
  const result = mergeBoardsFromShareInbox(config, [
    boardShare("board-1", "Shared Work", ["wss://one.example", "wss://two.example"]),
  ]);

  assert.equal(result.boardsAdded, 0);
  assert.deepEqual(config.boards[0].relays, ["wss://one.example", "wss://two.example"]);
});
