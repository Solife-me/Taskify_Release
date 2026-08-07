import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");

test("board definition publish uses hashed board id for d/b tags (PWA parity)", () => {
  assert.match(RUNTIME_SOURCE, /const bTag = boardTagHash\(board\.id\)/);
  assert.match(RUNTIME_SOURCE, /event\.tags = \[\s*\["d", bTag\],\s*\["b", bTag\]/s);
});

test("week board task publish uses canonical col=day tag", () => {
  assert.match(
    RUNTIME_SOURCE,
    /else if \(entry\.kind === "week"\) \{\s*colId = "day";\s*\}/s,
  );
});

test("task and calendar fetches require the deterministic board author", () => {
  const authorFilterCount = (RUNTIME_SOURCE.match(/authors: \[boardPubkey\]/g) ?? []).length;
  assert.ok(authorFilterCount >= 3, `expected board author filters, got ${authorFilterCount}`);
  assert.match(RUNTIME_SOURCE, /event\.pubkey !== deriveBoardKeyPair\(boardId\)\.pk/);
});
