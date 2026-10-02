import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";

const cli = path.resolve(import.meta.dirname, "../dist/index.js");

test("an nsec can be piped in instead of passed as an argument", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "taskify-secret-"));
  const loader = "data:text/javascript," + encodeURIComponent(`import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(fixture)}; syncBuiltinESMExports();`);
  const nsec = nip19.nsecEncode(generateSecretKey());
  try {
    const piped = spawnSync(process.execPath, ["--import", loader, cli, "config", "set", "nsec", "-"], {
      input: `${nsec}\n`, encoding: "utf8", timeout: 15000, env: { ...process.env, TASKIFY_NSEC: "" },
    });
    assert.equal(piped.status, 0, piped.stderr);
    assert.doesNotMatch(piped.stderr, /Warning: secrets passed as arguments/);
    assert.ok(readFileSync(path.join(fixture, ".taskify-cli", "config.json"), "utf8").includes(nsec));

    const argument = spawnSync(process.execPath, ["--import", loader, cli, "config", "set", "nsec", nsec], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, TASKIFY_NSEC: "" },
    });
    assert.equal(argument.status, 0, argument.stderr);
    assert.match(argument.stderr, /Warning: secrets passed as arguments/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
