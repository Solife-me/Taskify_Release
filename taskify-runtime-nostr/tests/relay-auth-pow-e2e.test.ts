import test from "node:test";
import assert from "node:assert/strict";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  RelayAuthManager,
  RelayHealthTracker,
  RelayInfoCache,
  RuntimeNostrSession,
  committedProofOfWorkDifficulty,
  countLeadingZeroBits,
} from "../dist/index.js";
import { startMockRelay, type MockRelay } from "./helpers/mockRelay.ts";

const accountKey = bytesToHex(generateSecretKey());

function session(relay: MockRelay, options: { accountKeyHex?: string | null; relayInfoCache?: RelayInfoCache } = {}) {
  const relayInfoCache = options.relayInfoCache ?? new RelayInfoCache();
  const runtime = new RuntimeNostrSession<undefined>([relay.url], {
    relayInfoCache,
    relayHealth: new RelayHealthTracker(),
    createAuthManager: (ndk) => new RelayAuthManager(ndk, {
      loadSecretKeyHex: () => (options.accountKeyHex === undefined ? accountKey : options.accountKeyHex),
      allowEphemeralKey: options.accountKeyHex === null,
    }),
    createWalletClient: () => undefined,
    authTimeoutMs: 3_000,
    enableOutboxModel: false,
  });
  return { runtime, relayInfoCache };
}

function taskEvent(runtime: RuntimeNostrSession<undefined>, d: string) {
  const event = runtime.createEvent();
  event.kind = 30301;
  event.created_at = Math.floor(Date.now() / 1000);
  event.content = "encrypted";
  event.tags = [["d", d], ["b", "board"]];
  return event;
}

async function withRelay(options: Parameters<typeof startMockRelay>[0], run: (relay: MockRelay) => Promise<void>) {
  const relay = await startMockRelay(options);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run(relay);
    // Give stray promise rejections a chance to surface before checking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, [], "no unhandled promise rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await relay.close();
  }
}

test("NIP-42: authenticates on connect, then writes and reads go through", async () => {
  await withRelay({ requireAuth: true }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      const signer = NDKPrivateKeySigner.generate();
      const event = taskEvent(runtime, "task-1");
      await runtime.publishSigned(event, signer, [relay.url]);
      assert.equal(relay.events.length, 1);
      assert.deepEqual(relay.authedPubkeys, [getPublicKey(Buffer.from(accountKey, "hex"))]);

      const fetched = await runtime.fetchEvents([{ kinds: [30301], "#d": ["task-1"] }], [relay.url], 5_000);
      assert.deepEqual(fetched.map((e) => e.id), [event.id]);
      const [status] = runtime.relayStatuses();
      assert.equal(status.connected, true);
      assert.equal(status.authRequired, true);
      assert.equal(status.auth?.state, "authenticated");
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-42: a write refused with auth-required is resent once the lazy challenge is answered", async () => {
  await withRelay({ requireAuth: true, lazyChallenge: true }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      const event = taskEvent(runtime, "task-lazy");
      await runtime.publishSigned(event, NDKPrivateKeySigner.generate(), [relay.url]);
      assert.equal(relay.events.length, 1);
      assert.equal(relay.received.length, 2, "first attempt refused, second accepted");

      // A read closed with auth-required is retried after authentication too.
      const fetched = await runtime.fetchEvents([{ kinds: [30301], "#d": ["task-lazy"] }], [relay.url], 5_000);
      assert.equal(fetched.length, 1);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-42: a lazy challenge on a read is answered and the read retried", async () => {
  await withRelay({ requireAuth: true, lazyChallenge: true }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      const fetched = await runtime.fetchEvents([{ kinds: [30301] }], [relay.url], 5_000);
      assert.deepEqual(fetched, []);
      assert.equal(relay.authedPubkeys.length, 1);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-42: a relay refusing AUTH fails the write cleanly instead of crashing", async () => {
  await withRelay({ requireAuth: true, rejectAuth: "restricted: pubkey not on the allow list" }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assert.rejects(runtime.publishSigned(taskEvent(runtime, "task-x"), NDKPrivateKeySigner.generate(), [relay.url]));
      assert.equal(relay.events.length, 0);
      const [status] = runtime.relayStatuses();
      assert.equal(status.auth?.state, "failed");
      assert.match(status.auth?.reason ?? "", /allow list/);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-42: without an account key, a throwaway key answers the challenge", async () => {
  await withRelay({ requireAuth: true }, async (relay) => {
    const { runtime } = session(relay, { accountKeyHex: null });
    try {
      await runtime.init([relay.url]);
      const fetched = await runtime.fetchEvents([{ kinds: [30301] }], [relay.url], 5_000);
      assert.deepEqual(fetched, []);
      assert.equal(relay.authedPubkeys.length, 1);
      assert.notEqual(relay.authedPubkeys[0], getPublicKey(Buffer.from(accountKey, "hex")));
      assert.equal(runtime.relayStatuses()[0].auth?.ephemeral, true);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-13: an advertised difficulty is mined before the first send", async () => {
  await withRelay({ powDifficulty: 10, advertisePow: true }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      const event = taskEvent(runtime, "task-pow");
      await runtime.publishSigned(event, NDKPrivateKeySigner.generate(), [relay.url]);
      assert.equal(relay.received.length, 1);
      assert.equal(relay.events.length, 1);
      assert.ok(countLeadingZeroBits(relay.events[0].id) >= 10);
      assert.equal(committedProofOfWorkDifficulty(relay.events[0].tags), 10);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-13: an unadvertised difficulty is learned from the pow: rejection and re-mined", async () => {
  await withRelay({ powDifficulty: 9 }, async (relay) => {
    const { runtime, relayInfoCache } = session(relay);
    try {
      await runtime.init([relay.url]);
      const event = taskEvent(runtime, "task-learn");
      const firstCreatedAt = event.created_at!;
      await runtime.publishSigned(event, NDKPrivateKeySigner.generate(), [relay.url]);
      assert.equal(relay.received.length, 2);
      assert.equal(relay.events.length, 1);
      assert.equal(relay.events[0].id, event.id, "the caller's event is the stored copy");
      assert.ok(event.created_at! > firstCreatedAt, "the re-mined replaceable copy supersedes the first");
      assert.ok(countLeadingZeroBits(event.id) >= 9);
      assert.equal(relayInfoCache.learnedProofOfWork(relay.url), 9);

      // The next write is mined up front.
      await runtime.publishSigned(taskEvent(runtime, "task-next"), NDKPrivateKeySigner.generate(), [relay.url]);
      assert.equal(relay.received.length, 3);
    } finally {
      await runtime.shutdown();
    }
  });
});

test("NIP-42 and NIP-13 together", async () => {
  await withRelay({ requireAuth: true, lazyChallenge: true, powDifficulty: 8 }, async (relay) => {
    const { runtime } = session(relay);
    try {
      await runtime.init([relay.url]);
      await runtime.publishSigned(taskEvent(runtime, "task-both"), NDKPrivateKeySigner.generate(), [relay.url]);
      assert.equal(relay.events.length, 1);
      assert.ok(countLeadingZeroBits(relay.events[0].id) >= 8);
      assert.equal(relay.authedPubkeys.length, 1);
    } finally {
      await runtime.shutdown();
    }
  });
});

