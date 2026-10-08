import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dirname, "../dist/index.js");
test("completion command preserves explicit shells, detection, fallback, and errors", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-completions-"));
  const loader = 'data:text/javascript,' + encodeURIComponent(`import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();`);
  const run = (shell: string, args: string[] = []) => spawnSync(process.execPath, ["--import", loader, cli, "completions", ...args], { env: { ...process.env, SHELL: shell }, encoding: "utf8", timeout: 10000 });
  try {
    const scripts: Record<string, string> = {};
    for (const shell of ["zsh", "bash", "fish"]) {
      const result = run("/bin/unknown", ["--shell", shell]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /taskify/);
      scripts[shell] = result.stdout;
    }
    for (const shell of ["zsh", "bash"]) assert.equal(run(`/bin/${shell}`).stdout, scripts[shell]);
    const fallback = run("/bin/unknown");
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(fallback.stdout, scripts.zsh + "\n" + scripts.bash + "\n" + scripts.fish);
    const invalid = run("/bin/zsh", ["--shell", "invalid"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown shell/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("board names and task IDs from relays never run as shell commands", async () => {
  const { bashCompletion, zshCompletion, fishCompletion, posixSingleQuote, fishSingleQuote } = await import("../src/completions.ts");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-completion-names-"));
  const marker = path.join(fixture, "PWNED");
  const previousHome = process.env.HOME;
  try {
    mkdirSync(path.join(fixture, ".taskify-cli"));
    mkdirSync(path.join(fixture, ".config", "taskify"), { recursive: true });
    writeFileSync(path.join(fixture, ".taskify-cli", "config.json"), JSON.stringify({
      boards: [
        { id: "1", name: `Groceries $(touch ${marker})` },
        { id: "2", name: `Tick\`touch ${marker}\`` },
        { id: "3", name: "It's a \\" },
      ],
    }));
    writeFileSync(path.join(fixture, ".config", "taskify", "cache.json"), JSON.stringify({
      boards: { b: { fetchedAt: Date.now(), tasks: [
        { id: "`touch x`", status: "open", title: "x" },
        { id: "abcd1234-0000", status: "open", title: "ok" },
      ] } },
    }));
    process.env.HOME = fixture;
    const scriptPath = path.join(fixture, "taskify.bash");
    writeFileSync(scriptPath, bashCompletion());
    const run = spawnSync("bash", ["-c", `source "${scriptPath}"; cur=''; _taskify_boards; printf '%s\\n' "\${COMPREPLY[@]}"; _taskify_cached_task_ids; printf 'task:%s\\n' "\${COMPREPLY[@]}"`], {
      env: { ...process.env, HOME: fixture }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(marker), false, "a board name ran a command");
    assert.ok(run.stdout.includes(`Groceries $(touch ${marker})`));
    assert.ok(run.stdout.includes("task:abcd1234"));
    assert.ok(!run.stdout.includes("touch x"));
    assert.ok(zshCompletion().includes(posixSingleQuote(`Groceries $(touch ${marker})`)));
    assert.ok(fishCompletion().includes(fishSingleQuote("It's a \\")));
    assert.equal(fishSingleQuote("It's a \\"), "'It\\'s a \\\\'");
  } finally {
    process.env.HOME = previousHome;
    rmSync(fixture, { recursive: true, force: true });
  }
});
