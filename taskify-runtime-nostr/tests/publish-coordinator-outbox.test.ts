import test from "node:test";
import assert from "node:assert/strict";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { generateSecretKey, type EventTemplate } from "nostr-tools";
import { PublishCoordinator, type NostrOutboxMutation, type NostrOutboxStore } from "../dist/index.js";

class MemoryOutboxStore implements NostrOutboxStore {
  rows = new Map<string, NostrOutboxMutation>();

  async get(id: string): Promise<NostrOutboxMutation | undefined> {
    return clone(this.rows.get(id));
  }

  async put(mutation: NostrOutboxMutation): Promise<void> {
    this.rows.set(mutation.id, clone(mutation)!);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async listPending(): Promise<NostrOutboxMutation[]> {
    return Array.from(this.rows.values()).map((row) => clone(row)!);
  }
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function relay(url: string): { url: string } {
  return { url };
}

function relaySet(urls: string[]): { relayUrls: string[]; relays: Set<{ url: string }> } {
  return { relayUrls: urls, relays: new Set(urls.map(relay)) };
}

async function waitFor(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildCoordinator(store: NostrOutboxStore): PublishCoordinator {
  const ndk = {} as NDK;
  return new PublishCoordinator(
    ndk,
    async (relayUrls) => relaySet(relayUrls || []) as never,
    undefined,
    { outboxStore: store, retryBaseMs: 60_000 },
  );
}

const template: EventTemplate = {
  kind: 1,
  content: "outbox test",
  tags: [],
  created_at: 1_700_000_000,
};

test("PublishCoordinator persists an outbox row before publish and removes it after all relays ack", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  let rowsDuringPublish = 0;

  NDKEvent.prototype.publish = async function publishMock() {
    rowsDuringPublish = store.rows.size;
    return new Set([relay("wss://relay.one"), relay("wss://relay.two")]) as never;
  };

  try {
    const result = await coordinator.publish(template, {
      relayUrls: ["wss://relay.one", "wss://relay.two"],
      signer: generateSecretKey(),
    });

    assert.equal(typeof result, "number");
    assert.equal(rowsDuringPublish, 1);
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});

test("PublishCoordinator keeps partial failures and drains only pending relays", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  const publishCalls: string[][] = [];
  let attempt = 0;

  NDKEvent.prototype.publish = async function publishMock(relaySetArg?: { relayUrls?: string[] }) {
    publishCalls.push([...(relaySetArg?.relayUrls || [])]);
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("relay.two offline") as Error & { publishedToRelays: Set<{ url: string }> };
      error.publishedToRelays = new Set([relay("wss://relay.one")]);
      throw error;
    }
    return new Set([relay("wss://relay.two")]) as never;
  };

  try {
    await assert.rejects(
      coordinator.publish(template, {
        relayUrls: ["wss://relay.one", "wss://relay.two"],
        signer: generateSecretKey(),
      }),
      /relay.two offline/,
    );

    assert.equal(store.rows.size, 1);
    const [row] = Array.from(store.rows.values());
    assert.deepEqual(row.ackedRelays, ["wss://relay.one"]);
    assert.deepEqual(row.pendingRelays, ["wss://relay.two"]);
    assert.equal(row.attempts, 1);
    assert.match(row.lastError || "", /relay.two offline/);

    await coordinator.drainOutbox({ force: true });

    assert.deepEqual(publishCalls, [["wss://relay.one", "wss://relay.two"], ["wss://relay.two"]]);
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});

test("PublishCoordinator backs off when a successful publish only acknowledges some relays", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  let publishCalls = 0;

  NDKEvent.prototype.publish = async function publishMock() {
    publishCalls += 1;
    return new Set([relay("wss://relay.one")]) as never;
  };

  try {
    await coordinator.publish(template, {
      relayUrls: ["wss://relay.one", "wss://relay.two"],
      signer: generateSecretKey(),
    });

    assert.equal(publishCalls, 1);
    assert.equal(store.rows.size, 1);
    const [row] = Array.from(store.rows.values());
    assert.deepEqual(row.ackedRelays, ["wss://relay.one"]);
    assert.deepEqual(row.pendingRelays, ["wss://relay.two"]);
    assert.equal(row.attempts, 1);
    assert.ok((row.nextAttemptAt || 0) >= Date.now() + 59_000);

    // A routine drain must honor the persisted due time rather than retrying
    // the partial acknowledgement in a zero-delay loop.
    await coordinator.drainOutbox();
    assert.equal(publishCalls, 1);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});

test("PublishCoordinator publishes only the latest replaceable event for a debounced key", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  const publishedContents: string[] = [];

  NDKEvent.prototype.publish = async function publishMock() {
    publishedContents.push(this.rawEvent().content);
    return new Set([relay("wss://relay.one")]) as never;
  };

  try {
    const first = coordinator.publish(
      { ...template, kind: 30301, content: "first", tags: [["d", "task-1"]] },
      { relayUrls: ["wss://relay.one"], signer: generateSecretKey(), replaceableKey: "task:1", debounceMs: 200 },
    );
    await waitFor(() => store.rows.size === 1);
    const second = coordinator.publish(
      { ...template, kind: 30301, content: "second", tags: [["d", "task-1"]] },
      { relayUrls: ["wss://relay.one"], signer: generateSecretKey(), replaceableKey: "task:1", debounceMs: 200 },
    );

    await Promise.all([first, second]);

    assert.deepEqual(publishedContents, ["second"]);
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});
