import test from "node:test";
import assert from "node:assert/strict";
import { RelayInfoCache } from "../dist/index.js";

test("RelayInfoCache suppresses repeated NIP-11 fetches after a failed lookup", async () => {
  const cache = new RelayInfoCache({ failureTtlMs: 60_000 } as any);
  let calls = 0;

  const first = await cache.prime("wss://relay.example/", async () => {
    calls += 1;
    return null;
  });

  assert.equal(first, null);
  assert.equal(calls, 1);
  assert.equal(cache.needsRefresh("wss://relay.example/"), false);

  const second = await cache.prime("wss://relay.example/", async () => {
    calls += 1;
    return { name: "should not be fetched during failure TTL" };
  });

  assert.equal(second, null);
  assert.equal(calls, 1);
});

test("RelayInfoCache exposes the maximum NIP-13 difficulty across target relays", async () => {
  const cache = new RelayInfoCache({ failureTtlMs: 60_000 } as any);
  await cache.prime("wss://ordinary.example/", async () => ({
    limitation: { auth_required: false },
  }));
  await cache.prime("wss://pow-20.example/", async () => ({
    limitation: { min_pow_difficulty: 20 },
  }));
  await cache.prime("wss://pow-12.example/", async () => ({
    limitation: { min_pow_difficulty: 12 },
  }));

  const limits = cache.getLimits([
    "wss://ordinary.example/",
    "wss://pow-20.example/",
    "wss://pow-12.example/",
  ]);

  assert.equal(limits.minPowDifficulty, 20);
  assert.equal(limits.authRequired, false);
});
