import test from "node:test";
import { nip19 } from "nostr-tools";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const cli = path.resolve(import.meta.dirname, "../dist/index.js");

for (const [command, entries] of [
  ["bot", ["publish-commands", "show-commands"]],
  ["contact", ["list", "show", "add", "remove", "fetch", "sync"]],
  ["trust", ["add", "remove", "list"]],
  ["relay", ["status", "list", "add", "remove"]],
  ["cache", ["clear", "status"]],
] as const) {
  test(`${command} commands remain reachable through the bundled entry point`, () => {
    const result = spawnSync(process.execPath, [cli, command, "--help"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    for (const entry of entries) assert.ok(result.stdout.includes(entry), result.stdout);
    assert.doesNotMatch(result.stderr, /onboarding|Fetching|Publishing/i);
  });
}

for (const [args, options] of [
  [["bot", "publish-commands"], ["[file]", "--json"]],
  [["bot", "show-commands"], ["[npub]", "--json"]],
  [["contact", "add"], ["<npub>", "--name", "--nip05"]],
  [["contact", "sync"], ["--pull", "--json"]],
] as const) {
  test(`${args.join(" ")} retains its arguments and options`, () => {
    const result = spawnSync(process.execPath, [cli, ...args, "--help"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    for (const option of options) assert.ok(result.stdout.includes(option), result.stdout);
  });
}

// Redirect only the child process's homedir API, so no developer profile is read or written.
test("contact actions preserve profile selection, persistence, lookup, and error exits", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-contact-actions-"));
  const loader = path.join(fixture, "isolate.mjs");
  writeFileSync(loader, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();`);
  mkdirSync(path.join(fixture, ".taskify-cli"));
  writeFileSync(path.join(fixture, ".taskify-cli/config.json"), JSON.stringify({ activeProfile: "default", profiles: { default: {}, work: {} } }));
  const env = { ...process.env };
  delete env.TASKIFY_NSEC;
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, cli, ...args], { env, encoding: "utf8", timeout: 10000 });
  try {
    // Public test key only; these local commands never contact relays.
    const pubkey = "ab".repeat(32);
    const npub = nip19.npubEncode(pubkey);
    let result = run("-P", "work", "contact", "add", npub, "--name", "Alice", "--nip05", "alice@example.test");
    assert.equal(result.status, 0, result.stderr);
    result = run("contact", "list", "--json");
    assert.deepEqual(JSON.parse(result.stdout), []);
    result = run("-P", "work", "contact", "show", "alice", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).pubkey, pubkey);
    assert.equal(JSON.parse(result.stdout).nip05, "alice@example.test");
    result = run("-P", "work", "contact", "add", npub);
    assert.equal(result.status, 0, result.stderr);
    result = run("-P", "work", "contact", "list", "--json");
    assert.equal(JSON.parse(result.stdout).length, 1);
    result = run("-P", "work", "contact", "remove", pubkey.slice(0, 12));
    assert.equal(result.status, 0, result.stderr);
    result = run("-P", "work", "contact", "show", "Alice", "--json");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Contact not found/);
    result = run("-P", "work", "contact", "add", "invalid-npub");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid npub/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trust, relay, and cache actions preserve local state and exit codes", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-admin-actions-"));
  const loader = path.join(fixture, "isolate.mjs");
  writeFileSync(loader, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();`);
  const dir = path.join(fixture, ".taskify-cli");
  mkdirSync(dir);
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ activeProfile: "default", profiles: { default: {}, work: { relays: [], boards: [{ id: "board", name: "Work" }] } } }));
  const env = { ...process.env };
  delete env.TASKIFY_NSEC;
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, cli, "-P", "work", ...args], { env, encoding: "utf8", timeout: 10000 });
  const config = () => JSON.parse(readFileSync(configPath, "utf8"));
  try {
    for (let i = 0; i < 2; i++) assert.equal(run("trust", "add", "npub-test").status, 0);
    assert.deepEqual(config().profiles.work.trustedNpubs, ["npub-test"]);
    assert.match(run("trust", "list").stdout, /npub-test/);
    assert.equal(run("trust", "remove", "npub-test").status, 0);
    assert.deepEqual(config().profiles.work.trustedNpubs, []);
    const originalRelays = config().profiles.work.relays;
    const relay = "wss://relay.example.test";
    for (let i = 0; i < 2; i++) assert.equal(run("relay", "add", relay).status, 0);
    assert.deepEqual(config().profiles.work.relays, [...originalRelays, relay]);
    assert.equal(run("relay", "remove", relay).status, 0);
    assert.equal(run("relay", "remove", relay).status, 1);
    assert.deepEqual(config().profiles.work.relays, originalRelays);
    assert.deepEqual(config().profiles.default, {});
    const cacheDir = path.join(fixture, ".config", "taskify");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, "cache.json");
    writeFileSync(cachePath, JSON.stringify({ boards: { board: { fetchedAt: Date.now() - 600000, tasks: [{ status: "open" }, { status: "done" }] }, orphan: { fetchedAt: Date.now(), tasks: [] } } }));
    const status = run("cache", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /2 tasks \(1 open\)/);
    assert.match(status.stdout, /stale/);
    assert.match(status.stdout, /orphan/);
    assert.equal(run("cache", "clear").status, 0);
    assert.equal(existsSync(cachePath), false);
    assert.match(run("cache", "status").stdout, /No cache/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
