import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dirname, "../dist/index.js");
test("config registration preserves selected-profile mutations and redacted diagnostics", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-config-command-"));
  const loader = 'data:text/javascript,' + encodeURIComponent(`
    import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();
    globalThis.WebSocket = class {
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
    };
  `);
  const dir = path.join(fixture, ".taskify-cli");
  mkdirSync(dir);
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ activeProfile: "default", profiles: { default: {}, work: {} } }));
  const env = { ...process.env };
  delete env.TASKIFY_NSEC;
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", loader, cli, "-P", "work", "config", ...args], { env, encoding: "utf8", timeout: 10000 });
  const config = () => JSON.parse(readFileSync(file, "utf8"));
  try {
    const help = run("set", "--help");
    assert.equal(help.status, 0, help.stderr);
    for (const name of ["nsec", "relay", "file-server", "encrypted-file-server", "default-list"]) assert.ok(help.stdout.includes(name));
    for (const [key, value] of [["file-server", " https://files.example.test "], ["encrypted-file-server", " https://private.example.test "]]) {
      const result = run("set", key, value);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(config().profiles.work.fileStorageServer, "https://files.example.test");
    assert.equal(config().profiles.work.encryptedFileStorageServer, "https://private.example.test");
    for (let i = 0; i < 2; i++) assert.equal(run("set", "relay", "wss://example.test").status, 0);
    assert.equal(config().profiles.work.relays.filter((url: string) => url === "wss://example.test").length, 1);
    assert.equal(run("set", "nsec", "invalid").status, 1);
    assert.equal(config().profiles.work.nsec, undefined);
    // The setter historically checks the prefix only. This is a dummy value, not a key.
    assert.equal(run("set", "nsec", "nsec1-fixture-secret").status, 0);
    const show = run("show");
    assert.equal(show.status, 0, show.stderr);
    assert.ok(!show.stdout.includes("nsec1-fixture-secret"));
    assert.match(show.stdout, /connected/);
    const missing = run("set", "default-list", "missing", "missing");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Board not found/);
    assert.deepEqual(config().profiles.default, {});
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
