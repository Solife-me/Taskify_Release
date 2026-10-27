import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import {
  RelayAuthManager,
  RelayHealthTracker,
  RelayInfoCache,
  RuntimeNostrSession,
  RuntimeSessionClosedError,
} from "../dist/index.js";
import { startMockRelay } from "./helpers/mockRelay.ts";

/** C12-3: shutdown is terminal, idempotent, finishes what was asked, and releases everything. */

function session(url: string) {
  return new RuntimeNostrSession<undefined>([url], {
    relayInfoCache: new RelayInfoCache(),
    relayHealth: new RelayHealthTracker(),
    createAuthManager: (ndk) => new RelayAuthManager(ndk, { loadSecretKeyHex: () => null, allowEphemeralKey: true }),
    createWalletClient: () => undefined,
    enableOutboxModel: false,
  });
}

for (const relayCount of [1, 3]) {
  test(`a process exits by itself once its session with ${relayCount} relay(s) has shut down`, async () => {
    // With several relays, NDK takes most of them dropping at once for a system sleep and
    // reconnects them, so shutdown must take relays out of the pool rather than just disconnect.
    const relays = await Promise.all(Array.from({ length: relayCount }, () => startMockRelay()));
    try {
      const child = spawn(process.execPath, [
        path.join(import.meta.dirname, "helpers/sessionLifecycleChild.mjs"), ...relays.map((relay) => relay.url),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      const exited = await new Promise<number | null | "still running">((resolve) => {
        const timer = setTimeout(() => resolve("still running"), 8_000);
        child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      });
      if (exited === "still running") child.kill();
      assert.equal(stdout.trim(), "shut down");
      assert.equal(exited, 0, "the process kept running after shutdown");
      for (const relay of relays) assert.equal(relay.events.length, 1);
    } finally {
      await Promise.all(relays.map((relay) => relay.close()));
    }
  });
}

test("shutdown can be called twice, and nothing works after it", async () => {
  const relay = await startMockRelay();
  const runtime = session(relay.url);
  try {
    await runtime.init([relay.url]);
    await runtime.shutdown();
    await runtime.shutdown();

    await assert.rejects(runtime.init([relay.url]), RuntimeSessionClosedError);
    const event = runtime.createEvent();
    event.kind = 1;
    event.content = "late";
    await assert.rejects(runtime.publishSigned(event, NDKPrivateKeySigner.generate(), [relay.url]), RuntimeSessionClosedError);
    await assert.rejects(runtime.fetchEvents([{ kinds: [1] }], [relay.url], 500), RuntimeSessionClosedError);
    await assert.rejects(runtime.subscribe([{ kinds: [1] }]), RuntimeSessionClosedError);
    await assert.rejects(runtime.publish({ kind: 1, content: "late", tags: [], created_at: 0 }), RuntimeSessionClosedError);
    assert.equal(relay.received.length, 0);
  } finally {
    await relay.close();
  }
});

test("a debounced publish waiting at shutdown is sent, not dropped", async () => {
  const relay = await startMockRelay();
  const runtime = session(relay.url);
  try {
    await runtime.init([relay.url]);
    const signer = NDKPrivateKeySigner.generate();
    const pending = runtime.publish(
      { kind: 30301, content: "board", tags: [["d", "board-1"]], created_at: Math.floor(Date.now() / 1000) },
      { signer, relayUrls: [relay.url], debounceMs: 60_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.shutdown();
    const createdAt = await pending;
    assert.equal(typeof createdAt, "number");
    assert.equal(relay.events.length, 1);
  } finally {
    await relay.close();
  }
});
