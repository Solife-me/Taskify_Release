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

test("decryptFromBoard rejects the obsolete public-tag key", async () => {
  const boardId = "board-legacy";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(boardId));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode("legacy plaintext"),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  const legacyPayload = Buffer.from(combined).toString("base64");

  await assert.rejects(() => decryptFromBoard(boardId, legacyPayload));
});
