import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("CLI board resolution is delegated to shared helpers", () => {
  const indexSource = readFileSync(resolve("src/index.ts"), "utf8");
  assert.match(indexSource, /import\s+\{[^}]*resolveBoardReference[^}]*\}\s+from\s+"taskify-core"/);
  assert.match(indexSource, /resolveBoardForCommand\(config\.boards,\s*boardOpt,\s*config\.defaultLocation\)/);
  assert.match(indexSource, /resolveBoardReference\(config\.boards,\s*boardId\)/);
  assert.match(indexSource, /resolveBoardReference\(config\.boards,\s*boardArg\)/);
});

test("runtime board lookup uses shared core resolver", () => {
  const runtimeSource = readFileSync(resolve("src/nostrRuntime.ts"), "utf8");
  assert.match(runtimeSource, /resolveBoardReference\(config\.boards,\s*boardIdOrName\)/);
});
