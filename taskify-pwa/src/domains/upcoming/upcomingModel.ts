/**
 * What Upcoming shows and in what order: which tasks and events are upcoming, the board/list
 * filter and search, sorting, and grouping by day. Pure, so the Upcoming page and a board's
 * "upcoming" section share one definition.
 */
import {
  ISO_DATE_PATTERN,
  isExternalCalendarEvent,
  isoDatePart,
  isoTimePart,
  parseDateKey,
  parseTimeValue,
} from "taskify-core";
import { isUsHolidayCalendarEvent } from "../calendar/holidayUtils";
import { formatUpcomingDayLabel, taskDisplayDateKey, taskTimeValue } from "../dateTime/dateUtils";
import { compareAlpha, compareBySortMode, compareDefault, titleCollator, type TaskSort } from "../tasks/taskSort";
import type { Board, CalendarEvent, Task, UpcomingBoardGrouping } from "../tasks/taskTypes";
import { DEFAULT_BOARD_SORT_DIRECTION, type BoardSortDirection } from "../tasks/taskUtils";

/** Upcoming lists boards in the order the user sees them; Bible boards have no dated items. */
export type UpcomingBoardOrder = {
  visibleIds: Set<string>;
  boardOrder: Map<string, number>;
  fallbackBoardOrder: number;
};

export function upcomingBoardOrder(visibleBoards: Board[]): UpcomingBoardOrder {
  const ordered = visibleBoards.filter((board) => board.kind !== "bible");
  return {
    visibleIds: new Set(ordered.map((board) => board.id)),
    boardOrder: new Map(ordered.map((board, index) => [board.id, index])),
    fallbackBoardOrder: ordered.length + 1,
  };
}

export type UpcomingSortOptions = {
  sort: TaskSort;
  grouping: UpcomingBoardGrouping;
  boardOrder: UpcomingBoardOrder;
};

function boardIndex(order: UpcomingBoardOrder, boardId: string): number {
  return order.boardOrder.get(boardId) ?? order.fallbackBoardOrder;
}

/** Time of day only: Upcoming already groups by day. Untimed tasks go after timed ones. */
function compareTaskTime(a: Task, b: Task, direction: BoardSortDirection): number {
  const timeA = taskTimeValue(a);
  const timeB = taskTimeValue(b);
  if (timeA != null && timeB != null && timeA !== timeB) return direction === "asc" ? timeA - timeB : timeB - timeA;
  if (timeA != null && timeB == null) return -1;
  if (timeA == null && timeB != null) return 1;
  return 0;
}

function compareUpcomingTaskFallback(a: Task, b: Task, order: UpcomingBoardOrder): number {
  return compareTaskTime(a, b, DEFAULT_BOARD_SORT_DIRECTION.due)
    || boardIndex(order, a.boardId) - boardIndex(order, b.boardId)
    || (a.order ?? 0) - (b.order ?? 0)
    || compareAlpha(a, b, DEFAULT_BOARD_SORT_DIRECTION.alpha)
    || a.id.localeCompare(b.id);
}

export function compareUpcomingTasks(a: Task, b: Task, options: UpcomingSortOptions): number {
  const { sort, grouping, boardOrder } = options;
  const byBoard = boardIndex(boardOrder, a.boardId) - boardIndex(boardOrder, b.boardId);
  if (grouping === "grouped" && byBoard !== 0) return byBoard;
  if (sort.mode === "manual") return byBoard || (a.order ?? 0) - (b.order ?? 0) || compareDefault(a, b);
  return compareBySortMode(a, b, sort, compareTaskTime) || compareUpcomingTaskFallback(a, b, boardOrder);
}

/** All-day events come before timed ones on a day. */
function eventMinutes(event: CalendarEvent): number {
  if (event.kind === "date") return -1;
  const parsed = parseTimeValue(isoTimePart(event.startISO, event.startTzid));
  return parsed ? parsed.hour * 60 + parsed.minute : 0;
}

function compareEventTime(a: CalendarEvent, b: CalendarEvent, direction: BoardSortDirection): number {
  const diff = eventMinutes(a) - eventMinutes(b);
  return direction === "asc" ? diff : -diff;
}

function compareEventTitle(a: CalendarEvent, b: CalendarEvent): number {
  return titleCollator.compare(a.title?.trim() || "", b.title?.trim() || "");
}

function compareUpcomingEventFallback(a: CalendarEvent, b: CalendarEvent, order: UpcomingBoardOrder): number {
  return compareEventTime(a, b, DEFAULT_BOARD_SORT_DIRECTION.due)
    || boardIndex(order, a.boardId) - boardIndex(order, b.boardId)
    || (a.order ?? 0) - (b.order ?? 0)
    || compareEventTitle(a, b)
    || a.id.localeCompare(b.id);
}

/** Events sort by time or title; priority and creation order do not apply to them. */
export function compareUpcomingEvents(a: CalendarEvent, b: CalendarEvent, options: UpcomingSortOptions): number {
  const { sort, grouping, boardOrder } = options;
  if (grouping === "grouped") {
    const byBoard = boardIndex(boardOrder, a.boardId) - boardIndex(boardOrder, b.boardId);
    if (byBoard !== 0) return byBoard;
  }
  if (sort.mode === "manual") return (a.order ?? 0) - (b.order ?? 0) || compareUpcomingEventFallback(a, b, boardOrder);
  let primary = 0;
  if (sort.mode === "due") primary = compareEventTime(a, b, sort.direction);
  else if (sort.mode === "alpha") primary = sort.direction === "asc" ? compareEventTitle(a, b) : -compareEventTitle(a, b);
  return primary || compareUpcomingEventFallback(a, b, boardOrder);
}

/** Open tasks with a valid due date on a visible board (not the messages board). */
export function selectUpcomingTasks(tasks: Task[], context: { boardOrder: UpcomingBoardOrder; messagesBoardId?: string | null }): Task[] {
  return tasks.filter((task) => {
    if (!context.boardOrder.visibleIds.has(task.boardId)) return false;
    if (task.boardId === context.messagesBoardId) return false;
    if (task.completed || task.dueDateEnabled === false) return false;
    return !Number.isNaN(Date.parse(task.dueISO));
  });
}

/** Events with a valid start on a visible board, plus external calendars and, if on, US holidays. */
export function selectUpcomingEvents(
  events: CalendarEvent[],
  context: { boardOrder: UpcomingBoardOrder; messagesBoardId?: string | null; holidays: CalendarEvent[] | null },
): CalendarEvent[] {
  const selected = events.filter((event) => {
    if (!isExternalCalendarEvent(event)) {
      if (!context.boardOrder.visibleIds.has(event.boardId)) return false;
      if (event.boardId === context.messagesBoardId) return false;
    }
    if (event.kind === "date") return ISO_DATE_PATTERN.test(event.startDate);
    return !Number.isNaN(Date.parse(event.startISO));
  });
  return context.holidays ? [...selected, ...context.holidays] : selected;
}

export type UpcomingFilter = {
  /** null: every board; []: nothing; otherwise the selection in `map`. */
  selection: string[] | null;
  hasOptions: boolean;
  map: { selectedBoards: Set<string>; selectedLists: Map<string, Set<string>> };
  boardMap: Map<string, Board>;
  /** Lowercased search text, or "" for none. */
  searchTerm: string;
};

function passesBoardFilter(item: { boardId: string; columnId?: string }, filter: UpcomingFilter): boolean {
  const { selectedBoards, selectedLists } = filter.map;
  const listSet = selectedLists.get(item.boardId);
  if (selectedBoards.has(item.boardId)) {
    if (filter.boardMap.get(item.boardId)?.kind !== "lists") return true;
    if (!item.columnId) return false;
    if (!listSet) return true;
    return listSet.has(item.columnId);
  }
  return !!(listSet && item.columnId && listSet.has(item.columnId));
}

function applyBoardFilter<T>(items: T[], filter: UpcomingFilter, passes: (item: T) => boolean): T[] {
  if (!filter.hasOptions || filter.selection === null) return items;
  if (filter.selection.length === 0) return [];
  return items.filter(passes);
}

export function filterUpcomingTasks(tasks: Task[], filter: UpcomingFilter): Task[] {
  const filtered = applyBoardFilter(tasks, filter, (task) => passesBoardFilter(task, filter));
  if (!filter.searchTerm) return filtered;
  return filtered.filter((task) =>
    task.title.toLowerCase().includes(filter.searchTerm) || (task.note?.toLowerCase() ?? "").includes(filter.searchTerm));
}

export function filterUpcomingEvents(events: CalendarEvent[], filter: UpcomingFilter, holidaysEnabled: boolean): CalendarEvent[] {
  const filtered = applyBoardFilter(events, filter, (event) => {
    if (isUsHolidayCalendarEvent(event)) return holidaysEnabled;
    if (event.external) return true;
    return passesBoardFilter(event, filter);
  });
  if (!filter.searchTerm) return filtered;
  const term = filter.searchTerm;
  return filtered.filter((event) =>
    event.title.toLowerCase().includes(term)
    || (event.summary || "").toLowerCase().includes(term)
    || (event.description || "").toLowerCase().includes(term)
    || (event.locations || []).join(" ").toLowerCase().includes(term)
    || (event.references || []).join(" ").toLowerCase().includes(term));
}

function nextDateKey(dateKey: string): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** An all-day event's last day; an end before the start is ignored. */
function allDayEventEnd(event: CalendarEvent & { kind: "date" }): string {
  return event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= event.startDate
    ? event.endDate
    : event.startDate;
}

/** The days an event appears on: its start day, or every day of an all-day event (up to a year). */
function eventDateKeys(event: CalendarEvent): string[] {
  if (event.kind !== "date") return [isoDatePart(event.startISO, event.startTzid)];
  if (!ISO_DATE_PATTERN.test(event.startDate)) return [];
  const end = allDayEventEnd(event);
  const keys: string[] = [];
  let cursor: string | null = event.startDate;
  while (cursor && keys.length < 366) {
    keys.push(cursor);
    if (cursor === end) break;
    cursor = nextDateKey(cursor);
  }
  return keys;
}

export type UpcomingDay = { tasks: Task[]; events: CalendarEvent[] };
export type UpcomingDayGroup = UpcomingDay & { dateKey: string; label: string };

/**
 * Tasks and events by day, each day sorted. A multi-day event appears on every day it covers.
 * With `after`, only days after that date key are kept (a board's "upcoming" section).
 */
export function groupUpcomingByDay(
  tasks: Task[],
  events: CalendarEvent[],
  options: UpcomingSortOptions & { after?: string },
): Map<string, UpcomingDay> {
  const days = new Map<string, UpcomingDay>();
  const day = (dateKey: string) => {
    let entry = days.get(dateKey);
    if (!entry) days.set(dateKey, (entry = { tasks: [], events: [] }));
    return entry;
  };
  const keep = (dateKey: string) => options.after === undefined || dateKey > options.after;
  for (const task of tasks) {
    const dateKey = taskDisplayDateKey(task);
    if (keep(dateKey)) day(dateKey).tasks.push(task);
  }
  for (const event of events) {
    for (const dateKey of eventDateKeys(event)) {
      if (keep(dateKey)) day(dateKey).events.push(event);
    }
  }
  for (const entry of days.values()) {
    entry.events.sort((a, b) => compareUpcomingEvents(a, b, options));
    entry.tasks.sort((a, b) => compareUpcomingTasks(a, b, options));
  }
  return days;
}

export function upcomingDayGroups(days: Map<string, UpcomingDay>): UpcomingDayGroup[] {
  return Array.from(days.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((dateKey) => ({ dateKey, label: formatUpcomingDayLabel(dateKey), ...days.get(dateKey)! }));
}

/** A board's open dated tasks after `cutoff` (today), for its "upcoming" section. */
export function boardUpcomingTasks(tasks: Task[], cutoff: string): Task[] {
  return tasks.filter((task) => {
    if (task.completed || task.dueDateEnabled === false) return false;
    if (Number.isNaN(Date.parse(task.dueISO))) return false;
    const dateKey = taskDisplayDateKey(task);
    return ISO_DATE_PATTERN.test(dateKey) && dateKey > cutoff;
  });
}

/** A board's events that run past `cutoff` (today). */
export function boardUpcomingEvents(events: CalendarEvent[], cutoff: string): CalendarEvent[] {
  return events.filter((event) => {
    if (event.kind === "date") return ISO_DATE_PATTERN.test(event.startDate) && allDayEventEnd(event) > cutoff;
    if (Number.isNaN(Date.parse(event.startISO))) return false;
    const dateKey = isoDatePart(event.startISO, event.startTzid);
    return ISO_DATE_PATTERN.test(dateKey) && dateKey > cutoff;
  });
}
