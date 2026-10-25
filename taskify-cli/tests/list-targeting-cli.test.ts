import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("runtime keeps PWA-compatible list-board default-first-column semantics", () => {
  assert.match(
    RUNTIME_SOURCE,
    /else if \(entry\.kind === "lists" && Array\.isArray\(entry\.columns\) && entry\.columns\.length > 0\) \{\s*colId = entry\.columns\[0\]\.id;\s*\}/s,
  );
});
