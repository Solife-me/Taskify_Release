/**
 * Startup stability tests for the Nostr relay layer.
 *
 * These tests are self-contained (no external imports that require Vite)
 * and validate the core algorithms used in SubscriptionManager and SessionPool
 * to handle high relay event volume safely.
 *
 * Tests cover:
 *  1. All events delivered under high inbound volume (flood test).
 *  2. No crash on malformed / missing-id events.
 *  3. Duplicate events are deduplicated.
 *  4. seenIds are bounded — no unbounded memory growth under flood.
 *  5. Released handlers receive no further events.
 *  6. SessionPool cleanup race — subscription released even when close() fires
 *     before the async subscribe promise resolves.
 *  7. Handler errors are isolated — one bad handler doesn't kill others.
 */
import { test, describe, expect } from "vitest";


// ---------------------------------------------------------------------------
// Inline implementations of the core algorithms (mirrors SubscriptionManager)
// ---------------------------------------------------------------------------

const MAX_SEEN_IDS = 4096;
const FLUSH_BATCH_SIZE = 64;

type NostrEvent = { id: string; kind: number; pubkey: string; created_at: number; tags: string[][]; content: string; sig: string };
type Handler = { onEvent?: (event: NostrEvent, relay?: string) => void };
type PendingEvent = { raw: NostrEvent; relayUrl?: string };
type SubState = {
  handlers: Set<Handler>;
  seenIds: Set<string>;
  pendingEvents: PendingEvent[];
  flushScheduled: boolean;
};

function scheduleFrame(fn: () => void): void {
  setTimeout(fn, 0);
}

function flushPending(state: SubState): void {
  state.flushScheduled = false;
  const batch = state.pendingEvents.splice(0, FLUSH_BATCH_SIZE);
  for (const { raw, relayUrl } of batch) {
    state.handlers.forEach((h) => {
      try {
        h.onEvent?.(raw, relayUrl);
      } catch {
        // isolate handler errors
      }
    });
  }
  if (state.pendingEvents.length > 0) {
    state.flushScheduled = true;
    scheduleFrame(() => flushPending(state));
  }
}

function scheduleFlush(state: SubState): void {
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  scheduleFrame(() => flushPending(state));
}

/** Ingest a raw event through the subscription logic. Returns true if event was accepted. */
function ingestEvent(
  state: SubState,
  rawEventFn: () => NostrEvent | null,
  relayUrl?: string,
): boolean {
  let raw: NostrEvent | null;
  try {
    raw = rawEventFn();
  } catch {
    return false; // malformed: rawEvent() threw
  }
  if (!raw?.id || typeof raw.id !== "string") return false;
  if (state.seenIds.has(raw.id)) return false; // duplicate

  state.seenIds.add(raw.id);
  // Bounded seenIds with FIFO eviction
  if (state.seenIds.size > MAX_SEEN_IDS) {
    const [oldest] = state.seenIds;
    if (oldest) state.seenIds.delete(oldest);
  }

  // Buffer for frame-budgeted dispatch
  state.pendingEvents.push({ raw, relayUrl });
  scheduleFlush(state);
  return true;
}

function makeState(handler?: Handler["onEvent"]): SubState {
  const h: Handler = { onEvent: handler };
  return {
    handlers: new Set(handler ? [h] : []),
    seenIds: new Set(),
    pendingEvents: [],
    flushScheduled: false,
  };
}

function makeEvent(id: string, created_at = 1_700_000_000): NostrEvent {
  return { id, kind: 1, pubkey: "aa", created_at, tags: [], content: "hi", sig: "sig" };
}

function wait(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("delivers all events under high inbound volume (flood test)", async () => {
  const received: string[] = [];
  const state = makeState((ev) => received.push(ev.id));

  const EVENT_COUNT = 300;
  for (let i = 0; i < EVENT_COUNT; i++) {
    ingestEvent(state, () => makeEvent(`evt-${i}`), "wss://relay.test");
  }

  await wait(200);

  expect(received.length).toBe(EVENT_COUNT);
});

test("does not crash on malformed events (rawEvent throws, no id)", async () => {
  const received: string[] = [];
  const state = makeState((ev) => received.push(ev.id));

  // rawEvent() throws
  ingestEvent(state, () => { throw new Error("malformed"); });
  // rawEvent() returns event without id
  ingestEvent(state, () => ({ ...makeEvent("x"), id: "" } as any));
  // null return
  ingestEvent(state, () => null as any);
  // Good event after bad ones
  ingestEvent(state, () => makeEvent("good-1"));

  await wait(50);

  expect(received).toEqual(["good-1"], "Only well-formed events should be delivered");
});

test("deduplicates events with the same id", async () => {
  const received: string[] = [];
  const state = makeState((ev) => received.push(ev.id));

  for (let i = 0; i < 10; i++) {
    ingestEvent(state, () => makeEvent("dup-id"));
  }

  await wait(50);

  expect(received.length).toBe(1);
  expect(received[0]).toBe("dup-id");
});

test("seenIds are bounded — no unbounded memory growth under flood", async () => {
  const state = makeState();

  const OVER_LIMIT = 5_500;
  for (let i = 0; i < OVER_LIMIT; i++) {
    ingestEvent(state, () => makeEvent(`flood-${i}`));
  }

  await wait(200);

  expect(state.seenIds.size).toBeLessThanOrEqual(MAX_SEEN_IDS);
});

test("released handlers receive no further events", async () => {
  const received: string[] = [];
  const h: Handler = { onEvent: (ev) => received.push(ev.id) };
  const state: SubState = {
    handlers: new Set([h]),
    seenIds: new Set(),
    pendingEvents: [],
    flushScheduled: false,
  };

  ingestEvent(state, () => makeEvent("before-release"));
  await wait(50);
  expect(received.length).toBe(1);

  // Release handler
  state.handlers.delete(h);

  ingestEvent(state, () => makeEvent("after-release-1"));
  ingestEvent(state, () => makeEvent("after-release-2"));
  await wait(50);

  expect(received.length).toBe(1);
});

test("handler errors are isolated — one bad handler does not kill others", async () => {
  const received: string[] = [];
  const badHandler: Handler = { onEvent: () => { throw new Error("handler crash"); } };
  const goodHandler: Handler = { onEvent: (ev) => received.push(ev.id) };
  const state: SubState = {
    handlers: new Set([badHandler, goodHandler]),
    seenIds: new Set(),
    pendingEvents: [],
    flushScheduled: false,
  };

  ingestEvent(state, () => makeEvent("test-event-1"));
  ingestEvent(state, () => makeEvent("test-event-2"));
  await wait(50);

  expect(received).toEqual(["test-event-1", "test-event-2"],
    "Good handler should receive events even if another handler throws");
});

test("frame-budgeted batching: large burst does not deliver more than FLUSH_BATCH_SIZE per frame", async () => {
  const batchSizes: number[] = [];
  let batchStart = 0;
  let frameCount = 0;

  // Track how many events arrive per "frame" by measuring delivery in setTimeout(0) slices
  const received: string[] = [];
  const state = makeState((ev) => received.push(ev.id));

  // Override flushScheduled tracking to count frame boundaries
  // We do this by measuring received count changes across ticks
  const BURST = 200;
  for (let i = 0; i < BURST; i++) {
    ingestEvent(state, () => makeEvent(`b-${i}`));
  }

  // Let first frame drain
  await new Promise((resolve) => setTimeout(resolve, 0));
  batchSizes.push(received.length - batchStart);
  batchStart = received.length;
  frameCount++;

  // If there are more events, they'll drain in subsequent frames
  while (batchStart < BURST) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newCount = received.length - batchStart;
    if (newCount > 0) {
      batchSizes.push(newCount);
      batchStart = received.length;
    }
    frameCount++;
    if (frameCount > 20) break; // safety guard
  }

  expect(received.length).toBe(BURST);
  // Each batch should be at most FLUSH_BATCH_SIZE
  for (const size of batchSizes) {
    expect(size).toBeLessThanOrEqual(FLUSH_BATCH_SIZE);
  }
});

test("SessionPool cleanup race: close() before subscribe resolves releases subscription", async () => {
  // This test validates the cleanupRequested flag logic in SessionPool without
  // needing to import the actual module (which has Vite-only deps).
  // We test the same logic inline.

  let releaseCallCount = 0;
  const fakeManaged = { release: () => { releaseCallCount++; } };

  // Simulate the subscribe/subscribeMany pattern from SessionPool
  function simulateSubscribeManyWithRace(simulateEarlyClose: boolean) {
    let release: (() => void) | null = null;
    let cleanupRequested = false;

    let resolvePromise!: (managed: typeof fakeManaged) => void;
    const subscribePromise = new Promise<typeof fakeManaged>((res) => { resolvePromise = res; });

    subscribePromise.then((managed) => {
      if (cleanupRequested) {
        managed.release();
      } else {
        release = managed.release;
      }
    });

    const cleanup = () => {
      cleanupRequested = true;
      release?.();
    };

    if (simulateEarlyClose) cleanup();
    // Resolve the promise (subscription arrives after cleanup was called)
    resolvePromise(fakeManaged);

    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  releaseCallCount = 0;
  await simulateSubscribeManyWithRace(true); // cleanup before promise resolves
  expect(releaseCallCount).toBe(1);

  releaseCallCount = 0;
  await simulateSubscribeManyWithRace(false); // normal case: no early cleanup
  expect(releaseCallCount).toBe(0);
});
