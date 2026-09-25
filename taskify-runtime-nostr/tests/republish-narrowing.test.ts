import test from "node:test";
import assert from "node:assert/strict";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { generateSecretKey } from "nostr-tools";
import {
  PublishCoordinator,
  RelayPublishBudget,
  narrowRepublishedMutations,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "../dist/index.js";

const SOLIFE = "wss://relay.solife.me";
const DAMUS = "wss://relay.damus.io";
const NOS = "wss://nos.lol";
let counter = 0;

function row(args: { board?: string; relays?: string[]; acked?: string[]; republish?: boolean; intentAt?: number } = {}): NostrOutboxMutation {
  counter += 1;
  const relays = args.relays ?? [NOS, DAMUS, SOLIFE];
  const acked = args.acked ?? [];
  const mutation: NostrOutboxMutation = {
    id: `row-${counter}`,
    kind: "nostr.publish",
    payload: {
      event: { id: counter.toString(16).padStart(64, "0"), pubkey: "a".repeat(64), created_at: 1, kind: 30301, tags: [["d", `t${counter}`], ["b", args.board ?? "board"]], content: "", sig: "" },
      relayUrls: relays,
    },
    intentAt: args.intentAt ?? 1_000,
    attempts: 0,
    lastError: null,
    ackedRelays: acked,
    pendingRelays: relays.filter((relay) => !acked.includes(relay)),
    nextAttemptAt: null,
    updatedAt: 0,
  };
  if (args.republish !== undefined) mutation.isRepublish = args.republish;
  return mutation;
}

test("republished rows keep only Taskify's relays, and one already there is complete", () => {
  const pending = row({ republish: true });
  const partlyPublic = row({ republish: true, acked: [NOS] });
  const delivered = row({ republish: true, acked: [SOLIFE] });
  const { updated, completedIds } = narrowRepublishedMutations([pending, partlyPublic, delivered], { boardTag: "board", keptRelayUrls: [SOLIFE] });
  assert.deepEqual(updated.map((r) => r.pendingRelays), [[SOLIFE], [SOLIFE]]);
  assert.deepEqual(updated[1].payload.relayUrls, [NOS, SOLIFE], "a recorded acceptance is kept");
  assert.deepEqual(completedIds, [delivered.id]);
});

test("ordinary changes, rows without a Taskify relay, and other boards are untouched", () => {
  const rows = [row({ republish: false }), row({ republish: true, relays: [NOS, DAMUS] }), row({ republish: true, board: "other" })];
  const { updated, completedIds } = narrowRepublishedMutations(rows, { boardTag: "board", keptRelayUrls: [SOLIFE] });
  assert.equal(updated.length, 0);
  assert.equal(completedIds.length, 0);
});

test("rows from before the flag treat a board-sized burst as a republish", () => {
  const burst = Array.from({ length: 60 }, (_, i) => row({ intentAt: 10_000 + i * 200 }));
  const scattered = [1, 2, 3].map((i) => row({ intentAt: 10_000_000 * i }));
  const { updated } = narrowRepublishedMutations([...burst, ...scattered], { boardTag: "board", keptRelayUrls: [SOLIFE] });
  assert.equal(updated.length, 60);
  assert.ok(updated.every((r) => burst.some((b) => b.id === r.id)));
});

class MemoryOutboxStore implements NostrOutboxStore {
  rows = new Map<string, NostrOutboxMutation>();
  async get(id: string) { const r = this.rows.get(id); return r && JSON.parse(JSON.stringify(r)); }
  async put(m: NostrOutboxMutation) { this.rows.set(m.id, JSON.parse(JSON.stringify(m))); }
  async delete(id: string) { this.rows.delete(id); }
  async listPending() { return Array.from(this.rows.values()).map((r) => JSON.parse(JSON.stringify(r))); }
}

test("a republish publish is flagged in the outbox and can be limited to Taskify's relays", async () => {
  const store = new MemoryOutboxStore();
  const publisher = new PublishCoordinator(
    {} as NDK,
    async (relayUrls) => ({ relayUrls: relayUrls || [], relays: new Set((relayUrls || []).map((url) => ({ url }))) }) as never,
    undefined,
    { outboxStore: store, retryBaseMs: 60_000, publishBudget: new RelayPublishBudget({ firstPartyRelays: [] }) },
  );
  const original = NDKEvent.prototype.publish;
  // No relay answers, so everything stays queued.
  NDKEvent.prototype.publish = async function () { return new Set() as never; };
  try {
    const signer = generateSecretKey();
    const template = (d: string) => ({ kind: 1, content: d, tags: [["b", "board"]], created_at: 1_790_000_000 });
    await publisher.publish(template("republished"), { relayUrls: [NOS, SOLIFE], signer, republish: true }).catch(() => {});
    await publisher.publish(template("edit"), { relayUrls: [NOS, SOLIFE], signer }).catch(() => {});
    const before = Array.from(store.rows.values());
    assert.deepEqual(before.map((r) => r.isRepublish).sort(), [false, true]);

    const changed = await publisher.limitQueuedRepublish("board");
    assert.equal(changed, 1);
    const after = Array.from(store.rows.values());
    const republished = after.find((r) => r.isRepublish)!;
    const edit = after.find((r) => !r.isRepublish)!;
    assert.deepEqual(republished.pendingRelays, [SOLIFE]);
    assert.deepEqual(edit.pendingRelays.sort(), [NOS, SOLIFE].sort());
  } finally {
    NDKEvent.prototype.publish = original;
    publisher.shutdown();
  }
});
