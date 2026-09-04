import test from "node:test";
import assert from "node:assert/strict";
import { CursorStore } from "../dist/index.js";

test("CursorStore update/getSince", () => {
  const store = new CursorStore();
  const filter = { kinds: [30301], authors: ["abc"] } as any;
  assert.equal(store.getSince(filter), undefined);
  store.update(filter, 100);
  assert.equal(store.getSince(filter), 40);
  store.update(filter, 99);
  assert.equal(store.getSince(filter), 40);
});


test("CursorStore keeps NIP-17 overlap and separates relay sets and event IDs", () => {
  const store = new CursorStore();
  const now = Math.floor(Date.now() / 1000);
  const filter = { kinds: [1059], "#p": ["a".repeat(64)] };
  store.update(filter, now + 86400, ["wss://one"]);
  assert.equal(store.getSince(filter, ["wss://one"]), now - 172800 - 60);
  assert.equal(store.getSince(filter, ["wss://two"]), undefined);
  store.update({ ids: ["a".repeat(64)] }, now);
  assert.equal(store.getSince({ ids: ["b".repeat(64)] }), undefined);
});
