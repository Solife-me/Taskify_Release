import test from "node:test";
import assert from "node:assert/strict";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { generateSecretKey, type EventTemplate } from "nostr-tools";
import {
  PublishCoordinator,
  RelayPublishBudget,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "../dist/index.js";

class MemoryOutboxStore implements NostrOutboxStore {
  rows = new Map<string, NostrOutboxMutation>();
  async get(id: string) { const row = this.rows.get(id); return row && JSON.parse(JSON.stringify(row)); }
  async put(mutation: NostrOutboxMutation) { this.rows.set(mutation.id, JSON.parse(JSON.stringify(mutation))); }
  async delete(id: string) { this.rows.delete(id); }
  async listPending() { return Array.from(this.rows.values()).map((row) => JSON.parse(JSON.stringify(row))); }
}

const relay = (url: string) => ({ url });
const relaySet = (urls: string[]) => ({ relayUrls: urls, relays: new Set(urls.map(relay)) });

function coordinator(store: NostrOutboxStore, budget: RelayPublishBudget) {
  return new PublishCoordinator(
    {} as NDK,
    async (relayUrls) => relaySet(relayUrls || []) as never,
    undefined,
    { outboxStore: store, retryBaseMs: 60_000, publishBudget: budget },
  );
}

const note = (content: string): EventTemplate => ({ kind: 1, content, tags: [], created_at: 1_790_000_000 });

async function waitFor(fn: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("events beyond a relay's burst are queued, not sent, and go out as the budget refills", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget({ burst: 2, refillIntervalMs: 150 }));
  const original = NDKEvent.prototype.publish;
  const sent: string[] = [];
  NDKEvent.prototype.publish = async function (set?: { relayUrls?: string[] }) {
    sent.push(this.content);
    return new Set((set?.relayUrls || []).map(relay)) as never;
  };
  try {
    const signer = generateSecretKey();
    for (const content of ["a", "b", "c"]) {
      // Resolves right away even when paced: the event is durably queued.
      await publisher.publish(note(content), { relayUrls: ["wss://one"], signer });
    }
    assert.deepEqual(sent, ["a", "b"]);
    assert.equal(store.rows.size, 1);
    await waitFor(() => sent.length === 3);
    assert.deepEqual(sent, ["a", "b", "c"]);
    await waitFor(() => store.rows.size === 0);
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});

test("a rate-limited relay is backed off while other relays keep receiving", async () => {
  const store = new MemoryOutboxStore();
  const budget = new RelayPublishBudget({ burst: 10, refillIntervalMs: 10, rateLimitBackoffMs: 60_000 });
  const publisher = coordinator(store, budget);
  const original = NDKEvent.prototype.publish;
  const targets: string[][] = [];
  NDKEvent.prototype.publish = async function (set?: { relayUrls?: string[] }) {
    const urls = set?.relayUrls || [];
    targets.push(urls);
    // wss://strict rejects the first event it sees; the overall publish still succeeds.
    if (urls.includes("wss://strict") && targets.length === 1) {
      this.emit("relay:publish:failed", relay("wss://strict"), new Error("rate-limited: slow down"));
      return new Set([relay("wss://ok")]) as never;
    }
    return new Set(urls.map(relay)) as never;
  };
  try {
    const signer = generateSecretKey();
    await publisher.publish(note("first"), { relayUrls: ["wss://ok", "wss://strict"], signer });
    await publisher.publish(note("second"), { relayUrls: ["wss://ok", "wss://strict"], signer });
    assert.deepEqual(targets, [["wss://ok", "wss://strict"], ["wss://ok"]]);
    // Both events wait for the strict relay, due after its backoff rather than immediately.
    assert.equal(store.rows.size, 2);
    for (const row of store.rows.values()) {
      assert.deepEqual(row.pendingRelays, ["wss://strict"]);
      assert.ok((row.nextAttemptAt || 0) >= Date.now() + 50_000);
    }
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});

test("a relay that refuses an event for good is not retried; duplicates count as delivered", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget());
  const original = NDKEvent.prototype.publish;
  let calls = 0;
  NDKEvent.prototype.publish = async function () {
    calls += 1;
    this.emit("relay:publish:failed", relay("wss://blocking"), new Error("blocked: pubkey not allowed"));
    this.emit("relay:publish:failed", relay("wss://dupe"), new Error("duplicate: already have this event"));
    return new Set([relay("wss://ok")]) as never;
  };
  try {
    await publisher.publish(note("x"), { relayUrls: ["wss://ok", "wss://blocking", "wss://dupe"], signer: generateSecretKey() });
    assert.equal(calls, 1);
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});

test("a publish no relay accepts, with no rate limiting involved, still reports failure", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget());
  const original = NDKEvent.prototype.publish;
  NDKEvent.prototype.publish = async function () { return new Set() as never; };
  try {
    await assert.rejects(
      publisher.publish(note("y"), { relayUrls: ["wss://down"], signer: generateSecretKey() }),
      /No relay acknowledged the write/,
    );
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});
