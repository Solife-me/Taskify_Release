import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI = commandSource();
const RUNTIME = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");
const CONFIG = readFileSync(path.resolve(import.meta.dirname, "../src/config.ts"), "utf8");

test("BoardEntry has sortMode field with valid literal union", () => {
  assert.match(CONFIG, /sortMode\?:.*"manual".*"due".*"priority".*"created".*"alpha"/);
});

test("BoardEntry has sortDirection field", () => {
  assert.match(CONFIG, /sortDirection\?: "asc" \| "desc"/);
});

test("BoardEntry has eventKeys field", () => {
  assert.match(CONFIG, /eventKeys\?: Record<string, string>/);
});

test("board sort subcommand is registered on boardCmd", () => {
  assert.match(CLI, /boardCmd[\s\S]*?\.command\("sort <board>/);
});

test("board sort validates mode against VALID_MODES list", () => {
  assert.match(CLI, /VALID_MODES.*=.*\[.*"manual".*"due".*"priority".*"created".*"alpha".*\]/);
});

test("board sort validates direction against VALID_DIRS list", () => {
  assert.match(CLI, /VALID_DIRS.*=.*\[.*"asc".*"desc".*\]/);
});

test("board sort without mode prints current settings", () => {
  assert.match(CLI, /sortMode.*manual.*default|Sort mode.*sortMode/);
});

test("board sort calls runtime.updateBoard with sortMode and sortDirection", () => {
  assert.match(CLI, /updateBoard[\s\S]*?sortMode.*mode|sortMode.*updateBoard/);
});

test("publishBoardDefinition emits sort tag in event tags", () => {
  assert.match(RUNTIME, /\["sort", board\.sortMode/);
});

test("publishBoardDefinition includes sortMode and sortDirection in payload", () => {
  assert.match(RUNTIME, /sortMode: board\.sortMode/);
  assert.match(RUNTIME, /sortDirection: board\.sortDirection/);
});

test("syncBoard parses sort tag from fetched board events", () => {
  assert.match(RUNTIME, /sortTag[\s\S]*?sortMode|sort.*tag.*sortMode/i);
});

test("updateBoard implementation accepts sortMode in patch", () => {
  assert.match(RUNTIME, /patch\.sortMode.*entry\.sortMode|sortMode.*patch.*entry/);
});

test("updateBoard NostrRuntime type includes sortMode and sortDirection in patch", () => {
  assert.match(RUNTIME, /NostrRuntime[\s\S]*?updateBoard[\s\S]*?"sortMode".*"sortDirection"|sortMode.*sortDirection.*updateBoard/);
});
