// Flattening helper for the virtualized upcoming-grouped view (Item #11).
//
// `react-virtual` needs a flat row array to virtualize over. We flatten
// `{group → header, ...events, ...tasks}` into a single linear list and also
// build a `dateKey → first-row-index` map that the page's
// `scrollUpcomingToDate` uses with `virtualizer.scrollToIndex` when the target
// day is offscreen (and therefore not rendered in the DOM).

import type { CalendarEvent, Task } from "../domains/tasks/taskTypes";

export type UpcomingGroup = {
  dateKey: string;
  label: string;
  tasks: Task[];
  events: CalendarEvent[];
};

export type UpcomingFlatRow =
  | { kind: "day-header"; dateKey: string; label: string }
  | { kind: "event"; dateKey: string; event: CalendarEvent }
  | { kind: "task"; dateKey: string; task: Task };

export function flattenUpcomingGroups(groups: UpcomingGroup[]): UpcomingFlatRow[] {
  const out: UpcomingFlatRow[] = [];
  for (const group of groups) {
    out.push({ kind: "day-header", dateKey: group.dateKey, label: group.label });
    for (const event of group.events) {
      out.push({ kind: "event", dateKey: group.dateKey, event });
    }
    for (const task of group.tasks) {
      out.push({ kind: "task", dateKey: group.dateKey, task });
    }
  }
  return out;
}

export function buildUpcomingDateKeyIndex(rows: UpcomingFlatRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, idx) => {
    if (row.kind === "day-header" && !map.has(row.dateKey)) {
      map.set(row.dateKey, idx);
    }
  });
  return map;
}
