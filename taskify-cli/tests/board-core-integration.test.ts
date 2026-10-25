import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runtime board lookup uses shared core resolver", () => {
  const runtimeSource = readFileSync(resolve("src/nostrRuntime.ts"), "utf8");
  assert.match(runtimeSource, /resolveBoardReference\(config\.boards,\s*boardIdOrName\)/);
});
