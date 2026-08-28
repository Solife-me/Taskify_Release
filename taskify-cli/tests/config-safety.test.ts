import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runConfigScript(home: string, source: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf-8",
    },
  );
}

test("config writes are private and atomic output remains valid JSON", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission assertion");
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const result = runConfigScript(home, `
      import { loadConfig, saveConfig } from './src/config.ts';
      const config = await loadConfig();
      config.nsec = 'nsec-test-secret';
      await saveConfig(config);
    `);
    assert.equal(result.status, 0, result.stderr);

    const dir = path.join(home, ".taskify-cli");
    const file = path.join(dir, "config.json");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).profiles.default.nsec, "nsec-test-secret");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("malformed config fails closed instead of silently replacing secrets", () => {
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const dir = path.join(home, ".taskify-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), "{not valid json", "utf-8");
    const result = runConfigScript(home, `
      import { loadConfig } from './src/config.ts';
      await loadConfig();
    `);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Config file is malformed; refusing to overwrite/);
    assert.equal(readFileSync(path.join(dir, "config.json"), "utf-8"), "{not valid json");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loading an existing config is read-only", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission assertion");
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const dir = path.join(home, ".taskify-cli");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({
      activeProfile: "default",
      profiles: {
        default: {
          relays: ["wss://relay.example"],
          defaultBoard: "Personal",
          trustedNpubs: [],
          securityMode: "moderate",
          securityEnabled: true,
          boards: [],
          taskReminders: {},
        },
      },
    }), { mode: 0o444 });

    const result = runConfigScript(home, `
      import { loadConfig } from './src/config.ts';
      await loadConfig();
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(file).mode & 0o777, 0o444);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loading a legacy flat config migrates in memory without rewriting it", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission assertion");
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const dir = path.join(home, ".taskify-cli");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    const legacy = JSON.stringify({
      nsec: "legacy-secret",
      relays: ["wss://relay.example"],
      defaultBoard: "Personal",
      boards: [{ id: "board-1", name: "Personal", columns: [{ id: "todo", name: "Todo" }] }],
    });
    writeFileSync(file, legacy, { mode: 0o444 });

    const result = runConfigScript(home, `
      import { loadConfig } from './src/config.ts';
      const config = await loadConfig();
      process.stdout.write(JSON.stringify(config.defaultLocation));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { boardId: "board-1" });
    assert.equal(readFileSync(file, "utf-8"), legacy);
    assert.equal(statSync(file).mode & 0o777, 0o444);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy multi-word board/list defaults migrate to a structured location in memory", () => {
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const dir = path.join(home, ".taskify-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      activeProfile: "default",
      profiles: {
        default: {
          relays: ["wss://relay.example"],
          defaultBoard: "Client Work",
          defaultList: "Client Work Agent Queue",
          trustedNpubs: [],
          securityMode: "moderate",
          securityEnabled: true,
          boards: [{
            id: "board-work",
            name: "Client Work",
            kind: "lists",
            columns: [{ id: "list-queue", name: "Agent Queue" }],
          }],
          taskReminders: {},
        },
      },
    }));

    const result = runConfigScript(home, `
      import { loadConfig } from './src/config.ts';
      const config = await loadConfig();
      process.stdout.write(JSON.stringify(config.defaultLocation));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      boardId: "board-work",
      listId: "list-queue",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config redaction removes secrets from nested profiles and agent settings", () => {
  const home = mkdtempSync(path.join(tmpdir(), "taskify-config-"));
  try {
    const result = runConfigScript(home, `
      import { redactConfig } from './src/config.ts';
      const value = redactConfig({
        nsec: 'top-secret',
        profiles: { work: { nsec: 'nested-secret', agent: { apiKey: 'api-secret' } } },
      });
      process.stdout.write(JSON.stringify(value));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /top-secret|nested-secret|api-secret/);
    assert.match(result.stdout, /\[redacted\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
