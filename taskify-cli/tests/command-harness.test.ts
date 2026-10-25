import test from "node:test";
import assert from "node:assert/strict";
import { buildProgram, runCli, type CliDependencies } from "../dist/cli.js";
import type { TaskifyConfig } from "../src/config.ts";

const profile = {
  relays: [],
  defaultBoard: "board-1",
  trustedNpubs: [],
  securityMode: "moderate" as const,
  securityEnabled: true,
  boards: [{ id: "board-1", name: "Harness Board 7f06" }],
  taskReminders: {},
};

const config: TaskifyConfig = {
  ...profile,
  activeProfile: "test",
  selectedProfile: "test",
  profiles: { test: profile },
};

async function captureConsole(run: () => Promise<number>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    return { status: await run(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("buildProgram exposes the real command tree without parsing or exiting", () => {
  const program = buildProgram({ version: "test" });
  assert.ok(program.commands.some((command) => command.name() === "event"));
  assert.ok(program.commands.some((command) => command.name() === "board"));
});

test("runCli drives an event action through an injected runtime and awaits cleanup", async () => {
  const calls: string[] = [];
  const runtime = {
    async listEvents(options: { boardId?: string }) {
      calls.push(`listEvents:${options.boardId ?? "all"}`);
      return [{
        id: "event-1",
        boardId: "board-1",
        boardName: "Harness Board 7f06",
        title: "Planning",
        kind: "date" as const,
        startDate: "2026-10-25",
      }];
    },
    async disconnect() {
      calls.push("disconnect");
    },
  };
  const dependencies: CliDependencies = {
    version: "test",
    loadConfig: async () => config,
    createRuntime: (() => {
      calls.push("createRuntime");
      return runtime;
    }) as NonNullable<CliDependencies["createRuntime"]>,
  };

  const result = await captureConsole(() => runCli([
    "node", "taskify", "event", "list", "--board", "Harness Board 7f06", "--json",
  ], dependencies));
  assert.equal(result.status, 0);
  assert.deepEqual(calls, ["createRuntime", "listEvents:board-1", "disconnect"]);
  assert.equal(JSON.parse(result.stdout.join("\n"))[0].title, "Planning");
  assert.deepEqual(result.stderr, []);
});

test("runCli preserves event failure status and disconnects the injected runtime", async () => {
  const calls: string[] = [];
  const runtime = {
    async listEvents() {
      calls.push("listEvents");
      throw new Error("relay unavailable");
    },
    async disconnect() {
      calls.push("disconnect");
    },
  };
  const dependencies: CliDependencies = {
    version: "test",
    loadConfig: async () => config,
    createRuntime: (() => {
      calls.push("createRuntime");
      return runtime;
    }) as NonNullable<CliDependencies["createRuntime"]>,
  };

  const result = await captureConsole(() => runCli(["node", "taskify", "event", "list", "--json"], dependencies));
  assert.equal(result.status, 1);
  assert.deepEqual(calls, ["createRuntime", "listEvents", "disconnect"]);
  assert.match(result.stderr.join("\n"), /relay unavailable/);
});

test("event command registration exposes CRUD and JSON deletion without source inspection", () => {
  const program = buildProgram({ version: "test" });
  const event = program.commands.find((command) => command.name() === "event");
  assert.ok(event);
  assert.deepEqual(
    event.commands.map((command) => command.name()).filter((name) => ["list", "add", "show", "update", "delete"].includes(name)),
    ["list", "add", "show", "update", "delete"],
  );
  const deleteCommand = event.commands.find((command) => command.name() === "delete");
  assert.ok(deleteCommand?.options.some((option) => option.long === "--json"));
});

test("event update and delete pass optional board scope and render returned records", async () => {
  const calls: unknown[][] = [];
  const runtime = {
    async updateEvent(...args: unknown[]) {
      calls.push(["updateEvent", ...args]);
      return {
        id: "event-1", boardId: "board-1", boardName: "Harness Board 7f06",
        title: "Renamed", kind: "date" as const, startDate: "2026-10-25",
      };
    },
    async deleteEvent(...args: unknown[]) {
      calls.push(["deleteEvent", ...args]);
      return {
        id: "event-1", boardId: "board-1", boardName: "Harness Board 7f06",
        title: "Renamed", kind: "date" as const, startDate: "2026-10-25",
      };
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
  const dependencies: CliDependencies = {
    version: "test",
    loadConfig: async () => config,
    createRuntime: (() => runtime) as NonNullable<CliDependencies["createRuntime"]>,
  };

  const updated = await captureConsole(() => runCli([
    "node", "taskify", "event", "update", "event-1", "--title", "Renamed", "--json",
  ], dependencies));
  assert.equal(updated.status, 0);
  assert.equal(JSON.parse(updated.stdout.join("\n")).title, "Renamed");
  assert.deepEqual(calls[0], ["updateEvent", "event-1", undefined, {
    title: "Renamed",
    description: undefined,
    startDate: undefined,
    endDate: undefined,
    startISO: undefined,
    endISO: undefined,
    startTzid: undefined,
    endTzid: undefined,
    columnId: undefined,
    recurrence: undefined,
    reminders: undefined,
    participants: undefined,
    documents: undefined,
  }]);
  assert.deepEqual(calls[1], ["disconnect"]);

  calls.length = 0;
  const deleted = await captureConsole(() => runCli([
    "node", "taskify", "event", "delete", "event-1", "--board", "Harness Board 7f06", "--json",
  ], dependencies));
  assert.equal(deleted.status, 0);
  assert.equal(JSON.parse(deleted.stdout.join("\n")).id, "event-1");
  assert.deepEqual(calls, [
    ["deleteEvent", "event-1", "board-1"],
    ["disconnect"],
  ]);
});

test("event list and show human output include board context from runtime records", async () => {
  const runtime = {
    async listEvents() {
      return [{
        id: "event-1", boardId: "board-1", boardName: "Harness Board 7f06",
        title: "Planning", kind: "date" as const, startDate: "2026-10-25",
      }];
    },
    async getEvent() {
      return {
        id: "event-1", boardId: "board-1", boardName: "Harness Board 7f06",
        title: "Planning", kind: "date" as const, startDate: "2026-10-25",
      };
    },
    async disconnect() {},
  };
  const dependencies: CliDependencies = {
    version: "test",
    loadConfig: async () => config,
    createRuntime: (() => runtime) as NonNullable<CliDependencies["createRuntime"]>,
  };

  const listed = await captureConsole(() => runCli(["node", "taskify", "event", "list"], dependencies));
  assert.equal(listed.status, 0);
  assert.match(listed.stdout.join("\n"), /Planning \[Harness Board 7f06\]/);

  const shown = await captureConsole(() => runCli(["node", "taskify", "event", "show", "event-1"], dependencies));
  assert.equal(shown.status, 0);
  assert.match(shown.stdout.join("\n"), /board: Harness Board 7f06/);
});
