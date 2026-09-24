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
  // Only a true acceptance confirms delivery; a false OK with duplicate text is retried.
  assert.equal(classifyRelayRejection("duplicate: already have this event"), "retry");
  assert.equal(classifyRelayRejection("pow: difficulty 28 required"), "retry");
  assert.equal(classifyRelayRejection("error: database busy"), "retry");
  assert.equal(classifyRelayRejection("Publish timeout after 2500ms"), "retry");
});

test("first-party relays get a generous budget; public relays stay conservative", async () => {
  const { FIRST_PARTY_RELAYS } = await import("../dist/index.js");
  assert.ok(FIRST_PARTY_RELAYS.includes("wss://relay.solife.me"));
  const budget = new RelayPublishBudget();
  const now = 1_000_000;
  let firstParty = 0;
  let publicRelay = 0;
  // A 60-task board template plus its board event, all at once.
  for (let i = 0; i < 61; i += 1) {
    const { ready } = budget.take(["wss://relay.solife.me", "wss://relay.damus.io"], now);
    if (ready.includes("wss://relay.solife.me")) firstParty += 1;
    if (ready.includes("wss://relay.damus.io")) publicRelay += 1;
  }
  assert.equal(firstParty, 61);
  assert.equal(publicRelay, 8);
});

test("first-party relays can be configured", () => {
  const budget = new RelayPublishBudget({ firstPartyRelays: ["wss://mine.example"] });
  const now = 5_000;
  for (let i = 0; i < 20; i += 1) assert.deepEqual(budget.take(["wss://mine.example"], now).ready, ["wss://mine.example"]);
  for (let i = 0; i < 8; i += 1) budget.take(["wss://relay.solife.me"], now);
  assert.deepEqual(budget.take(["wss://relay.solife.me"], now).ready, []);
});
