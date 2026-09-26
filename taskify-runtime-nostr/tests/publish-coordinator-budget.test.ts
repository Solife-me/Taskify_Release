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
  // Long enough that signing three events under a loaded test run can't outlast it.
  const publisher = coordinator(store, new RelayPublishBudget({ burst: 2, refillIntervalMs: 1_000 }));
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
    await waitFor(() => sent.length === 3, 5000);
    assert.deepEqual(sent, ["a", "b", "c"]);
    await waitFor(() => store.rows.size === 0, 5000);
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

test("a refused event stays queued but is held back from the refusing relay", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget());
  const original = NDKEvent.prototype.publish;
  const targets: string[][] = [];
  NDKEvent.prototype.publish = async function (set?: { relayUrls?: string[] }) {
    targets.push(set?.relayUrls || []);
    this.emit("relay:publish:failed", relay("wss://blocking"), new Error("blocked: pubkey not allowed"));
    return new Set([relay("wss://ok")]) as never;
  };
  try {
    await publisher.publish(note("x"), { relayUrls: ["wss://ok", "wss://blocking"], signer: generateSecretKey() });
    // A refusal never discards the change: it may be the only copy.
    assert.equal(store.rows.size, 1);
    const [row] = Array.from(store.rows.values());
    assert.deepEqual(row.pendingRelays, ["wss://blocking"]);
    assert.ok((row.relayRejections?.["wss://blocking"]?.retryAfter || 0) >= Date.now() + 3_500_000);
    assert.ok((row.nextAttemptAt || 0) >= Date.now() + 3_500_000);
    // A routine drain does not resend it to the relay that refused it.
    await publisher.drainOutbox();
    assert.equal(targets.length, 1);
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});

test("an event refused by its only relay reports failure and stays queued", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget());
  const original = NDKEvent.prototype.publish;
  NDKEvent.prototype.publish = async function () {
    const errors = new Map([[relay("wss://blocking"), new Error("blocked: not allowed")]]);
    throw Object.assign(new Error("Not enough relays received the event"), { errors, publishedToRelays: new Set() });
  };
  try {
    await assert.rejects(publisher.publish(note("z"), { relayUrls: ["wss://blocking"], signer: generateSecretKey() }));
    assert.equal(store.rows.size, 1);
    const [row] = Array.from(store.rows.values());
    assert.ok((row.nextAttemptAt || 0) >= Date.now() + 3_500_000);
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

test("a transient failure on the relays tried now doesn't fail a write still paced for others", async () => {
  const store = new MemoryOutboxStore();
  const budget = new RelayPublishBudget({ burst: 1, refillIntervalMs: 60_000 });
  budget.take(["wss://paced"], Date.now());
  const publisher = coordinator(store, budget);
  const original = NDKEvent.prototype.publish;
  const targets: string[][] = [];
  NDKEvent.prototype.publish = async function (set?: { relayUrls?: string[] }) {
    targets.push(set?.relayUrls || []);
    const errors = new Map([[relay("wss://flaky"), new Error("Publish timeout after 2500ms")]]);
    throw Object.assign(new Error("Not enough relays received the event"), { errors, publishedToRelays: new Set() });
  };
  try {
    // Before this, the paced relay was left out of the attempt and the timeout failed the whole
    // write, even though it was queued and would reach the paced relay shortly.
    await publisher.publish(note("w"), { relayUrls: ["wss://flaky", "wss://paced"], signer: generateSecretKey() });
    assert.deepEqual(targets, [["wss://flaky"]]);
    const [row] = Array.from(store.rows.values());
    assert.deepEqual(row.pendingRelays, ["wss://flaky", "wss://paced"]);
    // The flaky relay counts as a failed attempt; the row is due no later than the paced relay.
    assert.equal(row.attempts, 1);
    assert.ok((row.nextAttemptAt || 0) <= Date.now() + 61_000);
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});

test("a relay that already holds a deletion or newer version counts as done with the event", async () => {
  const store = new MemoryOutboxStore();
  const publisher = coordinator(store, new RelayPublishBudget());
  const original = NDKEvent.prototype.publish;
  NDKEvent.prototype.publish = async function () {
    this.emit("relay:publish:failed", relay("wss://strfry"), new Error("deleted: user requested deletion"));
    return new Set([relay("wss://ok")]) as never;
  };
  try {
    await publisher.publish(note("tombstone"), { relayUrls: ["wss://ok", "wss://strfry"], signer: generateSecretKey() });
    // It would never be accepted there, so it must not stay queued for that relay.
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});
