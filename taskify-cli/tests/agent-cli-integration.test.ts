import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

type CommandResult = { code: number | null; stdout: string; stderr: string };

async function fixtureHome(profile: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "taskify-agent-cli-"));
  const directory = join(home, ".taskify-cli");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify({
    activeProfile: "default",
    profiles: { default: profile },
  }), { mode: 0o600 });
  return home;
}

async function runCli(home: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("dist/index.js"), ...args], {
      env: { ...process.env, HOME: home, TASKIFY_NSEC: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

const baseProfile = {
  relays: ["wss://relay.example"],
  defaultBoard: "",
  trustedNpubs: [],
  securityMode: "moderate",
  securityEnabled: true,
  taskReminders: {},
};

test("context emits one JSON envelope with canonical board/list paths and no secrets", async () => {
  const home = await fixtureHome({
    ...baseProfile,
    nsec: "nsec-secret-that-must-never-appear",
    defaultLocation: { boardId: "board-a", listId: "list-a" },
    boards: [{
      id: "board-a",
      name: "Product Launch",
      kind: "lists",
      columns: [{ id: "list-a", name: "Needs Review" }],
    }],
  });

  const result = await runCli(home, ["context"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.doesNotMatch(result.stdout, /nsec-secret/);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "context");
  assert.equal(envelope.data.defaultLocation.path, "Product Launch/Needs Review");
  assert.equal(envelope.data.boards[0].lists[0].path, "Product Launch/Needs Review");
});

test("agent add fails ambiguous board selection as JSON without prompting or connecting", async () => {
  const home = await fixtureHome({
    ...baseProfile,
    boards: [
      { id: "board-a", name: "Personal", kind: "lists", columns: [{ id: "todo-a", name: "Todo" }] },
      { id: "board-b", name: "Work", kind: "lists", columns: [{ id: "todo-b", name: "Todo" }] },
    ],
  });

  const result = await runCli(home, ["add", "Prepare status report"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, "task.create");
  assert.equal(envelope.error.code, "AMBIGUOUS_BOARD");
  assert.deepEqual(
    envelope.error.details.candidates.map((candidate: { path: string }) => candidate.path),
    ["Personal", "Work"],
  );
});

test("agent add reports validation errors in its JSON contract", async () => {
  const home = await fixtureHome({
    ...baseProfile,
    boards: [{ id: "board-a", name: "Personal", kind: "lists", columns: [{ id: "todo", name: "Todo" }] }],
  });

  const result = await runCli(home, ["add", "Prepare status report", "--due", "tomorrow"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "VALIDATION_ERROR");
  assert.match(envelope.error.message, /YYYY-MM-DD/);
});

test("agent add reports a missing identity in its JSON contract", async () => {
  const home = await fixtureHome({
    ...baseProfile,
    defaultLocation: { boardId: "board-a", listId: "todo" },
    boards: [{ id: "board-a", name: "Personal", kind: "lists", columns: [{ id: "todo", name: "Todo" }] }],
  });

  const result = await runCli(home, ["add", "Prepare status report"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "CONFIG_INVALID");
  assert.match(envelope.error.message, /nsec|identity/i);
});

test("core command startup errors still use the JSON failure contract", async () => {
  const home = await fixtureHome(baseProfile);
  await writeFile(join(home, ".taskify-cli", "config.json"), "{broken json", { mode: 0o600 });

  const result = await runCli(home, ["context"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, "taskify");
  assert.equal(envelope.error.code, "CONFIG_INVALID");
});
