import test from "node:test";
import assert from "node:assert/strict";
import { collectRuntimeRelayUrls } from "../dist/index.js";

test("collectRuntimeRelayUrls includes account and per-board relay sets", () => {
  assert.deepEqual(collectRuntimeRelayUrls(
    ["wss://account.example", "wss://shared.example"],
    [
      { relays: ["wss://board.example", "wss://shared.example"] },
      { relays: [" wss://other.example "] },
    ],
  ), [
    "wss://account.example",
    "wss://board.example",
    "wss://other.example",
    "wss://shared.example",
  ]);
});
