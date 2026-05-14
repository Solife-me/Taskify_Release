import { describe, expect, test } from "vitest";
import {
  flattenUpcomingGroups,
  buildUpcomingDateKeyIndex,
  type UpcomingGroup,
} from "./upcomingRows";

// Minimal task/event factories — types are deep so cast through `unknown` to
// keep the test focused on the flattening logic, not domain validation.
function task(id: string) {
  return { id, title: `task ${id}` } as unknown as UpcomingGroup["tasks"][number];
}
function event(id: string) {
  return { id, title: `event ${id}` } as unknown as UpcomingGroup["events"][number];
}

describe("flattenUpcomingGroups", () => {
  test("empty input yields empty output", () => {
    expect(flattenUpcomingGroups([])).toEqual([]);
  });

  test("one group emits header → events → tasks in order", () => {
    const groups: UpcomingGroup[] = [
      {
        dateKey: "2026-05-10",
        label: "Sun, May 10",
        events: [event("e1"), event("e2")],
        tasks: [task("t1")],
      },
    ];
    const rows = flattenUpcomingGroups(groups);
    expect(rows.map((r) => r.kind)).toEqual(["day-header", "event", "event", "task"]);
    expect(rows[0]).toMatchObject({ kind: "day-header", dateKey: "2026-05-10", label: "Sun, May 10" });
    expect((rows[1] as { event: { id: string } }).event.id).toBe("e1");
    expect((rows[3] as { task: { id: string } }).task.id).toBe("t1");
  });

  test("multiple groups are concatenated in input order", () => {
    const groups: UpcomingGroup[] = [
      { dateKey: "d1", label: "Day 1", events: [], tasks: [task("a")] },
      { dateKey: "d2", label: "Day 2", events: [event("x")], tasks: [task("b")] },
    ];
    const rows = flattenUpcomingGroups(groups);
    expect(rows.map((r) => r.kind)).toEqual(["day-header", "task", "day-header", "event", "task"]);
    expect((rows[0] as { dateKey: string }).dateKey).toBe("d1");
    expect((rows[2] as { dateKey: string }).dateKey).toBe("d2");
  });

  test("scales to 5000 items in O(N) (no quadratic blowup)", () => {
    const groups: UpcomingGroup[] = [];
    let id = 0;
    for (let d = 0; d < 500; d++) {
      const tasks = Array.from({ length: 10 }, () => task(`t${id++}`));
      groups.push({ dateKey: `2026-05-${String(d).padStart(2, "0")}`, label: `day ${d}`, events: [], tasks });
    }
    const start = performance.now();
    const rows = flattenUpcomingGroups(groups);
    const elapsedMs = performance.now() - start;
    expect(rows.length).toBe(500 + 5000); // 500 headers + 5000 tasks
    expect(elapsedMs).toBeLessThan(50); // well under 50ms on any modern machine
  });
});

describe("buildUpcomingDateKeyIndex", () => {
  test("maps each dateKey to its header row index", () => {
    const groups: UpcomingGroup[] = [
      { dateKey: "d1", label: "Day 1", events: [], tasks: [task("a"), task("b")] },
      { dateKey: "d2", label: "Day 2", events: [event("e")], tasks: [] },
      { dateKey: "d3", label: "Day 3", events: [], tasks: [task("c")] },
    ];
    const rows = flattenUpcomingGroups(groups);
    const index = buildUpcomingDateKeyIndex(rows);
    // d1 header is at 0, d2 header is at 3 (after d1 header + 2 tasks), d3 header at 5 (after d2 header + 1 event)
    expect(index.get("d1")).toBe(0);
    expect(index.get("d2")).toBe(3);
    expect(index.get("d3")).toBe(5);
  });

  test("returns empty map for empty input", () => {
    expect(buildUpcomingDateKeyIndex([])).toEqual(new Map());
  });
});
