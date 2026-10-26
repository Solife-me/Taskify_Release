import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, type NostrEvent } from "nostr-tools";
import { decryptFromBoard, encryptToBoard } from "taskify-core";
import { boardEvents, boardTagHash, deriveBoardKeyPair, runtimeHarness, START } from "./helpers/runtimeHarness.ts";

/**
 * The runtime's board definitions (kind 30300), through a real session on a loopback relay.
 *
 * A board's id is its key: whoever has it can derive the signer and decrypt everything on the
 * board. A definition's tags are public, so they carry only what the PWA and iOS put there (the
 * hashed board tag, the kind and the name). Lists and child boards go in the encrypted content.
 */

const BOARD_DEFINITION = 30300;
const BOARD = "board-lists-1";
const seconds = (ms: number) => Math.floor(ms / 1000);

/** A definition as another member's client publishes it (or, with `secretKey`, a stranger). */
async function definitionEvent(boardId: string, definition: {
  tags?: string[][];
  payload: Record<string, unknown>;
  createdAt: number;
  secretKey?: Uint8Array;
}): Promise<NostrEvent> {
  const tag = boardTagHash(boardId);
  return finalizeEvent({
    kind: BOARD_DEFINITION,
    created_at: definition.createdAt,
    content: await encryptToBoard(boardId, JSON.stringify(definition.payload)),
    tags: [["d", tag], ["b", tag], ...(definition.tags ?? [])],
  }, definition.secretKey ?? Buffer.from(deriveBoardKeyPair(boardId).skHex, "hex"));
}

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

test("creating a board publishes its definition under the board's key and adds it to the config", async () => {
  const h = await runtimeHarness();
  try {
    const { boardId } = await h.runtime.createBoard({ name: "Week plan", kind: "week" });
    assert.equal(boardId, "00000000-0000-4000-8000-000000000001");
    const entry = {
      id: boardId, name: "Week plan", kind: "week", columns: [], children: [],
      archived: false, hidden: false, clearCompletedDisabled: false, indexCardEnabled: false, hideChildBoardNames: false,
    };
    assert.deepEqual(h.config.boards.at(-1), entry);
    assert.equal(h.saved.length, 1);
    assert.deepEqual(h.saved[0].boards.at(-1), entry);

    const [definition, ...others] = boardEvents(h.relay, boardId, BOARD_DEFINITION);
    assert.equal(others.length, 0);
    assert.equal(definition.pubkey, deriveBoardKeyPair(boardId).pk);
    assert.deepEqual(await definitionPayload(definition, boardId), {
      name: "Week plan", kind: "week", columns: [], children: [],
      archived: false, hidden: false, clearCompletedDisabled: false, listIndex: false, hideBoardNames: false,
      shareSettings: {}, sortMode: null, sortDirection: null, version: 1,
    });
  } finally {
    await h.close();
  }
});

test("updating a board found by name changes the config and republishes the whole definition", async () => {
  const h = await runtimeHarness();
  try {
    const columns = [{ id: "todo", name: "Todo" }, { id: "later", name: "Later" }, { id: "soon", name: "Soon" }];
    const updated = await h.runtime.updateBoard("Groceries", {
      name: "Shopping", archived: true, indexCardEnabled: true, clearCompletedDisabled: true,
      shareSettings: { members: 2 }, sortMode: "due", sortDirection: "desc", columns,
    });
    assert.equal(updated?.id, BOARD);
    assert.equal(updated?.name, "Shopping");
    const entry = h.config.boards.find((board) => board.id === BOARD);
    assert.deepEqual(entry, updated);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].boards.find((board) => board.id === BOARD)?.name, "Shopping");

    const [definition] = boardEvents(h.relay, BOARD, BOARD_DEFINITION);
    assert.deepEqual(definition.tags, [["d", boardTagHash(BOARD)], ["b", boardTagHash(BOARD)], ["k", "lists"], ["name", "Shopping"], ["sort", "due", "desc"]]);
    assert.deepEqual(await definitionPayload(definition, BOARD), {
      name: "Shopping", kind: "lists", columns, children: [],
      archived: true, hidden: false, clearCompletedDisabled: true, listIndex: true, hideBoardNames: false,
      shareSettings: { members: 2 }, sortMode: "due", sortDirection: "desc", version: 1,
    });

    // Only a sort mode: the published direction defaults to ascending.
    await h.runtime.updateBoard("board-week-1", { sortMode: "priority" });
    assert.deepEqual(boardEvents(h.relay, "board-week-1", BOARD_DEFINITION)[0].tags.at(-1), ["sort", "priority", "asc"]);

    const before = h.relay.events.length;
    assert.equal(await h.runtime.updateBoard("Nowhere", { name: "X" }), null);
    assert.equal(h.relay.events.length, before, "nothing published");
  } finally {
    await h.close();
  }
});

test("syncing a board takes the newest definition into the config and saves it once", async () => {
  const h = await runtimeHarness();
  try {
    const t = seconds(START);
    h.relay.events.push(
      await definitionEvent(BOARD, { tags: [["k", "lists"], ["name", "Old name"]], payload: { columns: [{ id: "todo", name: "Todo" }] }, createdAt: t - 600 }),
      await definitionEvent(BOARD, {
        tags: [["k", "lists"], ["name", "Groceries \u001b[31m(shared)"]],
        payload: {
          columns: [{ id: "todo", name: "To buy" }, { id: "got", name: "Got" }], clearCompletedDisabled: true, listIndex: true,
          archived: true, hidden: true, shareSettings: { mode: "members" },
        },
        createdAt: t - 60,
      }),
    );
    const synced = await h.runtime.syncBoard(BOARD);
    assert.deepEqual(synced, { name: "Groceries [31m(shared)", kind: "lists", columns: [{ id: "todo", name: "To buy" }, { id: "got", name: "Got" }], children: undefined });
    const entry = h.config.boards.find((board) => board.id === BOARD);
    assert.equal(entry?.name, "Groceries [31m(shared)", "control characters from another member are removed");
    assert.deepEqual(entry?.columns, synced.columns);
    assert.equal(entry?.archived, true);
    assert.equal(entry?.hidden, true);
    assert.equal(entry?.indexCardEnabled, true);
    assert.equal(entry?.clearCompletedDisabled, true);
    assert.deepEqual(entry?.shareSettings, { mode: "members" });
    assert.equal(h.saved.length, 1);
  } finally {
    await h.close();
  }
});

test("syncing ignores definitions not signed with the board's key, and boards it doesn't know", async () => {
  const h = await runtimeHarness();
  try {
    h.relay.events.push(await definitionEvent(BOARD, {
      tags: [["k", "lists"], ["name", "Hijacked"]], payload: { columns: [] }, createdAt: seconds(START), secretKey: generateSecretKey(),
    }));
    assert.deepEqual(await h.runtime.syncBoard(BOARD), { name: undefined, kind: undefined, columns: undefined, children: undefined }, "no definition of its own: nothing changes");
    assert.equal(h.config.boards.find((board) => board.id === BOARD)?.name, "Groceries");
    assert.deepEqual(await h.runtime.syncBoard("not-in-config"), {});
    assert.equal(h.saved.length, 0);
  } finally {
    await h.close();
  }
});

test("board definitions are stamped with the runtime's clock, as tasks and events are", async () => {
  const h = await runtimeHarness();
  try {
    const { boardId } = await h.runtime.createBoard({ name: "Week plan", kind: "week" });
    assert.equal(boardEvents(h.relay, boardId, BOARD_DEFINITION)[0].created_at, seconds(START));
    h.advance(60_000);
    await h.runtime.updateBoard(boardId, { name: "Week plan 2" });
    assert.equal(boardEvents(h.relay, boardId, BOARD_DEFINITION)[0].created_at, seconds(START + 60_000));
  } finally {
    await h.close();
  }
});

test("syncing takes the sort from the newest definition, whatever order the relays return them in", async () => {
  const h = await runtimeHarness();
  try {
    const t = seconds(START);
    const newest = await definitionEvent(BOARD, { tags: [["k", "lists"], ["name", "Groceries"], ["sort", "due", "desc"]], payload: {}, createdAt: t - 60 });
    const older = await definitionEvent(BOARD, { tags: [["k", "lists"], ["name", "Groceries"], ["sort", "priority", "asc"]], payload: {}, createdAt: t - 600 });
    // A relay that missed the newer copy still serves the older one, and it arrives last.
    h.relay.events.push(newest, older);
    await h.runtime.syncBoard(BOARD);
    let entry = h.config.boards.find((board) => board.id === BOARD);
    assert.equal(entry?.sortMode, "due");
    assert.equal(entry?.sortDirection, "desc");

    // The PWA and iOS publish no sort: a newer definition from them leaves this device's sort.
    h.relay.events.push(await definitionEvent(BOARD, { tags: [["k", "lists"], ["name", "Groceries"]], payload: { columns: [] }, createdAt: t }));
    await h.runtime.syncBoard(BOARD);
    entry = h.config.boards.find((board) => board.id === BOARD);
    assert.equal(entry?.sortMode, "due");
    assert.equal(entry?.sortDirection, "desc");

    // Values no client writes are ignored rather than saved.
    h.relay.events.push(await definitionEvent(BOARD, { tags: [["k", "lists"], ["name", "Groceries"], ["sort", "random", "sideways"]], payload: {}, createdAt: t + 60 }));
    await h.runtime.syncBoard(BOARD);
    entry = h.config.boards.find((board) => board.id === BOARD);
    assert.equal(entry?.sortMode, "due");
    assert.equal(entry?.sortDirection, "desc");
  } finally {
    await h.close();
  }
});
