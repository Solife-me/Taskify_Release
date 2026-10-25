import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("runtime defaults list-column placement for list boards", () => {
  assert.match(RUNTIME_SOURCE, /entry\.kind === "lists"[\s\S]*entry\.columns\[0\]\.id/);
  assert.match(RUNTIME_SOURCE, /const colId = input\.columnId[\s\S]*entry\.columns\[0\]\.id/);
});

