import { expect, test } from "vitest";
import { applyableScanIds, defaultSelectedScanIds, mergeBoardScanReview } from "./scanReviewState";

const first = [
  { id: "a", title: "A" },
  { id: "already", title: "Already", completed: true },
];
const second = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
];

test("additional scanned pages merge into one deduplicated review", () => {
  expect(mergeBoardScanReview(first, second)).toEqual([
    first[0],
    first[1],
    { id: "b", title: "B" },
  ]);
});

test("already-completed tasks are visible but never selected or applied by default", () => {
  const merged = mergeBoardScanReview(first, second);
  const selected = defaultSelectedScanIds(merged);
  expect([...selected]).toEqual(["a", "b"]);
  expect(applyableScanIds(merged, selected)).toEqual(["a", "b"]);
  expect(applyableScanIds(merged, new Set(["already"]))).toEqual([]);
});
