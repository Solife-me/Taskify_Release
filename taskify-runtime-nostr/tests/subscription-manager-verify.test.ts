import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { CursorStore, EventCache, SubscriptionManager } from "../dist/index.js";

function buildMockNdk() {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const sub = {
    on(event: string, handler: (arg: unknown) => void) {
      (handlers[event] ||= []).push(handler);
    },
    stop() {},
  };
  const ndk = {
    subscribe() {
      return sub;
    },
  };
  const fire = (event: string, arg: unknown) => {
    (handlers[event] || []).forEach((h) => h(arg));
  };
  return { ndk, fire };
}

test("SubscriptionManager drops events with invalid signatures", async () => {
  const sk = generateSecretKey();
  const valid = finalizeEvent(
    { kind: 1, content: "valid", tags: [], created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
  // Forge: change content but keep id/sig from the valid event.
  // verifyEvent recomputes the id from (pubkey,kind,tags,content,created_at)
  // and rejects when it doesn't match the stored id.
  const forged = { ...valid, content: "tampered" };

  const { ndk, fire } = buildMockNdk();
  const sm = new SubscriptionManager(
    ndk as never,
    new CursorStore(),
    async () => undefined,
    new EventCache(256),
  );

  const received: Array<{ id: string }> = [];
  await sm.subscribe([{ kinds: [1] }], {
    onEvent: (e: { id: string }) => received.push(e),
  });

  const wrap = (raw: unknown) => ({ rawEvent: () => raw, relay: undefined });
  fire("event", wrap(valid));
  fire("event", wrap(forged));

  // Allow scheduleFrame (setTimeout fallback in Node) to flush pendingEvents.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(received.length, 1, "only the valid event should reach the handler");
  assert.equal(received[0].id, valid.id);
});

test("only matching, delivered history advances its cursor after EOSE", async () => {
  const sk = generateSecretKey();
  const { ndk, fire } = buildMockNdk();
  const cursors = new CursorStore();
  const sm = new SubscriptionManager(ndk as never, cursors, async () => undefined);
  const one = { kinds: [1] }; const two = { kinds: [2] };
  const received: string[] = [];
  await sm.subscribe([one, two], { onEvent: (event) => received.push(event.id) });
  const valid = finalizeEvent({ kind: 1, content: "valid", tags: [], created_at: 1000 }, sk);
  const unrelated = finalizeEvent({ kind: 3, content: "unrequested", tags: [], created_at: 9999 }, sk);
  const forged = { ...valid, content: "forged" };
  const wrap = (raw: unknown) => ({ rawEvent: () => raw });
  fire("event", wrap(forged)); // A bad copy arriving first must not poison deduplication.
  fire("event", wrap(unrelated));
  fire("event", wrap(valid));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, [valid.id]);
  assert.equal(cursors.getSince(one), undefined, "partial history is not a completed cursor");
  fire("eose", undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cursors.getSince(one), 940);
  assert.equal(cursors.getSince(two), undefined, "OR filters advance independently");
  sm.shutdown();
});

test("simultaneous identical subscriptions share one transport subscription", async () => {
  let calls = 0;
  const ndk = { subscribe() { calls++; return { on() {}, stop() {} }; } };
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const sm = new SubscriptionManager(ndk as never, new CursorStore(), async () => { await gate; return undefined; });
  const a = sm.subscribe({ kinds: [1] });
  const b = sm.subscribe({ kinds: [1] });
  ready();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(first.subscription, second.subscription);
  first.release(); second.release();
});
