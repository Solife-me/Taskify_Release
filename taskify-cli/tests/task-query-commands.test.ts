import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../dist/cli.js";
import { captureConsole, harnessDependencies, harnessPubkey, recordingRuntime } from "./helpers/cliHarness.ts";

/** C12-2 stage 4: list, upcoming, show and search run through the real command tree. */

type Envelope = { ok: boolean; command: string; data: Record<string, unknown>; error?: { code: string } };

function task(id: string, fields: Record<string, unknown> = {}) {
  return { id, boardId: "board-1", title: `Task ${id}`, column: "todo", completed: false, ...fields };
}

test("list returns the location's open tasks as a task.list envelope, then disconnects", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => [task("a"), task("b")],
  });
  const { dependencies, output } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "list", "--in", "Harness Board 7f06/Todo",
  ], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [
    ["listTasks", { boardId: "board-1", status: "open", columnId: "todo", refresh: false, noCache: false }],
    ["disconnect"],
  ]);
  const envelope = output[0] as Envelope;
  assert.equal(envelope.command, "task.list");
  assert.equal(envelope.data.count, 2);
  assert.equal((envelope.data.location as { listName: string }).listName, "Todo");
});

test("list forwards --status, --all, --refresh and --no-cache to the runtime", async () => {
  const { runtime, calls } = recordingRuntime({ listTasks: async () => [] });
  const { dependencies } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "list", "--in", "Harness Board 7f06/Todo",
    "--status", "any", "--all", "--refresh", "--no-cache",
  ], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls[0], [
    "listTasks", { boardId: "board-1", status: "any", columnId: undefined, refresh: true, noCache: true },
  ]);
});

test("list --mine keeps only tasks assigned to the active profile", async () => {
  const { runtime } = recordingRuntime({
    listTasks: async () => [
      task("mine", { assignees: [{ pubkey: harnessPubkey.toUpperCase() }] }),
      task("legacy-mine", { assignees: [harnessPubkey] }),
      task("theirs", { assignees: [{ pubkey: "f".repeat(64) }] }),
      task("nobody"),
    ],
  });
  const { dependencies, output } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli(["node", "taskify", "list", "--mine"], dependencies));

  assert.equal(result.status, 0);
  const data = (output[0] as Envelope).data;
  assert.deepEqual((data.tasks as Array<{ id: string }>).map((t) => t.id), ["mine", "legacy-mine"]);
  assert.equal(data.count, 2);
});

test("list rejects an unknown --status without reading tasks, and still disconnects", async () => {
  const { runtime, calls } = recordingRuntime({ listTasks: async () => [] });
  const { dependencies, output } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "list", "--status", "someday",
  ], dependencies));

  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [["disconnect"]]);
  const envelope = output[0] as Envelope;
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, "task.list");
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
});

test("list --human resolves --board and --column and renders the tasks", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => [task("a", { title: "Water the plants" })],
  });
  const { dependencies } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "list", "--human", "--board", "Harness Board 7f06", "--column", "Later",
  ], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [
    ["listTasks", { boardId: "board-1", status: "open", columnId: "later", refresh: false, noCache: false }],
    ["disconnect"],
  ]);
  assert.match(result.stdout.join("\n"), /Water the plants/);
});

test("list --human fails on a column the board doesn't have, without reading tasks", async () => {
  const { runtime, calls } = recordingRuntime({ listTasks: async () => [] });
  const { dependencies } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "list", "--human", "--board", "Harness Board 7f06", "--column", "Someday",
  ], dependencies));

  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [["disconnect"]]);
  assert.match(result.stderr.join("\n"), /Someday/);
});

test("upcoming returns open dated tasks within 14 days, by date then priority", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => [
      task("later-low", { dueDateEnabled: true, dueISO: "2026-10-28", priority: 1 }),
      task("today", { dueDateEnabled: true, dueISO: "2026-10-25" }),
      task("later-high", { dueDateEnabled: true, dueISO: "2026-10-28", priority: 3 }),
      task("too-far", { dueDateEnabled: true, dueISO: "2026-11-14" }),
      task("past", { dueDateEnabled: true, dueISO: "2026-10-24" }),
      task("undated", { dueDateEnabled: false, dueISO: "2026-10-26" }),
    ],
  });
  const { dependencies } = harnessDependencies(runtime, { now: () => new Date("2026-10-25T12:00:00Z") });

  const result = await captureConsole(() => runCli(["node", "taskify", "upcoming", "--json"], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [["listTasks", { boardId: undefined, status: "open" }], ["disconnect"]]);
  const ids = (JSON.parse(result.stdout.join("\n")) as Array<{ id: string }>).map((t) => t.id);
  assert.deepEqual(ids, ["today", "later-high", "later-low"]);
});

test("upcoming --days widens the window and --board scopes the read", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => [task("too-far", { dueDateEnabled: true, dueISO: "2026-11-14" })],
  });
  const { dependencies } = harnessDependencies(runtime, { now: () => new Date("2026-10-25T12:00:00Z") });

  const result = await captureConsole(() => runCli([
    "node", "taskify", "upcoming", "--days", "30", "--board", "Harness Board 7f06", "--json",
  ], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls[0], ["listTasks", { boardId: "board-1", status: "open" }]);
  assert.deepEqual((JSON.parse(result.stdout.join("\n")) as Array<{ id: string }>).map((t) => t.id), ["too-far"]);
});

test("upcoming groups human output under each date, or says nothing is due", async () => {
  const now = () => new Date("2026-10-25T12:00:00Z");
  const { runtime } = recordingRuntime({
    listTasks: async () => [
      task("a", { title: "Pay rent", dueDateEnabled: true, dueISO: "2026-10-26" }),
      task("b", { title: "Call mum", dueDateEnabled: true, dueISO: "2026-10-27" }),
    ],
  });
  const grouped = await captureConsole(() => runCli(["node", "taskify", "upcoming"], harnessDependencies(runtime, { now }).dependencies));
  assert.equal(grouped.status, 0);
  const text = grouped.stdout.join("\n");
  assert.ok(text.indexOf("2026-10-26") < text.indexOf("Pay rent"));
  assert.ok(text.indexOf("Pay rent") < text.indexOf("2026-10-27"));
  assert.ok(text.indexOf("2026-10-27") < text.indexOf("Call mum"));

  const empty = recordingRuntime({ listTasks: async () => [] });
  const none = await captureConsole(() => runCli(["node", "taskify", "upcoming", "--days", "3"], harnessDependencies(empty.runtime, { now }).dependencies));
  assert.equal(none.status, 0);
  assert.match(none.stdout.join("\n"), /No tasks due in the next 3 days\./);
});

test("upcoming reports a runtime failure and still disconnects", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => { throw new Error("relay unavailable"); },
  });
  const { dependencies } = harnessDependencies(runtime, { now: () => new Date("2026-10-25T12:00:00Z") });

  const result = await captureConsole(() => runCli(["node", "taskify", "upcoming"], dependencies));

  assert.equal(result.status, 1);
  assert.deepEqual(calls.at(-1), ["disconnect"]);
  assert.match(result.stderr.join("\n"), /relay unavailable/);
});

test("show returns the task with its board and list names as task.get", async () => {
  const { runtime, calls } = recordingRuntime({
    getTask: async () => task("task-1", { column: "later" }),
  });
  const { dependencies, output } = harnessDependencies(runtime);

  const scoped = await captureConsole(() => runCli([
    "node", "taskify", "show", "task-1", "--in", "Harness Board 7f06",
  ], dependencies));
  assert.equal(scoped.status, 0);
  assert.deepEqual(calls, [["getTask", "task-1", "board-1"], ["disconnect"]]);
  const envelope = output[0] as Envelope;
  assert.equal(envelope.command, "task.get");
  assert.deepEqual(envelope.data.location, {
    boardId: "board-1", boardName: "Harness Board 7f06", listId: "later", listName: "Later",
  });

  calls.length = 0;
  const unscoped = await captureConsole(() => runCli(["node", "taskify", "show", "task-1"], dependencies));
  assert.equal(unscoped.status, 0);
  assert.deepEqual(calls[0], ["getTask", "task-1", undefined]);
});

test("show reports a missing task as NOT_FOUND and still disconnects", async () => {
  const { runtime, calls } = recordingRuntime({ getTask: async () => null });
  const { dependencies, output } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli(["node", "taskify", "show", "missing-1"], dependencies));

  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [["getTask", "missing-1", undefined], ["disconnect"]]);
  const envelope = output[0] as Envelope;
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "NOT_FOUND");
});

test("show --human renders the task card with this device's reminders", async () => {
  const { runtime, calls } = recordingRuntime({
    getTask: async () => task("task-1", { title: "Renew passport" }),
    getLocalReminders: () => [],
  });
  const { dependencies } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli(["node", "taskify", "show", "task-1", "--human"], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls.map((call) => call[0]), ["getTask", "getLocalReminders", "disconnect"]);
  assert.deepEqual(calls[1], ["getLocalReminders", "task-1"]);
  assert.match(result.stdout.join("\n"), /Renew passport/);
});

test("search matches titles and notes case-insensitively across every status", async () => {
  const { runtime, calls } = recordingRuntime({
    listTasks: async () => [
      task("title", { title: "Book DENTIST", completed: true }),
      task("note", { title: "Health", note: "ask the dentist about x-rays" }),
      task("other", { title: "Groceries" }),
    ],
  });
  const { dependencies, output } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli(["node", "taskify", "search", "dentist"], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [
    ["listTasks", { boardId: undefined, status: "any", columnId: undefined }],
    ["disconnect"],
  ]);
  const envelope = output[0] as Envelope;
  assert.equal(envelope.command, "task.search");
  assert.equal(envelope.data.query, "dentist");
  assert.equal(envelope.data.count, 2);
  assert.deepEqual((envelope.data.tasks as Array<{ id: string }>).map((t) => t.id), ["title", "note"]);
});

test("search --in scopes the read and --human says when nothing matches", async () => {
  const { runtime, calls } = recordingRuntime({ listTasks: async () => [task("other", { title: "Groceries" })] });
  const { dependencies } = harnessDependencies(runtime);

  const result = await captureConsole(() => runCli([
    "node", "taskify", "search", "dentist", "--in", "Harness Board 7f06/Todo", "--human",
  ], dependencies));

  assert.equal(result.status, 0);
  assert.deepEqual(calls[0], ["listTasks", { boardId: "board-1", status: "any", columnId: "todo" }]);
  assert.match(result.stdout.join("\n"), /No tasks matching "dentist"\./);
});
