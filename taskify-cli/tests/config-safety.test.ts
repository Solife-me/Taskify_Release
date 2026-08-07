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
