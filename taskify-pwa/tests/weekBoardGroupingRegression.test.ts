import { test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression test for: week-board grouping must use the task's stored
// `dueTimeZone` when resolving the weekday (so a task due "Wed 11pm Pacific"
// doesn't show up on Thursday for a viewer in UTC).
//
// `taskWeekday` originally lived in App.tsx; it was moved to
// `src/domains/dateTime/dateUtils.ts` during a dedup pass, so the assertion
// now checks the canonical implementation in its new home.
test("week board task grouping uses dueTimeZone when resolving weekday", () => {
  const path = resolve(process.cwd(), "src/domains/dateTime/dateUtils.ts");
  const source = readFileSync(path, "utf8");

  expect(source).toMatch(
    /function\s+taskWeekday\s*\(task:\s*Task\)\s*:\s*Weekday\s*\|\s*null\s*\{[\s\S]*?weekdayFromISO\(task\.dueISO,\s*task\.dueTimeZone\)/,
  );
});
