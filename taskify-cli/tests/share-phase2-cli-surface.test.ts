import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();

test("share command group is registered", () => {
  assert.match(CLI_SOURCE, /\.command\("share"\)/);
  assert.match(CLI_SOURCE, /shareCmd[\s\S]*?\.command\("board\s*<board>\s*<npubOrHex>"\)/);
  assert.match(CLI_SOURCE, /shareCmd[\s\S]*?\.command\("task\s*<taskId>\s*<npubOrHex>"\)/);
  assert.match(CLI_SOURCE, /shareCmd[\s\S]*?\.command\("event\s*<eventId>\s*<npubOrHex>"\)/);
  assert.match(CLI_SOURCE, /shareCmd[\s\S]*?\.command\("inbox"\)/);
});

test("share inbox supports apply path", () => {
  assert.match(CLI_SOURCE, /\.command\("inbox"\)[\s\S]*?\.option\("--apply"/);
  assert.match(CLI_SOURCE, /if \(opts\.apply\)/);
});

test("event invite and rsvp loop commands are present", () => {
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("invite\s*<eventId>\s*<npubOrHex>"\)/);
  assert.match(CLI_SOURCE, /eventCmd[\s\S]*?\.command\("rsvp\s*<eventId>\s*<accepted\|declined\|tentative>"\)/);
});

test("assign command supports notify DM collaboration", () => {
  assert.match(CLI_SOURCE, /\.command\("assign\s*<taskId>\s*<npubOrHex>"\)[\s\S]*?\.option\("--notify"/);
  assert.match(CLI_SOURCE, /if \(opts\.notify\)/);
  assert.match(CLI_SOURCE, /buildTaskShareEnvelope\(/);
});
