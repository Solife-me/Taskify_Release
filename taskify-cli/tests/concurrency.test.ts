import test from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../src/shared/concurrency.ts";

test("board fetches run a few at a time and keep input order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([5, 1, 4, 2, 3, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [50, 10, 40, 20, 30, 60, 70]);
});

test("an empty list resolves without work", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
});
