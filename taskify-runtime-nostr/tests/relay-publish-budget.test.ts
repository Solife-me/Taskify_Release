import test from "node:test";
import assert from "node:assert/strict";
import { RelayPublishBudget, classifyRelayRejection } from "../dist/index.js";

test("a relay gets a burst, then events at the refill rate", () => {
  const budget = new RelayPublishBudget({ burst: 3, refillIntervalMs: 1000 });
  const now = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(budget.take(["wss://a"], now).ready, ["wss://a"]);
  }
  const deferred = budget.take(["wss://a"], now);
  assert.deepEqual(deferred.ready, []);
  assert.equal(deferred.deferredUntil, now + 1000);
  assert.deepEqual(budget.take(["wss://a"], now + 1000).ready, ["wss://a"]);
  assert.deepEqual(budget.take(["wss://a"], now + 1000).ready, []);
});

test("relays are budgeted independently", () => {
  const budget = new RelayPublishBudget({ burst: 1, refillIntervalMs: 1000 });
  const now = 5_000;
  assert.deepEqual(budget.take(["wss://a"], now).ready, ["wss://a"]);
  const mixed = budget.take(["wss://a", "wss://b"], now);
  assert.deepEqual(mixed.ready, ["wss://b"]);
  assert.equal(mixed.deferredUntil, now + 1000);
});

test("a rate-limit rejection backs the relay off exponentially and clears after accepted events", () => {
  const budget = new RelayPublishBudget({ burst: 10, refillIntervalMs: 1000, rateLimitBackoffMs: 2000, maxBackoffMs: 30_000 });
  const now = 10_000;
  budget.recordRateLimited("wss://a", now);
  assert.equal(budget.take(["wss://a"], now).deferredUntil, now + 2000);
  budget.recordRateLimited("wss://a", now);
  assert.equal(budget.take(["wss://a"], now).deferredUntil, now + 4000);
  // Once the backoff passes, the relay drains its remaining burst slowly: a rejection also
  // empties the bucket so the next events arrive at the refill rate.
  const after = budget.take(["wss://a"], now + 4000);
  assert.deepEqual(after.ready, ["wss://a"]);
  assert.deepEqual(budget.take(["wss://a"], now + 4000).ready, []);
});

test("rejections are classified by their NIP-01 prefix", () => {
  assert.equal(classifyRelayRejection("rate-limited: slow down"), "rate-limited");
  assert.equal(classifyRelayRejection("rate-limit: you note too much"), "rate-limited");
  assert.equal(classifyRelayRejection("blocked: pubkey not allowed"), "terminal");
  assert.equal(classifyRelayRejection("restricted: paid relay"), "terminal");
  assert.equal(classifyRelayRejection("invalid: event too large"), "terminal");
  assert.equal(classifyRelayRejection("duplicate: already have this event"), "delivered");
  assert.equal(classifyRelayRejection("pow: difficulty 28 required"), "retry");
  assert.equal(classifyRelayRejection("error: database busy"), "retry");
  assert.equal(classifyRelayRejection("Publish timeout after 2500ms"), "retry");
});
