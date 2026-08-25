import test from "node:test";
import assert from "node:assert/strict";
import { boardTagHash, deriveBoardKeyPair, normalizeRelayUrls } from "../dist/index.js";

test("boardTagHash returns deterministic 64-char hex", () => {
  const a = boardTagHash("board-1");
  const b = boardTagHash("board-1");
  assert.equal(a, b);
  assert.equal(/^[0-9a-f]{64}$/.test(a), true);
});

test("deriveBoardKeyPair is deterministic", () => {
  const a = deriveBoardKeyPair("board-1");
  const b = deriveBoardKeyPair("board-1");
  assert.equal(a.skHex, b.skHex);
  assert.equal(a.pk, b.pk);
});

test("normalizeRelayUrls trims, dedupes, sorts", () => {
  const relays = normalizeRelayUrls([" wss://B/ ", "wss://a", "wss://b", "", "   "]);
  assert.deepEqual(relays, ["wss://a", "wss://b"]);
});

test("normalizeRelayUrls canonicalizes equivalent URLs and rejects non-relays", () => {
  const relays = normalizeRelayUrls([
    "WSS://Relay.Example/",
    "wss://relay.example",
    "wss://relay.example/#ignored",
    "wss://relay.example/path/",
    "ws://localhost:8080/",
    "https://relay.example",
    "wss://user:pass@relay.example",
    "not a url",
  ]);
  assert.deepEqual(relays, [
    "ws://localhost:8080",
    "wss://relay.example",
    "wss://relay.example/path/",
  ]);
});
