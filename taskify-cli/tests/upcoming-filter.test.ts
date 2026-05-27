import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");

test("upcoming command is registered on program", () => {
  assert.match(CLI, /\.command\("upcoming"\)/);
});

test("upcoming supports --days flag", () => {
  assert.match(CLI, /--days <n>/);
});

test("upcoming supports --board flag", () => {
  assert.match(CLI, /\.command\("upcoming"\)[\s\S]*?--board/);
});

test("upcoming supports --json flag", () => {
  assert.match(CLI, /\.command\("upcoming"\)[\s\S]*?--json/);
});

test("upcoming defaults to 14 days", () => {
  assert.match(CLI, /days = opts\.days.*14|parseInt.*14/);
});

test("upcoming filters by dueDateEnabled === true", () => {
  assert.match(CLI, /dueDateEnabled === true/);
});

test("upcoming filters tasks by dueISO within cutoff range", () => {
  assert.match(CLI, /dueISO.*todayStr|todayStr.*dueISO/);
  assert.match(CLI, /dueISO.*cutoffStr|cutoffStr.*dueISO/);
});

test("upcoming fetches only open tasks", () => {
  assert.match(CLI, /status: "open"[\s\S]*?upcoming|upcoming[\s\S]*?status: "open"/);
});

test("upcoming sorts by dueISO then priority", () => {
  assert.match(CLI, /a\.dueISO.*b\.dueISO/);
  assert.match(CLI, /a\.priority.*b\.priority/);
  assert.match(CLI, /b\.priority[\s\S]*?a\.priority/);
});

test("upcoming groups tasks by date using a Map", () => {
  assert.match(CLI, /new Map/);
  assert.match(CLI, /groups\.set|groups\.get/);
});

test("upcoming renders grouped output with date headers", () => {
  assert.match(CLI, /chalk\.bold[\s\S]*?day|groups.*chalk\.bold/);
});
