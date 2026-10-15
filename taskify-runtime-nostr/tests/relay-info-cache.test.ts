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

test("RelayInfoCache raises a relay's difficulty from a pow: rejection and persists it", async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  const cache = new RelayInfoCache({ storage });
  await cache.prime("wss://quiet.example/", async () => ({ limitation: { min_pow_difficulty: 4 } }));
  cache.recordProofOfWorkRequirement("wss://quiet.example", 16);
  cache.recordProofOfWorkRequirement("wss://quiet.example/", 12); // never lowers
  assert.equal(cache.getLimits(["wss://quiet.example/"]).minPowDifficulty, 16);
  // Learned without any NIP-11 document at all.
  cache.recordProofOfWorkRequirement("wss://silent.example/", 9);
  assert.equal(cache.getLimits(["wss://silent.example/"]).minPowDifficulty, 9);

  const restored = new RelayInfoCache({ storage });
  assert.equal(restored.getLimits(["wss://quiet.example/"]).minPowDifficulty, 16);
  assert.equal(restored.learnedProofOfWork("wss://silent.example/"), 9);

  const expired = new RelayInfoCache({ storage, learnedPowTtlMs: -1 });
  assert.equal(expired.learnedProofOfWork("wss://silent.example/"), 0);
});

test("RelayInfoCache restores learned difficulties even with no NIP-11 entries stored", () => {
  const store = new Map<string, string>([["relay-info-cache:pow", JSON.stringify({ "https://only-learned.example/": { difficulty: 14, learnedAt: Date.now() } })]]);
  const cache = new RelayInfoCache({ storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined } });
  assert.equal(cache.learnedProofOfWork("wss://only-learned.example"), 14);
});
