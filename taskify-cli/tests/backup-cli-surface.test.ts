import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();

test("backup command includes merge-relays subcommand", () => {
  assert.match(CLI_SOURCE, /backupCmd[\s\S]*?\.command\("merge-relays\s*<file>"\)/);
});

test("backup merge-relays uses shared relay merge helper and saves config", () => {
  assert.match(CLI_SOURCE, /config\.relays = mergeRelaysFromBackup\(config\.relays, snapshot\.defaultRelays\);/);
  assert.match(CLI_SOURCE, /await saveConfig\(config\);/);
});
