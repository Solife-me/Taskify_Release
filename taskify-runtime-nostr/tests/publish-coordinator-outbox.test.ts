import test from "node:test";
import assert from "node:assert/strict";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { generateSecretKey, type Event, type EventTemplate } from "nostr-tools";
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
    // Relay pacing has its own coordinator suite; these tests isolate durable outbox semantics.
    { outboxStore: store, retryBaseMs: 60_000, publishBudget: false },
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

test("PublishCoordinator treats zero relay acknowledgements as a queued failure", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  NDKEvent.prototype.publish = async function publishMock() {
    return new Set() as never;
  };

  try {
    await assert.rejects(
      coordinator.publish(template, {
        relayUrls: ["wss://relay.one"],
        signer: generateSecretKey(),
      }),
      /No relay acknowledged the write/,
    );
    assert.equal(store.rows.size, 1);
    const [row] = Array.from(store.rows.values());
    assert.deepEqual(row.pendingRelays, ["wss://relay.one"]);
    assert.equal(row.attempts, 1);
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

test("an old publish acknowledgement cannot remove a newer queued replacement", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  let finish!: (value: Set<unknown>) => void;
  NDKEvent.prototype.publish = async function () {
    return await new Promise((resolve) => { finish = resolve as typeof finish; }) as never;
  };
  try {
    const publishing = coordinator.publish(template, { relayUrls: ["wss://relay.one"], signer: generateSecretKey() });
    await waitFor(() => !!finish);
    const current = [...store.rows.values()][0];
    const newer = clone(current);
    newer.payload.event.id = "f".repeat(64);
    newer.payload.event.content = "newer replacement";
    await store.put(newer);
    finish(new Set([relay("wss://relay.one")]));
    await publishing;
    assert.equal(store.rows.get(current.id)?.payload.event.id, newer.payload.event.id);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});

test("a failed durable save prevents sending and does not suppress the next retry", async () => {
  const store = new MemoryOutboxStore();
  store.put = async () => { throw new Error("disk full"); };
  const coordinator = buildCoordinator(store);
  const originalPublish = NDKEvent.prototype.publish;
  let sent = 0;
  NDKEvent.prototype.publish = async () => { sent++; return new Set([relay("wss://relay.one")]) as never; };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(coordinator.publish(template, { relayUrls: ["wss://relay.one"], signer: generateSecretKey() }), /disk full/);
    }
    assert.equal(sent, 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});


test("PublishCoordinator mines the maximum NIP-13 difficulty required by target relays", async () => {
  const store = new MemoryOutboxStore();
  const ndk = {} as NDK;
  const coordinator = new PublishCoordinator(
    ndk,
    async () => relaySet(["wss://relay.example"]) as never,
    undefined,
    {
      outboxStore: store,
      retryBaseMs: 60_000,
      knownProofOfWorkDifficulty: () => 8,
    },
  );
  const originalPublish = NDKEvent.prototype.publish;
  let rawDuringPublish: any;
  NDKEvent.prototype.publish = async function publishMock() {
    rawDuringPublish = this.rawEvent();
    return new Set([relay("wss://relay.example")]) as never;
  };

  try {
    const result = await coordinator.publish(template, {
      relayUrls: ["wss://relay.example"],
      signer: generateSecretKey(),
      returnEvent: true,
    }) as { event: Event };

    assert.ok(Array.isArray(rawDuringPublish.tags));
    const nonce = rawDuringPublish.tags.find((tag: string[]) => tag[0] === "nonce");
    assert.ok(nonce, "mined event must include a nonce tag");
    assert.equal(nonce[2], "8");
    assert.ok(countLeadingZeroBits(rawDuringPublish.id) >= 8);
    assert.equal(result.event.tags.some((tag) => tag[0] === "nonce"), false);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    coordinator.shutdown();
  }
});

test("PublishCoordinator rejects an already-signed event below the required difficulty when no signer is available", async () => {
  const store = new MemoryOutboxStore();
  const coordinator = new PublishCoordinator(
    {} as NDK,
    async () => relaySet(["wss://pow.example"]) as never,
    undefined,
    {
      outboxStore: store,
      retryBaseMs: 60_000,
      knownProofOfWorkDifficulty: () => 8,
    },
  );
  const signed = new NDKEvent({} as any, {
    ...template,
    id: "a".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
  });

  await assert.rejects(
    coordinator.publish(signed, { relayUrls: ["wss://pow.example"] }),
    /original signer is required/i,
  );
  coordinator.shutdown();
});

test("an ordinary acknowledgement can unblock the browser while strict relay delivery continues", async () => {
  const ordinary = "wss://ordinary.example";
  const strict = "wss://strict.example";
  const store = new MemoryOutboxStore();
  const coordinator = new PublishCoordinator({} as NDK, async urls => relaySet(urls ?? []) as never, undefined, {
    outboxStore: store, publishBudget: false, knownProofOfWorkDifficulty: relay => relay === strict ? 8 : 0,
    returnOnFirstAcknowledgement: true,
  });
  const originalPublish = NDKEvent.prototype.publish;
  let releaseStrict!: () => void;
  const holdStrict = new Promise<void>(resolve => { releaseStrict = resolve; });
  NDKEvent.prototype.publish = async function (targets?: { relayUrls?: string[] }) {
    const [url] = targets!.relayUrls!;
    if (url === strict) await holdStrict;
    return new Set([relay(url)]) as never;
  };
  try {
    let acknowledged = false;
    const pending = coordinator.publish(template, { relayUrls: [ordinary, strict], signer: generateSecretKey() })
      .then(() => { acknowledged = true; });
    try {
      await waitFor(() => acknowledged);
      const [row] = Array.from(store.rows.values());
      assert.deepEqual(row.ackedRelays, [ordinary]);
      assert.deepEqual(row.pendingRelays, [strict]);
    } finally {
      releaseStrict();
      await pending;
    }
    await waitFor(() => store.rows.size === 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    await coordinator.shutdown();
  }
});

test("a mined copy survives a session restart and is retried without the signing key", async () => {
  const ordinary = "wss://ordinary.example";
  const strict = "wss://strict.example";
  const store = new MemoryOutboxStore();
  const makeCoordinator = () => new PublishCoordinator({} as NDK, async urls => relaySet(urls ?? []) as never, undefined, {
    outboxStore: store, publishBudget: false, knownProofOfWorkDifficulty: relay => relay === strict ? 8 : 0,
  });
  const first = makeCoordinator();
  const reopened = makeCoordinator();
  const originalPublish = NDKEvent.prototype.publish;
  const calls: Array<{ target: string; id: string }> = [];
  NDKEvent.prototype.publish = async function (targets?: { relayUrls?: string[] }) {
    const [target] = targets!.relayUrls!;
    calls.push({ target, id: this.id });
    if (target === strict && calls.length === 2) throw new Error("offline");
    return new Set([relay(target)]) as never;
  };
  try {
    await first.publish(template, { relayUrls: [ordinary, strict], signer: generateSecretKey() });
    await first.shutdown();
    const [row] = Array.from(store.rows.values());
    assert.equal(row.payload.proofOfWorkEvent?.id, calls[1].id);
    assert.deepEqual(row.ackedRelays, [ordinary]);
    await reopened.drainOutbox({ force: true });
    assert.deepEqual(calls.map(call => call.target), [ordinary, strict, strict]);
    assert.equal(calls[1].id, calls[2].id);
    assert.equal(store.rows.size, 0);
  } finally {
    NDKEvent.prototype.publish = originalPublish;
    await first.shutdown();
    await reopened.shutdown();
  }
});

function countLeadingZeroBits(hex: string): number {
  let count = 0;
  for (const character of hex) {
    const value = Number.parseInt(character, 16);
    if (value === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(value) - 28;
    break;
  }
  return count;
}
