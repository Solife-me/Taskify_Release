import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/index.js");

function runWithExitTrace(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "taskify-command-lifecycle-"));
  const configDir = join(home, ".taskify-cli");
  const trace = join(home, "lifecycle.log");
  const preload = join(home, "trace-lifecycle.mjs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    activeProfile: "default",
    profiles: {
      default: {
        relays: [],
        boards: [],
        defaultBoard: "",
        trustedNpubs: [],
        securityMode: "moderate",
        securityEnabled: true,
        taskReminders: {},
      },
    },
  }));
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    const trace = ${JSON.stringify(trace)};
    const exit = process.exit.bind(process);
    process.exit = ((code = 0) => {
      appendFileSync(trace, \`process.exit:\${code}\\n\`);
      process.exitCode = code;
      setTimeout(() => exit(code), 50);
    });
  `);

  try {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, cli, ...args], {
      env: { ...process.env, HOME: home, TASKIFY_NSEC: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { result, exits: readFileSync(trace, "utf8").trim().split("\n") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("event commands return control before the executable performs the only hard exit", () => {
  const { result, exits } = runWithExitTrace(["event", "list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(exits, ["process.exit:0"]);
});

test("task commands return control on failure before the executable performs the only hard exit", () => {
  const { result, exits } = runWithExitTrace(["list"]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(exits, ["process.exit:1"]);
});

test("board commands return control before the executable performs the only hard exit", () => {
  const { result, exits } = runWithExitTrace(["board", "list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(exits, ["process.exit:0"]);
});

test("collaboration commands return control on validation failure before the executable exits", () => {
  const { result, exits } = runWithExitTrace(["share", "board", "missing-board", "0".repeat(64)]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(exits, ["process.exit:1"]);
});

test("identity commands return control before the executable performs the only hard exit", () => {
  const { result, exits } = runWithExitTrace(["profile", "list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(exits, ["process.exit:0"]);
});

test("local commands return control before the executable performs the only hard exit", () => {
  const { result, exits } = runWithExitTrace(["cache", "status"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(exits, ["process.exit:0"]);
});

test("only the executable boundary may hard-exit", () => {
  const sourceRoot = resolve("src");
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return visit(path);
    return entry.isFile() && path.endsWith(".ts") && path !== join(sourceRoot, "index.ts") ? [path] : [];
  });
  const offenders = visit(sourceRoot).filter((path) => readFileSync(path, "utf8").includes("process.exit("));
  assert.deepEqual(offenders, []);
});

test("reported helper failures unwind without a duplicate error envelope", () => {
  const { result, exits } = runWithExitTrace(["inbox", "triage", "12345678", "--due", "not-a-date", "--yes"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Invalid --due format/);
  assert.equal(result.stdout, "");
  assert.deepEqual(exits, ["process.exit:1"]);
});

test("Commander help returns through the executable exit boundary", () => {
  const { result, exits } = runWithExitTrace(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: taskify/);
  assert.deepEqual(exits, ["process.exit:0"]);
});
