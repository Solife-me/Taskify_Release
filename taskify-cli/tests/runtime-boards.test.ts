import test from "node:test";
import assert from "node:assert/strict";
import type { NostrEvent } from "nostr-tools";
import { decryptFromBoard } from "taskify-core";
import { boardEvents, boardTagHash, deriveBoardKeyPair, runtimeHarness } from "./helpers/runtimeHarness.ts";

/**
 * The runtime's board definitions (kind 30300), through a real session on a loopback relay.
 *
 * A board's id is its key: whoever has it can derive the signer and decrypt everything on the
 * board. A definition's tags are public, so they carry only what the PWA and iOS put there (the
 * hashed board tag, the kind and the name). Lists and child boards go in the encrypted content.
 */

const BOARD_DEFINITION = 30300;

async function definitionPayload(event: NostrEvent, boardId: string): Promise<Record<string, any>> {
  return JSON.parse((await decryptFromBoard(boardId, event.content)).plaintext);
}

/** Every string a definition shows anyone reading the relay. */
function publicValues(event: NostrEvent): string[] {
  return event.tags.flat();
}

test("a compound board's definition keeps its children's ids out of its public tags", async () => {
  const h = await runtimeHarness();
  try {
    const children = ["board-lists-1", "board-week-1"];
    const { boardId } = await h.runtime.createBoard({ name: "Everything", kind: "compound", children });
    const [created] = boardEvents(h.relay, boardId, BOARD_DEFINITION);
    assert.equal(created.pubkey, deriveBoardKeyPair(boardId).pk);
    assert.deepEqual(created.tags, [["d", boardTagHash(boardId)], ["b", boardTagHash(boardId)], ["k", "compound"], ["name", "Everything"]]);
    for (const child of children) assert.equal(publicValues(created).includes(child), false, `${child} is not public`);
    assert.deepEqual((await definitionPayload(created, boardId)).children, children);

    // Every later change republishes the whole definition.
    h.advance(60_000);
    await h.runtime.updateBoard(boardId, { children: [...children, "board-later-1"], hidden: true });
    const [updated] = boardEvents(h.relay, boardId, BOARD_DEFINITION);
    assert.equal(publicValues(updated).includes("board-later-1"), false);
    assert.deepEqual((await definitionPayload(updated, boardId)).children, [...children, "board-later-1"]);
  } finally {
    await h.close();
  }
});

test("a list board's definition keeps its list names out of its public tags", async () => {
  const h = await runtimeHarness();
  try {
    const columns = [{ id: "col-a", name: "Groceries to buy" }, { id: "col-b", name: "Doctor's appointments" }];
    const { boardId } = await h.runtime.createBoard({ name: "Home", kind: "lists", columns });
    const [created] = boardEvents(h.relay, boardId, BOARD_DEFINITION);
    assert.deepEqual(created.tags, [["d", boardTagHash(boardId)], ["b", boardTagHash(boardId)], ["k", "lists"], ["name", "Home"]]);
    for (const column of columns) {
      assert.equal(publicValues(created).includes(column.name), false, `"${column.name}" is not public`);
      assert.equal(publicValues(created).includes(column.id), false);
    }
    assert.deepEqual((await definitionPayload(created, boardId)).columns, columns);
  } finally {
    await h.close();
  }
});

test("syncing a board reads its lists and children back from the encrypted definition", async () => {
  const h = await runtimeHarness();
  try {
    const { boardId } = await h.runtime.createBoard({ name: "Everything", kind: "compound", children: ["board-lists-1", "board-week-1"] });
    const lists = await h.runtime.createBoard({ name: "Home", kind: "lists", columns: [{ id: "col-a", name: "Groceries" }] });
    for (const entry of h.config.boards) {
      if (entry.id === boardId) entry.children = [];
      if (entry.id === lists.boardId) entry.columns = [];
    }

    assert.deepEqual((await h.runtime.syncBoard(boardId)).children, ["board-lists-1", "board-week-1"]);
    assert.deepEqual((await h.runtime.syncBoard(lists.boardId)).columns, [{ id: "col-a", name: "Groceries" }]);
    assert.deepEqual(h.config.boards.find((entry) => entry.id === boardId)?.children, ["board-lists-1", "board-week-1"]);
    assert.deepEqual(h.config.boards.find((entry) => entry.id === lists.boardId)?.columns, [{ id: "col-a", name: "Groceries" }]);
  } finally {
    await h.close();
  }
});
