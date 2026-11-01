import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RelayPublishBudget, type NostrOutboxMutation } from "taskify-runtime-nostr";
import {
  collectCliRelayUrls,
  FileNostrOutboxStore,
  FileRelayPublishBudgetStateStore,
} from "../src/shared/nodeRuntimeSession.ts";

function mutation(id: string): NostrOutboxMutation {
  return {
    id,
    kind: "nostr.publish",
    payload: {
      event: {
        id: "0".repeat(64),
        pubkey: "1".repeat(64),
        sig: "2".repeat(128),
        kind: 1,
        created_at: 1,
        tags: [],
        content: "test",
      },
      relayUrls: ["wss://relay.example"],
    },
    intentAt: 1,
    attempts: 0,
    lastError: null,
    ackedRelays: [],
    pendingRelays: ["wss://relay.example"],
    nextAttemptAt: null,
    updatedAt: 1,
  };
}

test("FileNostrOutboxStore persists pending writes across instances", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskify-outbox-"));
  try {
    const file = path.join(dir, "outbox.json");
    const first = new FileNostrOutboxStore(file);
    await first.put(mutation("write-1"));
    const second = new FileNostrOutboxStore(file);
    assert.equal((await second.get("write-1"))?.id, "write-1");
    assert.equal((await second.listPending()).length, 1);
    await second.delete("write-1");
    assert.equal(await first.get("write-1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI relay pacing and rate-limit backoff persist across process-like budget instances", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskify-relay-budget-"));
  try {
    const file = path.join(dir, "budget.json");
    const options = () => ({
      burst: 2,
      refillIntervalMs: 10_000,
      refillJitterMs: 0,
      rateLimitBackoffMs: 20_000,
      stateStore: new FileRelayPublishBudgetStateStore(file),
    });
    const now = 1_000_000;
    const firstRun = new RelayPublishBudget(options());
    assert.deepEqual(firstRun.take(["wss://relay.damus.io"], now).ready, ["wss://relay.damus.io"]);
    assert.deepEqual(firstRun.take(["wss://relay.damus.io"], now).ready, ["wss://relay.damus.io"]);

    const nextRun = new RelayPublishBudget(options());
    const paced = nextRun.take(["wss://relay.damus.io"], now);
    assert.deepEqual(paced.ready, []);
    assert.equal(paced.deferredUntil, now + 10_000);

    nextRun.recordRateLimited("wss://relay.damus.io", now);
    const afterRejection = new RelayPublishBudget(options()).take(["wss://relay.damus.io"], now + 10_000);
    assert.deepEqual(afterRejection.ready, []);
    assert.equal(afterRejection.deferredUntil, now + 20_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI relay discovery keeps Taskify defaults alongside account and board relays", () => {
  const relays = collectCliRelayUrls({
    relays: ["wss://account.example"],
    boards: [{ id: "board-1", name: "Work", relays: ["wss://board.example"] }],
  });
  assert.deepEqual(relays, [
    "wss://account.example",
    "wss://board.example",
    "wss://nos.lol",
    "wss://relay.damus.io",
    "wss://relay.solife.me",
  ]);
});
