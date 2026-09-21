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
