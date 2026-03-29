import { test, describe, expect } from "vitest";

import { RelayHealthTracker } from "./RelayHealth.ts";

const RELAY = "wss://relay.example.com";
const RELAY_B = "wss://relay-b.example.com";

// --- canAttempt ---

test("canAttempt returns true for unknown relay", () => {
  const tracker = new RelayHealthTracker();
  expect(tracker.canAttempt(RELAY)).toBe(true);
});

test("canAttempt returns true immediately after markSuccess", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  tracker.markSuccess(RELAY);
  expect(tracker.canAttempt(RELAY)).toBe(true);
});

test("canAttempt returns false immediately after markFailure", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  expect(tracker.canAttempt(RELAY)).toBe(false);
});

// --- nextAttemptIn ---

test("nextAttemptIn returns 0 for unknown relay", () => {
  const tracker = new RelayHealthTracker();
  expect(tracker.nextAttemptIn(RELAY)).toBe(0);
});

test("nextAttemptIn returns 0 after markSuccess", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  tracker.markSuccess(RELAY);
  expect(tracker.nextAttemptIn(RELAY)).toBe(0);
});

test("nextAttemptIn returns positive number after markFailure", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  expect(tracker.nextAttemptIn(RELAY)).toBeGreaterThan(0);
});

// --- markSuccess clears state ---

test("markSuccess resets consecutiveFailures to 0", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  tracker.markFailure(RELAY);
  tracker.markSuccess(RELAY);
  const state = tracker.status(RELAY);
  expect(state).not.toBeNull();
  expect(state!.consecutiveFailures).toBe(0);
});

test("markSuccess sets lastSuccessAt", () => {
  const tracker = new RelayHealthTracker();
  const before = Date.now();
  tracker.markSuccess(RELAY);
  const state = tracker.status(RELAY);
  expect(state).not.toBeNull();
  expect(state!.lastSuccessAt).toBeDefined();
  expect(state!.lastSuccessAt!).toBeGreaterThanOrEqual(before);
});

test("markSuccess clears nextAllowedAttemptAt", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  tracker.markSuccess(RELAY);
  const state = tracker.status(RELAY);
  expect(state).not.toBeNull();
  expect(state!.nextAllowedAttemptAt).toBe(undefined);
});

// --- markFailure increments ---

test("markFailure increments consecutiveFailures", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  expect(tracker.status(RELAY)!.consecutiveFailures).toBe(1);
  tracker.markFailure(RELAY);
  expect(tracker.status(RELAY)!.consecutiveFailures).toBe(2);
});

test("markFailure sets lastFailureAt", () => {
  const tracker = new RelayHealthTracker();
  const before = Date.now();
  tracker.markFailure(RELAY);
  const state = tracker.status(RELAY);
  expect(state!.lastFailureAt).toBeDefined();
  expect(state!.lastFailureAt!).toBeGreaterThanOrEqual(before);
});

test("markFailure sets nextAllowedAttemptAt in the future", () => {
  const tracker = new RelayHealthTracker();
  const before = Date.now();
  tracker.markFailure(RELAY);
  const state = tracker.status(RELAY);
  expect(state!.nextAllowedAttemptAt).toBeDefined();
  expect(state!.nextAllowedAttemptAt!).toBeGreaterThan(before);
});

// --- severity weighting ---

test("markFailure with low severity results in strictly smaller backoff than normal after multiple failures", () => {
  // On the first failure, raw low backoff (2500ms) is floored to BASE_BACKOFF_MS (5000ms) — same as normal.
  // Severity weight only visibly separates the two when the exponent is large enough to exceed the floor.
  // At 3 failures: low = 5000*2^2*0.5 = 10000ms, normal = 5000*2^2*1 = 20000ms.
  // Jitter is ±10% (±1000ms vs ±2000ms) so the ranges [9000,11000] and [18000,22000] never overlap.
  const trackerLow = new RelayHealthTracker();
  const trackerNormal = new RelayHealthTracker();
  for (let i = 0; i < 3; i++) {
    trackerLow.markFailure(RELAY, { severity: "low" });
    trackerNormal.markFailure(RELAY);
  }
  const low = trackerLow.nextAttemptIn(RELAY);
  const normal = trackerNormal.nextAttemptIn(RELAY);
  expect(low).toBeLessThan(normal);
});

test("markFailure with high severity results in larger backoff than normal", () => {
  const trackerHigh = new RelayHealthTracker();
  const trackerNormal = new RelayHealthTracker();
  trackerHigh.markFailure(RELAY, { severity: "high" });
  trackerNormal.markFailure(RELAY);
  const high = trackerHigh.nextAttemptIn(RELAY);
  const normal = trackerNormal.nextAttemptIn(RELAY);
  expect(high).toBeGreaterThan(normal);
});

// --- exponential backoff grows with failures ---

test("backoff grows with consecutive failures", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  const first = tracker.nextAttemptIn(RELAY);
  tracker.markFailure(RELAY);
  const second = tracker.nextAttemptIn(RELAY);
  expect(second).toBeGreaterThan(first);
});

// --- relay isolation ---

test("failure on one relay does not affect another", () => {
  const tracker = new RelayHealthTracker();
  tracker.markFailure(RELAY);
  expect(tracker.canAttempt(RELAY_B)).toBe(true);
});

test("status returns null for unknown relay", () => {
  const tracker = new RelayHealthTracker();
  expect(tracker.status(RELAY)).toBe(null);
});

// --- onBackoffExpiry ---

test("onBackoffExpiry fires immediately if relay is healthy", () =>
  new Promise<void>((resolve) => {
    const tracker = new RelayHealthTracker();
    tracker.onBackoffExpiry(RELAY, () => resolve());
  }));

test("onBackoffExpiry fires immediately after markSuccess", () =>
  new Promise<void>((resolve) => {
    const tracker = new RelayHealthTracker();
    tracker.markFailure(RELAY);
    tracker.markSuccess(RELAY);
    tracker.onBackoffExpiry(RELAY, () => resolve());
  }));
