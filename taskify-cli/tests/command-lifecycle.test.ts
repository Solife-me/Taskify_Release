import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/index.js");

test("event commands return control before the executable performs the only hard exit", () => {
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
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, cli, "event", "list", "--json"], {
      env: { ...process.env, HOME: home, TASKIFY_NSEC: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n"), ["process.exit:0"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
