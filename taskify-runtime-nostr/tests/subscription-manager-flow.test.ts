/**
 * Event delivery under load, on the real SubscriptionManager. These scenarios used to run against
 * a copy of its algorithm inside the PWA (startupStability.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { CursorStore, SubscriptionManager } from "../dist/index.js";

const SK = generateSecretKey();
const sign = (n: number) =>
  finalizeEvent({ kind: 1, content: `event ${n}`, tags: [], created_at: 1_700_000_000 + n }, SK);

function harness() {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const ndk = {
    subscribe() {
      return {
        on(event: string, handler: (arg: unknown) => void) {
          (handlers[event] ||= []).push(handler);
        },
        stop() {},
      };
    },
  };
  const manager = new SubscriptionManager(ndk as never, new CursorStore(), async () => undefined);
  const fire = (event: string, arg: unknown) => (handlers[event] || []).forEach((handler) => handler(arg));
  const send = (raw: unknown, relay = "wss://relay.test") => fire("event", { rawEvent: () => raw, relay: { url: relay } });
  const sendThrowing = () => fire("event", { rawEvent: () => { throw new Error("malformed"); } });
  return { manager, fire, send, sendThrowing };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function drain(received: unknown[], expected: number, limitMs = 2_000) {
  const start = Date.now();
  while (received.length < expected && Date.now() - start < limitMs) await settle(5);
}

test("delivers every event of a flood", async () => {
  const { manager, send } = harness();
  const received: string[] = [];
  await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  for (let i = 0; i < 300; i += 1) send(sign(i));
  await drain(received, 300);
  assert.equal(received.length, 300);
});

test("malformed events are dropped without stopping delivery", async () => {
  const { manager, send, sendThrowing } = harness();
  const received: string[] = [];
  await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  sendThrowing();
  send({ ...sign(1), id: "" });
  send(null);
  const good = sign(2);
  send(good);
  await settle();
  assert.deepEqual(received, [good.id]);
});

test("the same event from several relays is delivered once", async () => {
  const { manager, send } = harness();
  const received: string[] = [];
  await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  const event = sign(7);
  for (let i = 0; i < 10; i += 1) send(event, `wss://relay-${i}.test`);
  await settle();
  assert.deepEqual(received, [event.id]);
});

test("remembered ids are bounded: the oldest is forgotten past 4,096", async () => {
  const { manager, send } = harness();
  const received: string[] = [];
  await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  const events = Array.from({ length: 4_100 }, (_, i) => sign(i));
  for (const event of events) send(event);
  await drain(received, events.length, 10_000);
  send(events[0]); // forgotten, so it is delivered again
  send(events[4_099]); // still remembered
  await drain(received, events.length + 1);
  await settle();
  assert.equal(received.length, events.length + 1);
  assert.equal(received[received.length - 1], events[0].id);
});

test("a released handler receives nothing more", async () => {
  const { manager, send } = harness();
  const received: string[] = [];
  const managed = await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  send(sign(1));
  await settle();
  managed.release();
  send(sign(2));
  await settle();
  assert.equal(received.length, 1);
});

test("one failing handler does not stop the others", async () => {
  const { manager, send } = harness();
  const received: string[] = [];
  await manager.subscribe([{ kinds: [1] }], { onEvent: () => { throw new Error("handler crash"); } });
  await manager.subscribe([{ kinds: [1] }], { onEvent: (event: { id: string }) => received.push(event.id) });
  const first = sign(1);
  const second = sign(2);
  send(first);
  send(second);
  await settle();
  assert.deepEqual(received, [first.id, second.id]);
});

test("EOSE waits until buffered events are delivered, a frame's batch at a time", async () => {
  const { manager, send, fire } = harness();
  const received: string[] = [];
  const eose: Array<string | undefined> = [];
  const perTick: number[] = [];
  await manager.subscribe([{ kinds: [1] }], {
    onEvent: (event: { id: string }) => received.push(event.id),
    onEose: (relay?: string) => eose.push(relay),
  });
  for (let i = 0; i < 200; i += 1) send(sign(i));
  fire("eose", { url: "wss://relay.test" });
  assert.deepEqual(eose, []);
  let last = 0;
  for (let tick = 0; tick < 40 && received.length < 200; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    perTick.push(received.length - last);
    last = received.length;
  }
  await settle();
  assert.equal(received.length, 200);
  assert.ok(perTick.every((count) => count <= 64), `at most 64 per frame, got ${perTick.join(",")}`);
  assert.equal(eose.length, 1);
});
