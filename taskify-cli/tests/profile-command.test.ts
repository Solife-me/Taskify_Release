import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nip19 } from "nostr-tools";

const cli = path.resolve(import.meta.dirname, "../dist/index.js");
test("profile commands preserve creation, switching, renaming, masking, and removal guards", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-profile-command-"));
  const loader = 'data:text/javascript,' + encodeURIComponent(`import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();`);
  const env = { ...process.env }; delete env.TASKIFY_NSEC;
  const run = (args: string[], input?: string) => spawnSync(process.execPath, ["--import", loader, cli, "profile", ...args], { env, input, encoding: "utf8", timeout: 10000 });
  const config = () => JSON.parse(readFileSync(path.join(fixture, ".taskify-cli/config.json"), "utf8"));
  const key = nip19.nsecEncode(Uint8Array.from({ length: 32 }, () => 1));
  try {
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    for (const name of ["list", "add", "use", "show", "remove", "rename", "set-meta", "fetch-meta"]) assert.ok(help.stdout.includes(name), name);
    let result = run(["add", "work", "--nsec", key, "--relay", "wss://example.test"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(config().profiles.work.nsec, key);
    assert.deepEqual(config().profiles.work.relays, ["wss://example.test"]);
    assert.equal(run(["add", "work", "--nsec", key]).status, 1);
    assert.equal(run(["use", "missing"]).status, 1);
    assert.equal(run(["use", "work"]).status, 0);
    result = run(["show"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(key));
    assert.match(result.stdout, /active/);
    assert.equal(run(["remove", "work", "--force"]).status, 1);
    assert.equal(run(["rename", "work", "renamed"]).status, 0);
    assert.equal(config().activeProfile, "renamed");
    assert.equal(config().profiles.renamed.nsec, key);
    assert.equal(run(["use", "default"]).status, 0);
    assert.equal(run(["remove", "renamed", "--force"]).status, 0);
    assert.equal(config().profiles.renamed, undefined);
    // Piped input exercises the queued readline prompts without a terminal.
    result = run(["add", "piped"], `y\n${key}\n\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(config().profiles.piped.nsec, key);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
