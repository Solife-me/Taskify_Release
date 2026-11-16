import { expect, test } from "vitest";
import { applyableScanIds, defaultSelectedScanIds, reviewTasksForScan } from "./scanReviewState";

test("uses the live tasks when rendering and applying scanned marks", () => {
  const ids = ["open", "already", "deleted"];
  const open = { id: "open", title: "Current title" };
  const already = { id: "already", title: "Already done", completed: true };
  const catalog = new Map([open, already].map((task) => [task.id, task]));
  const reviewed = reviewTasksForScan(ids, catalog);

  expect(reviewed).toEqual([open, already]);
  expect([...defaultSelectedScanIds(reviewed)]).toEqual(["open"]);
  expect(applyableScanIds(reviewed, new Set(ids))).toEqual(["open"]);
});
