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
