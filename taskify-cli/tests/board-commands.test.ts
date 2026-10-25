import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../dist/cli.js";
import { captureConsole, configWithBoards, harnessDependencies, recordingRuntime } from "./helpers/cliHarness.ts";

/** C12-2 stage 5: board and list commands run through the real command tree. */

const syncedAt = Date.parse("2026-10-25T12:00:00Z");
const config = configWithBoards([
  { id: "board-1", name: "Harness Board 7f06", kind: "lists", columns: [{ id: "todo", name: "Todo" }, { id: "later", name: "Later" }, { id: "done", name: "Done" }], syncedAt },
  { id: "week-1", name: "Week", kind: "week", syncedAt },
  { id: "combo-1", name: "Combined", kind: "compound", children: ["board-1", "week-1"], syncedAt },
  { id: "empty-1", name: "Empty", kind: "lists", columns: [], syncedAt },
  { id: "dupes-1", name: "Dupes", kind: "lists", columns: [{ id: "d1", name: "Todo" }, { id: "d2", name: "todo" }], syncedAt },
]);
const now = () => new Date("2026-10-25T12:30:00Z");

function run(argv: string[], handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const { runtime, calls } = recordingRuntime({ updateBoard: async () => ({}), ...handlers });
  const harness = harnessDependencies(runtime, { now, randomUUID: () => "uuid-new" }, config);
  return captureConsole(() => runCli(["node", "taskify", ...argv], harness.dependencies))
    .then((result) => ({ ...result, calls, saved: harness.saved }));
}

test("board settings commands send the matching patch for a board named or by id", async () => {
  const cases: Array<[string[], Record<string, unknown>]> = [
    [["rename", "board-1", "Renamed"], { name: "Renamed" }],
    [["archive", "harness board 7f06"], { archived: true }],
    [["unarchive", "Harness Board 7f06"], { archived: false }],
    [["hide", "board-1"], { hidden: true }],
    [["unhide", "board-1"], { hidden: false }],
    [["index-card", "board-1", "on"], { indexCardEnabled: true }],
    [["index-card", "board-1", "0"], { indexCardEnabled: false }],
    [["share-settings", "board-1", '{"public":true}'], { shareSettings: { public: true } }],
    [["sort", "board-1", "due", "desc"], { sortMode: "due", sortDirection: "desc" }],
    [["sort", "board-1", "alpha"], { sortMode: "alpha", sortDirection: "asc" }],
  ];
  for (const [args, patch] of cases) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 0, args.join(" "));
    assert.deepEqual(result.calls, [["updateBoard", "board-1", patch], ["disconnect"]], args.join(" "));
  }
});

test("board settings commands reject bad input before changing anything", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["index-card", "board-1", "maybe"], /Invalid state: "maybe"/],
    [["sort", "board-1", "random"], /Invalid sort mode/],
    [["sort", "board-1", "due", "sideways"], /Invalid direction/],
    [["sort", "Nowhere", "due"], /Board not found: "Nowhere"/],
  ];
  for (const [args, message] of cases) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 1, args.join(" "));
    assert.ok(!result.calls.some((call) => call[0] === "updateBoard"), args.join(" "));
    assert.match(result.stderr.join("\n"), message);
  }

  for (const args of [["rename", "Nowhere", "X"], ["share-settings", "board-1", "[1,2]"]]) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 1, args.join(" "));
    assert.deepEqual(result.calls, [["disconnect"]], args.join(" "));
  }
});

test("board sort without a mode prints the current settings", async () => {
  const result = await run(["board", "sort", "board-1"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout.join("\n"), /Sort mode:\s+manual \(default\)/);
  assert.match(result.stdout.join("\n"), /Sort direction:\s+asc \(default\)/);
});

test("board clear-completed reports how many tasks the runtime removed", async () => {
  const result = await run(["board", "clear-completed", "board-1"], { clearCompleted: async () => 3 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [["clearCompleted", "board-1"], ["disconnect"]]);
  assert.match(result.stdout.join("\n"), /Cleared 3 completed task\(s\)/);
});

test("list column commands add, rename, delete and move columns by id or name", async () => {
  const todo = { id: "todo", name: "Todo" };
  const later = { id: "later", name: "Later" };
  const done = { id: "done", name: "Done" };
  const cases: Array<[string[], Array<{ id: string; name: string }>]> = [
    [["column-add", "board-1", "Someday"], [todo, later, done, { id: "uuid-new", name: "Someday" }]],
    [["column-rename", "board-1", "later", "Next"], [todo, { id: "later", name: "Next" }, done]],
    [["column-delete", "board-1", "TODO"], [later, done]],
    [["column-reorder", "board-1", "Done", "1"], [done, todo, later]],
    [["column-reorder", "board-1", "todo", "9"], [later, done, todo]],
  ];
  for (const [args, columns] of cases) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 0, args.join(" "));
    assert.deepEqual(result.calls, [["updateBoard", "board-1", { columns }], ["disconnect"]], args.join(" "));
  }
});

test("list column commands refuse week boards, unknown columns and bad positions", async () => {
  for (const args of [
    ["column-add", "Week", "Someday"],
    ["column-rename", "board-1", "nope", "X"],
    ["column-delete", "board-1", "nope"],
    ["column-reorder", "board-1", "todo", "0"],
  ]) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 1, args.join(" "));
    assert.deepEqual(result.calls, [["disconnect"]], args.join(" "));
  }
});

test("compound board child commands add, remove and move children", async () => {
  const cases: Array<[string[], string[]]> = [
    [["child-add", "Combined", "Empty"], ["board-1", "week-1", "empty-1"]],
    [["child-add", "Combined", "board-1"], ["board-1", "week-1"]],
    [["child-remove", "Combined", "Week"], ["board-1"]],
    [["child-reorder", "Combined", "week-1", "1"], ["week-1", "board-1"]],
  ];
  for (const [args, children] of cases) {
    const result = await run(["board", ...args]);
    assert.equal(result.status, 0, args.join(" "));
    assert.deepEqual(result.calls, [["updateBoard", "combo-1", { children }], ["disconnect"]], args.join(" "));
  }

  const notCompound = await run(["board", "child-add", "board-1", "Week"]);
  assert.equal(notCompound.status, 1);
  assert.deepEqual(notCompound.calls, [["disconnect"]]);
});

test("board columns lists the runtime's columns, falling back to the saved ones", async () => {
  const fresh = await run(["board", "columns", "Harness Board 7f06", "--json"], {
    syncBoard: async () => ({ columns: [{ id: "x", name: "Inbox" }] }),
  });
  assert.equal(fresh.status, 0);
  assert.deepEqual(fresh.calls, [["syncBoard", "board-1"], ["disconnect"]]);
  assert.deepEqual(JSON.parse(fresh.stdout.join("\n")), {
    board: { id: "board-1", name: "Harness Board 7f06", kind: "lists" },
    columns: [{ id: "x", name: "Inbox" }],
  });

  const offline = await run(["board", "columns", "board-1", "--json"], {
    syncBoard: async () => { throw new Error("relay unavailable"); },
  });
  assert.equal(offline.status, 0);
  assert.deepEqual(JSON.parse(offline.stdout.join("\n")).columns.map((c: { name: string }) => c.name), ["Todo", "Later", "Done"]);

  const missing = await run(["board", "columns", "Nowhere"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.stderr.join("\n"), /Board not found: "Nowhere"\. Known boards: Harness Board 7f06/);
});

test("board default and column-default save the selected profile's defaults", async () => {
  const board = await run(["board", "default", "Week"]);
  assert.equal(board.status, 0);
  assert.equal(board.saved.length, 1);
  assert.equal(board.saved[0].defaultBoard, "week-1");
  assert.deepEqual(board.saved[0].profiles.test.defaultLocation, { boardId: "week-1" });

  const column = await run(["board", "column-default", "board-1", "later"]);
  assert.equal(column.status, 0);
  assert.deepEqual(column.saved[0].defaultLocation, { boardId: "board-1", listId: "later" });
  assert.equal(column.saved[0].profiles.test.defaultColumn, "later");

  const cleared = await run(["board", "default", "--clear"]);
  assert.equal(cleared.status, 0);
  assert.equal(cleared.saved[0].defaultBoard, undefined);
  assert.equal(cleared.saved[0].profiles.test.defaultLocation, undefined);

  const unknownColumn = await run(["board", "column-default", "board-1", "Nope"]);
  assert.equal(unknownColumn.status, 1);
  assert.deepEqual(unknownColumn.saved, []);
});

test("board join saves the board with the command clock and syncs it; leave removes it", async () => {
  const joined = await run(["board", "join", "11111111-2222-3333-4444-555555555555", "--name", "Shared", "--relay", "wss://relay.example"], {
    syncBoard: async () => ({ kind: "lists", columns: [{ id: "c", name: "C" }] }),
  });
  assert.equal(joined.status, 0);
  const entry = joined.saved[0].boards.at(-1);
  assert.deepEqual(entry, {
    id: "11111111-2222-3333-4444-555555555555", name: "Shared", syncedAt: now().getTime(), relays: ["wss://relay.example"],
  });
  assert.deepEqual(joined.calls, [["syncBoard", "11111111-2222-3333-4444-555555555555"], ["disconnect"]]);

  const again = await run(["board", "join", "board-1"]);
  assert.equal(again.status, 0);
  assert.deepEqual(again.saved, []);
  assert.match(again.stdout.join("\n"), /Already on board Harness Board 7f06/);

  const left = await run(["board", "leave", "empty-1"]);
  assert.equal(left.status, 0);
  assert.ok(!left.saved[0].boards.some((b) => b.id === "empty-1"));

  const notThere = await run(["board", "leave", "nope"]);
  assert.equal(notThere.status, 1);
  assert.deepEqual(notThere.saved, []);
});

test("compound board create resolves children by name and publishes through the runtime", async () => {
  const result = await run(["board", "create", "Everything", "--kind", "compound", "--child", "Week"], {
    createBoard: async () => ({ boardId: "new-board" }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    ["createBoard", { name: "Everything", kind: "compound", columns: [], children: ["week-1"] }],
    ["disconnect"],
  ]);
  assert.match(result.stdout.join("\n"), /Created board: Everything\s+\[id: new-board\]\s+\[kind: compound\]/);

  const badKind = await run(["board", "create", "X", "--kind", "kanban"]);
  assert.equal(badKind.status, 1);
  assert.deepEqual(badKind.calls, []);
});

test("column options fail clearly on boards without lists or with ambiguous names", async () => {
  const empty = await run(["list", "--human", "--board", "Empty", "--column", "Todo"], { listTasks: async () => [] });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr.join("\n"), /Board "Empty" has no columns\/lists yet\./);
  assert.ok(!empty.calls.some((call) => call[0] === "listTasks"));

  const ambiguous = await run(["list", "--human", "--board", "Dupes", "--column", "TODO"], { listTasks: async () => [] });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr.join("\n"), /Ambiguous column "TODO" on board "Dupes"/);
  assert.match(ambiguous.stderr.join("\n"), /Use --column <id> to target deterministically\./);
});

test("task add --human confirms the column the task landed in", async () => {
  const result = await run(["add", "Pack", "--in", "Harness Board 7f06/Later", "--human"], {
    createTaskFull: async (input) => ({
      id: "uuid-new", boardId: "board-1", title: (input as { title: string }).title, column: "later", completed: false,
    }),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout.join("\n"), /Created: Pack\s+\[col: later \(Later\)\]/);
});

test("board create in a script makes a list board without waiting for input", { timeout: 5000 }, async () => {
  const asked: string[] = [];
  const { runtime, calls } = recordingRuntime({ createBoard: async () => ({ boardId: "new-board" }) });
  const { dependencies } = harnessDependencies(runtime, {
    randomUUID: () => "uuid-new",
    prompt: async (question: string) => { asked.push(question); return null; },
  }, config);

  const result = await captureConsole(() => runCli(["node", "taskify", "board", "create", "Groceries"], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [
    ["createBoard", { name: "Groceries", kind: "lists", columns: [], children: [] }],
    ["disconnect"],
  ]);
});

test("board create takes list names from --columns, or asks when run interactively", { timeout: 5000 }, async () => {
  let n = 0;
  const ids = () => `col-${++n}`;
  const named = recordingRuntime({ createBoard: async () => ({ boardId: "b" }) });
  const flagged = await captureConsole(() => runCli([
    "node", "taskify", "board", "create", "Trip", "--columns", "Pack, Book,, Go",
  ], harnessDependencies(named.runtime, { randomUUID: ids, prompt: async () => { throw new Error("asked"); } }, config).dependencies));
  assert.equal(flagged.status, 0);
  assert.deepEqual(named.calls[0], ["createBoard", {
    name: "Trip", kind: "lists", children: [],
    columns: [{ id: "col-1", name: "Pack" }, { id: "col-2", name: "Book" }, { id: "col-3", name: "Go" }],
  }]);

  const asked: string[] = [];
  const interactive = recordingRuntime({ createBoard: async () => ({ boardId: "b" }) });
  const prompted = await captureConsole(() => runCli([
    "node", "taskify", "board", "create", "Home",
  ], harnessDependencies(interactive.runtime, {
    randomUUID: ids, prompt: async (question: string) => { asked.push(question); return "Chores, Repairs"; },
  }, config).dependencies));
  assert.equal(prompted.status, 0);
  assert.equal(asked.length, 1);
  assert.deepEqual((interactive.calls[0][1] as { columns: Array<{ name: string }> }).columns.map((c) => c.name), ["Chores", "Repairs"]);
});

test("boards and board list are one command: same refresh, same output", async () => {
  const day = 24 * 60 * 60 * 1000;
  const boards = configWithBoards([
    { id: "fresh-1", name: "Fresh", kind: "lists", syncedAt: now().getTime() - 60_000, relays: ["wss://relay.example"] },
    { id: "old-1", name: "Old", kind: "lists", syncedAt: now().getTime() - 2 * day },
    { id: "abcdef12", name: "abcdef12", syncedAt: now().getTime() },
  ]);
  const outputs: string[][] = [];
  for (const argv of [["board", "list"], ["boards"]]) {
    const { runtime, calls } = recordingRuntime({
      syncBoard: async (id) => ({ name: id === "abcdef12" ? "Named" : undefined, kind: "lists", columns: [] }),
    });
    const harness = harnessDependencies(runtime, { now }, boards);
    const result = await captureConsole(() => runCli(["node", "taskify", ...argv], harness.dependencies));
    assert.equal(result.status, 0, argv.join(" "));
    assert.deepEqual(calls, [["syncBoard", "old-1"], ["syncBoard", "abcdef12"], ["disconnect"]], argv.join(" "));
    assert.equal(harness.saved[0].boards.find((b) => b.id === "old-1")?.syncedAt, now().getTime(), argv.join(" "));
    outputs.push(result.stdout);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.match(outputs[0].join("\n"), /wss:\/\/relay\.example/);
  assert.match(outputs[0].join("\n"), /Named/);
});

test("boards --json lists each board's id, name, kind, relays and lists", async () => {
  const { runtime } = recordingRuntime({});
  const result = await captureConsole(() => runCli(["node", "taskify", "boards", "--json"],
    harnessDependencies(runtime, { now }, config).dependencies));
  assert.equal(result.status, 0);
  const listed = JSON.parse(result.stdout.join("\n")) as Array<Record<string, unknown>>;
  assert.deepEqual(listed[0], {
    id: "board-1", name: "Harness Board 7f06", kind: "lists", relays: [],
    columns: [{ id: "todo", name: "Todo" }, { id: "later", name: "Later" }, { id: "done", name: "Done" }],
  });
  assert.deepEqual(listed.map((b) => b.id), ["board-1", "week-1", "combo-1", "empty-1", "dupes-1"]);
});
