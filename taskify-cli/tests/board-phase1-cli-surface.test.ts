import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("runtime provides board mutation helpers used by phase 1 CLI", () => {
  assert.match(RUNTIME_SOURCE, /async updateBoard\(/);
  assert.match(RUNTIME_SOURCE, /async clearCompleted\(/);
  assert.match(RUNTIME_SOURCE, /async function publishBoardDefinition\(/);
});
