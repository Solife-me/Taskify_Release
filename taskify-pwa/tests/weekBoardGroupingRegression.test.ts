import { test, describe, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("week board task grouping uses dueTimeZone when resolving weekday", () => {
  const appPath = resolve(process.cwd(), "src/App.tsx");
  const source = readFileSync(appPath, "utf8");

  expect(source).toMatch(/function\s+taskWeekday\s*\(task:\s*Task\)\s*:\s*Weekday\s*\|\s*null\s*\{[\s\S]*?weekdayFromISO\(task\.dueISO,\s*task\.dueTimeZone\)/,
    "Expected taskWeekday() to pass task.dueTimeZone into weekdayFromISO()",);
});
