import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NostrOutboxMutation } from "taskify-runtime-nostr";
import { collectCliRelayUrls, FileNostrOutboxStore } from "../src/shared/nodeRuntimeSession.ts";

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
