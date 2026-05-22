import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");
const RENDER_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/render.ts"), "utf8");

test("task add/update expose rich parity flags", () => {
  assert.match(CLI_SOURCE, /\.command\("add\s*<title>"\)[\s\S]*?--recurrence-json/);
  assert.match(CLI_SOURCE, /\.command\("add\s*<title>"\)[\s\S]*?--documents-json/);
  assert.match(CLI_SOURCE, /\.command\("add\s*<title>"\)[\s\S]*?--assignee/);
  assert.match(CLI_SOURCE, /normalizeAssigneeArgs[\s\S]*?npubOrHexToHex\(value\)/);
  assert.match(CLI_SOURCE, /\.command\("update\s*<taskId>"\)[\s\S]*?--recurrence-json/);
  assert.match(CLI_SOURCE, /\.command\("update\s*<taskId>"\)[\s\S]*?--documents-json/);
  assert.match(CLI_SOURCE, /\.command\("update\s*<taskId>"\)[\s\S]*?--assignee/);
});

test("event add/update expose recurrence reminders invitees and list-column flags", () => {
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("add\s*<title>"\)[\s\S]*?--column/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("add\s*<title>"\)[\s\S]*?--recurrence-json/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("add\s*<title>"\)[\s\S]*?--reminders/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("add\s*<title>"\)[\s\S]*?--invitee/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("update\s*<eventId>"\)[\s\S]*?--column/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("update\s*<eventId>"\)[\s\S]*?--recurrence-json/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("update\s*<eventId>"\)[\s\S]*?--reminders/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("update\s*<eventId>"\)[\s\S]*?--invitee/);
});

test("list semantics resolve board id and strict column-name match", () => {
  assert.match(CLI_SOURCE, /const resolvedBoardId = opts\.board \? await resolveBoardId\(opts\.board, config\) : undefined;/);
  assert.match(CLI_SOURCE, /boardId: resolvedBoardId/);
  assert.match(CLI_SOURCE, /resolveColumnOrExit\(boardEntry, opts\.column\)/);
});

test("runtime defaults list-column placement for list boards", () => {
  assert.match(RUNTIME_SOURCE, /entry\.kind === "lists"[\s\S]*entry\.columns\[0\]\.id/);
  assert.match(RUNTIME_SOURCE, /const colId = input\.columnId[\s\S]*entry\.columns\[0\]\.id/);
});

test("show surfaces document details and event invitee details", () => {
  assert.match(RENDER_SOURCE, /Documents:[\s\S]*document-\$\{idx \+ 1\}/);
  assert.match(CLI_SOURCE, /event\.participants\.forEach\(\(p\) => console\.log\(`  - \$\{p\.pubkey\}/);
});
