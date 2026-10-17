import { describe, expect, it } from "vitest";
import type { Board, CalendarEvent, Task } from "../tasks/taskTypes";
import { sortBoardTasks } from "../tasks/taskSort";
import {
  boardUpcomingEvents,
  boardUpcomingTasks,
  filterUpcomingEvents,
  filterUpcomingTasks,
  groupUpcomingByDay,
  selectUpcomingEvents,
  selectUpcomingTasks,
  upcomingBoardOrder,
  upcomingDayGroups,
  type UpcomingFilter,
  type UpcomingSortOptions,
} from "./upcomingModel";

const boards = [
  { id: "b1", name: "Home", kind: "week" },
  { id: "b2", name: "Work", kind: "lists", columns: [{ id: "c1", name: "Now" }, { id: "c2", name: "Later" }] },
  { id: "bible", name: "Bible", kind: "bible" },
] as unknown as Board[];
const order = upcomingBoardOrder(boards);

// Noon UTC stays on the same calendar day in every time zone the tests run in.
const day = (date: string, time = "12:00") => `${date}T${time}:00.000Z`;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, boardId: "b1", title: id, dueISO: day("2026-10-20"), completed: false, order: 0, createdAt: 0, ...overrides } as Task;
}

function allDay(id: string, startDate: string, endDate?: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, boardId: "b1", title: id, kind: "date", startDate, ...(endDate ? { endDate } : {}), ...overrides } as CalendarEvent;
}

const sorted = (sort: UpcomingSortOptions["sort"], grouping: UpcomingSortOptions["grouping"] = "mixed" as never): UpcomingSortOptions =>
  ({ sort, grouping, boardOrder: order });

describe("selecting upcoming items", () => {
  it("keeps open, dated tasks on visible boards other than messages", () => {
    const tasks = [
      task("ok"),
      task("done", { completed: true }),
      task("undated", { dueDateEnabled: false }),
      task("bad", { dueISO: "nope" }),
      task("hidden-board", { boardId: "elsewhere" }),
      task("messages", { boardId: "b2" }),
    ];
    expect(selectUpcomingTasks(tasks, { boardOrder: order, messagesBoardId: "b2" }).map((t) => t.id)).toEqual(["ok"]);
  });

  it("keeps external calendars and adds holidays only when asked", () => {
    const events = [allDay("ok", "2026-10-20"), allDay("bad", "20-10"), { ...allDay("ext", "2026-10-20", undefined, { boardId: "x" }), external: true } as CalendarEvent];
    const holiday = allDay("holiday", "2026-12-25");
    expect(selectUpcomingEvents(events, { boardOrder: order, holidays: null }).map((e) => e.id)).toEqual(["ok", "ext"]);
    expect(selectUpcomingEvents(events, { boardOrder: order, holidays: [holiday] }).map((e) => e.id)).toEqual(["ok", "ext", "holiday"]);
  });
});

describe("filtering", () => {
  const filter = (overrides: Partial<UpcomingFilter>): UpcomingFilter => ({
    selection: null,
    hasOptions: true,
    map: { selectedBoards: new Set(), selectedLists: new Map() },
    boardMap: new Map(boards.map((b) => [b.id, b])),
    searchTerm: "",
    ...overrides,
  });
  const tasks = [task("home"), task("now", { boardId: "b2", columnId: "c1" }), task("later", { boardId: "b2", columnId: "c2", note: "Groceries" })];

  it("shows everything with no selection and nothing with an empty one", () => {
    expect(filterUpcomingTasks(tasks, filter({})).length).toBe(3);
    expect(filterUpcomingTasks(tasks, filter({ selection: [] }))).toEqual([]);
  });

  it("filters by board and by list", () => {
    const byBoard = filter({ selection: ["b1"], map: { selectedBoards: new Set(["b1"]), selectedLists: new Map() } });
    expect(filterUpcomingTasks(tasks, byBoard).map((t) => t.id)).toEqual(["home"]);
    const byList = filter({ selection: ["b2:c2"], map: { selectedBoards: new Set(), selectedLists: new Map([["b2", new Set(["c2"])]]) } });
    expect(filterUpcomingTasks(tasks, byList).map((t) => t.id)).toEqual(["later"]);
  });

  it("searches titles and notes, and event text", () => {
    expect(filterUpcomingTasks(tasks, filter({ searchTerm: "groceries" })).map((t) => t.id)).toEqual(["later"]);
    const events = [allDay("Party", "2026-10-20", undefined, { locations: ["Park"] }), allDay("Meeting", "2026-10-20")];
    expect(filterUpcomingEvents(events, filter({ searchTerm: "park" }), false).map((e) => e.id)).toEqual(["Party"]);
  });
});

describe("sorting and grouping by day", () => {
  it("orders a day's tasks by time, then board, then manual order", () => {
    const tasks = [
      task("work", { boardId: "b2" }),
      task("late", { dueISO: day("2026-10-20", "18:00"), dueTimeEnabled: true }),
      task("early", { dueISO: day("2026-10-20", "08:00"), dueTimeEnabled: true }),
      task("home-2", { order: 2 }),
      task("home-1", { order: 1 }),
    ];
    const [group] = upcomingDayGroups(groupUpcomingByDay(tasks, [], sorted({ mode: "due", direction: "asc" })));
    expect(group.tasks.map((t) => t.id)).toEqual(["early", "late", "home-1", "home-2", "work"]);
  });

  it("puts boards first when grouped, and sorts by title when asked", () => {
    const tasks = [task("b", { boardId: "b2" }), task("c"), task("a")];
    const grouped = groupUpcomingByDay(tasks, [], sorted({ mode: "alpha", direction: "asc" }, "grouped"));
    expect(upcomingDayGroups(grouped)[0].tasks.map((t) => t.id)).toEqual(["a", "c", "b"]);
    const mixed = groupUpcomingByDay(tasks, [], sorted({ mode: "alpha", direction: "desc" }));
    expect(upcomingDayGroups(mixed)[0].tasks.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("shows a multi-day event on each day and all-day events before timed ones", () => {
    const events = [
      { id: "timed", boardId: "b1", title: "timed", kind: "time", startISO: day("2026-10-21", "09:00") } as CalendarEvent,
      allDay("trip", "2026-10-20", "2026-10-22"),
      allDay("inverted", "2026-10-23", "2026-10-01"),
    ];
    const groups = upcomingDayGroups(groupUpcomingByDay([], events, sorted({ mode: "due", direction: "asc" })));
    expect(groups.map((g) => [g.dateKey, g.events.map((e) => e.id)])).toEqual([
      ["2026-10-20", ["trip"]],
      ["2026-10-21", ["trip", "timed"]],
      ["2026-10-22", ["trip"]],
      ["2026-10-23", ["inverted"]],
    ]);
  });

  it("keeps only days after today in a board's upcoming section", () => {
    const tasks = [task("today", { dueISO: day("2026-10-20") }), task("tomorrow", { dueISO: day("2026-10-21") })];
    const events = [allDay("spans", "2026-10-19", "2026-10-21"), allDay("past", "2026-10-18")];
    const cutoff = "2026-10-20";
    expect(boardUpcomingTasks(tasks, cutoff).map((t) => t.id)).toEqual(["tomorrow"]);
    expect(boardUpcomingEvents(events, cutoff).map((e) => e.id)).toEqual(["spans"]);
    const groups = upcomingDayGroups(groupUpcomingByDay(tasks, events, { ...sorted({ mode: "due", direction: "asc" }), after: cutoff }));
    expect(groups.map((g) => [g.dateKey, g.tasks.length, g.events.length])).toEqual([["2026-10-21", 1, 1]]);
  });
});

describe("board sort", () => {
  it("puts open tasks first and falls back to the default order", () => {
    const tasks = [
      task("done", { completed: true, priority: 3 } as Partial<Task>),
      task("low", { priority: 1 } as Partial<Task>),
      task("high", { priority: 3 } as Partial<Task>),
    ];
    expect(sortBoardTasks(tasks, { mode: "priority", direction: "desc" }).map((t) => t.id)).toEqual(["high", "low", "done"]);
    expect(sortBoardTasks([task("b", { order: 2 }), task("a", { order: 1 })], { mode: "manual", direction: "asc" }).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
