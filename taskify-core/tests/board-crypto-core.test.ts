import test from "node:test";
import assert from "node:assert/strict";
import { boardTagHash, encryptToBoard, decryptFromBoard } from "../dist/boardCrypto.js";

test("boardTagHash returns deterministic hex", async () => {
  const a = await boardTagHash("board-1");
  const b = await boardTagHash("board-1");
  assert.equal(a, b);
  assert.equal(/^[0-9a-f]{64}$/.test(a), true);
});

test("encryptToBoard/decryptFromBoard round-trip", async () => {
  const ct = await encryptToBoard("board-1", "hello");
  const { plaintext, usedLegacyKey } = await decryptFromBoard("board-1", ct);
  assert.equal(plaintext, "hello");
  assert.equal(usedLegacyKey, false);
});
