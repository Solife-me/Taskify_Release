import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();
const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("board columns command supports per-board lookup and json output", () => {
  assert.match(CLI_SOURCE, /\.command\("columns \[board\]"\)/);
  assert.match(CLI_SOURCE, /\.option\("--json", "Output as JSON"\)/);
  assert.match(CLI_SOURCE, /resolveBoardReference\(config\.boards, boardArg\)/);
});

test("task add/update uses strict column resolution and list-safe no-columns guard", () => {
  assert.match(CLI_SOURCE, /resolveColumnOrExit\(boardEntry, opts\.column\)/);
  assert.match(CLI_SOURCE, /Board \"\$\{boardEntry\.name\}\" has no columns\/lists yet\./);
  assert.match(CLI_SOURCE, /Use --column <id> to target deterministically\./);
});

test("task add success output includes resolved column id for verification", () => {
  assert.match(CLI_SOURCE, /\[col: \$\{task\.column\}/);
});

test("runtime keeps PWA-compatible list-board default-first-column semantics", () => {
  assert.match(
    RUNTIME_SOURCE,
    /else if \(entry\.kind === "lists" && Array\.isArray\(entry\.columns\) && entry\.columns\.length > 0\) \{\s*colId = entry\.columns\[0\]\.id;\s*\}/s,
  );
});
