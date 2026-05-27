import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("board CLI exposes list column lifecycle commands", () => {
  assert.match(CLI_SOURCE, /\.command\("column-add <board> <name>"\)/);
  assert.match(CLI_SOURCE, /\.command\("column-rename <board> <columnRef> <name>"\)/);
  assert.match(CLI_SOURCE, /\.command\("column-delete <board> <columnRef>"\)/);
  assert.match(CLI_SOURCE, /\.command\("column-reorder <board> <columnRef> <position>"\)/);
});

test("board CLI exposes admin controls", () => {
  assert.match(CLI_SOURCE, /\.command\("default \[boardIdOrName\]"\)/);
  assert.match(CLI_SOURCE, /\.command\("rename <board> <name>"\)/);
  assert.match(CLI_SOURCE, /\.command\("archive <board>"\)/);
  assert.match(CLI_SOURCE, /\.command\("unarchive <board>"\)/);
  assert.match(CLI_SOURCE, /\.command\("hide <board>"\)/);
  assert.match(CLI_SOURCE, /\.command\("unhide <board>"\)/);
  assert.match(CLI_SOURCE, /\.command\("index-card <board> <state>"\)/);
  assert.match(CLI_SOURCE, /parseOnOffState\(state\)/);
  assert.match(CLI_SOURCE, /Invalid state:/);
  assert.match(CLI_SOURCE, /\.command\("clear-completed <board>"\)/);
  assert.match(CLI_SOURCE, /\.command\("share-settings <board> <json>"\)/);
});

test("board CLI supports compound board create and child management", () => {
  assert.match(CLI_SOURCE, /\.option\("--kind <lists\|week\|compound>"/);
  assert.match(CLI_SOURCE, /\.option\("--child <id\|name>"/);
  assert.match(CLI_SOURCE, /\.command\("child-add <board> <child>"\)/);
  assert.match(CLI_SOURCE, /\.command\("child-remove <board> <child>"\)/);
  assert.match(CLI_SOURCE, /\.command\("child-reorder <board> <child> <position>"\)/);
});

test("runtime provides board mutation helpers used by phase 1 CLI", () => {
  assert.match(RUNTIME_SOURCE, /async updateBoard\(/);
  assert.match(RUNTIME_SOURCE, /async clearCompleted\(/);
  assert.match(RUNTIME_SOURCE, /async function publishBoardDefinition\(/);
});
