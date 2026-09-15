import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();

test("CLI registers event command group", () => {
  assert.match(CLI_SOURCE, /\.command\("event"\)/);
});

test("event command group registers expected CRUD subcommands", () => {
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("list"\)/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("add\s*<title>"\)/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("show\s*<eventId>"\)/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("update\s*<eventId>"\)/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("delete\s*<eventId>"\)/);
});

test("event update/delete support optional board resolution", () => {
  assert.match(CLI_SOURCE, /runtime\.updateEvent\(eventId,\s*boardId,/);
  assert.match(CLI_SOURCE, /runtime\.deleteEvent\(eventId,\s*boardId\)/);
  assert.match(CLI_SOURCE, /const boardId = opts\.board \? await resolveBoardId\(opts\.board, config\) : undefined;/);
});

test("event delete supports json output", () => {
  assert.match(CLI_SOURCE, /\.command\("delete\s*<eventId>"\)[\s\S]*?\.option\("--json",\s*"Output as JSON"\)/);
  assert.match(CLI_SOURCE, /if \(opts\.json\) renderJson\(deleted\);/);
});

test("event list includes board label when listing across boards", () => {
  assert.match(CLI_SOURCE, /const showBoard = !boardId;/);
  assert.match(CLI_SOURCE, /const boardLabel = showBoard \? ` \$\{chalk\.dim\(`\[\$\{e\.boardName \?\? e\.boardId\}\]`\)\}` : "";/);
});

test("event show renders board metadata in human output", () => {
  assert.match(CLI_SOURCE, /console\.log\(`board: \$\{event\.boardName \?\? event\.boardId\}`\);/);
});
