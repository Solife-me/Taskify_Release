import { getPublicKey, nip19 } from "nostr-tools";
import type { CliDependencies } from "../../dist/cli.js";
import type { TaskifyConfig } from "../../src/config.ts";

const secretKey = new Uint8Array(32).fill(1);

/** The harness profile's public key, for assignee filters. */
export const harnessPubkey = getPublicKey(secretKey);

const profile = {
  nsec: nip19.nsecEncode(secretKey),
  relays: [],
  defaultBoard: "board-1",
  defaultLocation: { boardId: "board-1", listId: "todo" },
  trustedNpubs: [],
  securityMode: "moderate" as const,
  securityEnabled: true,
  boards: [{
    id: "board-1",
    name: "Harness Board 7f06",
    kind: "lists" as const,
    columns: [{ id: "todo", name: "Todo" }, { id: "later", name: "Later" }],
    syncedAt: Date.parse("2026-10-25T12:00:00Z"),
  }],
  taskReminders: {},
};

export const harnessConfig: TaskifyConfig = {
  ...profile,
  activeProfile: "test",
  selectedProfile: "test",
  profiles: { test: profile },
};

/** Runs a CLI invocation with console output captured, returning its status and lines. */
export async function captureConsole(run: () => Promise<number>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    return { status: await run(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

/** A recording runtime: each method records its call, then answers from `handlers`. */
export function recordingRuntime(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls: unknown[][] = [];
  const runtime: Record<string, (...args: unknown[]) => unknown> = {
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    runtime[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return handler(...args);
    };
  }
  return { runtime, calls };
}

/** Dependencies that run commands against `runtime`, with agent JSON recorded in `output`. */
export function harnessDependencies(runtime: object, overrides: CliDependencies = {}) {
  const output: unknown[] = [];
  const dependencies: CliDependencies = {
    version: "test",
    loadConfig: async () => harnessConfig,
    writeAgentJson: (value) => output.push(value),
    createRuntime: (() => runtime) as NonNullable<CliDependencies["createRuntime"]>,
    ...overrides,
  };
  return { dependencies, output };
}
