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
