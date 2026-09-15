import { afterEach, expect, test, vi } from "vitest";
import { withTimeout } from "./withTimeout";
afterEach(() => vi.useRealTimers());

test("returns a completed operation and clears its deadline", async () => {
  vi.useFakeTimers();
  await expect(withTimeout(Promise.resolve("done"), 100, "late")).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});
test("preserves operation failures and clears their deadlines", async () => {
  vi.useFakeTimers();
  const error = new Error("operation failed");
  await expect(withTimeout(Promise.reject(error), 100, "late")).rejects.toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});
test("rejects a stalled operation with the caller's timeout message", async () => {
  vi.useFakeTimers();
  const result = withTimeout(new Promise(() => {}), 100, "Push registration timed out");
  const assertion = expect(result).rejects.toThrow("Push registration timed out");
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
