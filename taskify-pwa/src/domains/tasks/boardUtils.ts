import type { Task, Board, CalendarEvent, Weekday } from "./taskTypes";
import {
  isoDatePart,
  parseDateKey,
  startOfDay,
} from "../dateTime/dateUtils";
import { ISO_DATE_PATTERN } from "../appTypes";
import type { Settings } from "./settingsTypes";

// ---- Shared helpers (taskify-core) ----

export {
  boardScopeIds,
  compoundChildMatchesBoard,
  findBoardByCompoundChildId,
  hiddenUntilForNext,
  isFrequentRecurrence,
  nextOccurrence,
  normalizeCompoundChildId,
  parseCompoundChildInput,
  revealsOnDueDate,
  startOfWeekLocal as startOfWeek,
} from "taskify-core";
export type { CompoundChildId } from "taskify-core";
import { revealsOnDueDate, startOfWeekLocal as startOfWeek } from "taskify-core";

// ---- Board migration ----

function normalizeBoardOrder(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export function withBoardOrder(boards: Board[]): Board[] {
  let changed = false;
  const ordered = boards.map((board, index) => {
    if (board.order === index) return board;
    changed = true;
    return { ...board, order: index } as Board;
  });
  return changed ? ordered : boards;
}

export function migrateBoards(stored: any): Board[] | null {
  try {
    const arr = stored as any[];
    if (!Array.isArray(arr)) return null;
    const migrated = arr.map((b, index) => {
      const order = normalizeBoardOrder(b?.order, index);
      const archived =
        typeof b?.archived === "boolean"
          ? b.archived
          : typeof b?.hidden === "boolean"
            ? b.hidden
            : false;
      const hidden =
        typeof b?.hidden === "boolean" && typeof b?.archived === "boolean"
          ? b.hidden
          : false;
      const clearCompletedDisabled =
        typeof b?.clearCompletedDisabled === "boolean" ? b.clearCompletedDisabled : false;
      const indexCardEnabled =
        typeof (b as any)?.indexCardEnabled === "boolean" ? Boolean((b as any).indexCardEnabled) : false;
      const hideChildBoardNames =
        typeof (b as any)?.hideChildBoardNames === "boolean"
          ? Boolean((b as any).hideChildBoardNames)
          : false;
      if (b?.kind === "week") {
        return {
          id: b.id,
          name: b.name,
          kind: "week",
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          order,
        } as Board;
      }
      if (b?.kind === "lists" && Array.isArray(b.columns)) {
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: b.columns,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
          order,
        } as Board;
      }
      if (b?.kind === "compound") {
        const rawChildren = Array.isArray((b as any)?.children) ? (b as any).children : [];
        const children = rawChildren
          .filter((child: unknown) => typeof child === "string" && child && child !== b.id) as string[];
        return {
          id: b.id,
          name: b.name,
          kind: "compound",
          children,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
          hideChildBoardNames,
          order,
        } as Board;
      }
      if (b?.kind === "bible") {
        const name = typeof b?.name === "string" && b.name.trim() ? b.name : "Bible";
        return {
          id: b.id,
          name,
          kind: "bible",
          archived,
          hidden,
          clearCompletedDisabled,
          order,
        } as Board;
      }
      if (b?.kind === "list") {
        // old single-column boards -> migrate to lists with one column
        const colId = crypto.randomUUID();
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: [{ id: colId, name: "Items" }],
          nostr: b?.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
          order,
        } as Board;
      }
      // unknown -> keep as lists with one column
      const colId = crypto.randomUUID();
      return {
        id: b?.id || crypto.randomUUID(),
        name: b?.name || "Board",
        kind: "lists",
        columns: [{ id: colId, name: "Items" }],
        nostr: b?.nostr,
        archived,
        hidden,
        clearCompletedDisabled,
        indexCardEnabled,
        order,
      } as Board;
    });
    const sorted = migrated.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return withBoardOrder(sorted);
  } catch { return null; }
}

// ---- Startup board selection ----

export function pickStartupBoard(boards: Board[], overrides?: Partial<Record<Weekday, string>>): string {
  const visible = boards.filter(b => !b.archived && !b.hidden);
  const today = (new Date().getDay() as Weekday);
  const overrideId = overrides?.[today];
  if (overrideId) {
    const match = visible.find(b => b.id === overrideId) || boards.find(b => !b.archived && b.id === overrideId);
    if (match) return match.id;
  }
  if (visible.length) return visible[0].id;
  const firstUnarchived = boards.find(b => !b.archived);
  if (firstUnarchived) return firstUnarchived.id;
  return boards[0]?.id || "";
}

// ---- Visibility helpers ----

export function isVisibleNow(t: Task, now = new Date()): boolean {
  if (!t.hiddenUntilISO) return true;
  const today = startOfDay(now).getTime();
  if (t.recurrence && revealsOnDueDate(t.recurrence)) {
    const dueReveal = startOfDay(new Date(t.dueISO)).getTime();
    if (!Number.isNaN(dueReveal)) return today >= dueReveal;
  }
  const reveal = startOfDay(new Date(t.hiddenUntilISO)).getTime();
  return today >= reveal;
}

/** When a task due `dueISO` appears on a board of `boardKind`, relative to `now`; undefined when it
 * already shows. Planners pass their own clock, so a plan doesn't depend on when it runs. */
export function hiddenUntilForBoard(
  dueISO: string,
  boardKind: Board["kind"],
  weekStart: Weekday,
  now: Date = new Date(),
): string | undefined {
  const dueDate = startOfDay(new Date(dueISO));
  if (Number.isNaN(dueDate.getTime())) return undefined;
  const today = startOfDay(now);
  if (boardKind === "lists" || boardKind === "compound") {
    return dueDate.getTime() > today.getTime() ? dueDate.toISOString() : undefined;
  }
  const nowSow = startOfWeek(now, weekStart);
  const dueSow = startOfWeek(dueDate, weekStart);
  return dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
}

export function applyHiddenForFuture(task: Task, weekStart: Weekday, boardKind: Board["kind"], now: Date = new Date()): void {
  if (task.dueDateEnabled === false) {
    task.hiddenUntilISO = undefined;
    return;
  }
  task.hiddenUntilISO = hiddenUntilForBoard(task.dueISO, boardKind, weekStart, now);
}

// ---- Calendar event visibility helpers ----

function calendarEventDateKey(event: CalendarEvent): string | null {
  if (event.kind === "date") {
    return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  }
  const key = isoDatePart(event.startISO, event.startTzid);
  return ISO_DATE_PATTERN.test(key) ? key : null;
}

function hiddenUntilForCalendarEvent(
  event: CalendarEvent,
  boardKind: Board["kind"],
  weekStart: Weekday,
  now = new Date(),
): string | undefined {
  if (boardKind !== "lists" && boardKind !== "compound") return undefined;
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return undefined;
  const parsed = parseDateKey(dateKey);
  if (!parsed) return undefined;
  const eventDate = new Date(parsed.year, parsed.month - 1, parsed.day);
  if (Number.isNaN(eventDate.getTime())) return undefined;
  const eventWeekStart = startOfWeek(eventDate, weekStart);
  const currentWeekStart = startOfWeek(now, weekStart);
  if (eventWeekStart.getTime() > currentWeekStart.getTime()) {
    return eventWeekStart.toISOString();
  }
  return undefined;
}

export function applyHiddenForCalendarEvent(
  event: CalendarEvent,
  weekStart: Weekday,
  boardKind: Board["kind"],
  now = new Date(),
): CalendarEvent {
  const hiddenUntilISO = hiddenUntilForCalendarEvent(event, boardKind, weekStart, now);
  if (hiddenUntilISO) {
    if (event.hiddenUntilISO === hiddenUntilISO) return event;
    return { ...event, hiddenUntilISO };
  }
  if (!event.hiddenUntilISO) return event;
  return { ...event, hiddenUntilISO: undefined };
}

// ---- Order helpers ----

export function nextOrderForBoard(
  boardId: string,
  tasks: Task[],
  newTaskPosition: Settings["newTaskPosition"]
): number {
  const boardTasks = tasks.filter(task => task.boardId === boardId);
  if (newTaskPosition === "top") {
    const minOrder = boardTasks.reduce((min, task) => Math.min(min, task.order ?? 0), 0);
    return minOrder - 1;
  }
  return boardTasks.reduce((max, task) => Math.max(max, task.order ?? -1), -1) + 1;
}

export function nextOrderForCalendarBoard(
  boardId: string,
  events: CalendarEvent[],
  newItemPosition: Settings["newTaskPosition"],
): number {
  const boardEvents = events.filter((event) => event.boardId === boardId && !event.external);
  if (newItemPosition === "top") {
    const minOrder = boardEvents.reduce((min, event) => Math.min(min, event.order ?? 0), 0);
    return minOrder - 1;
  }
  return boardEvents.reduce((max, event) => Math.max(max, event.order ?? -1), -1) + 1;
}

/** A compound board's key for one of its child boards' lists. */
export function compoundColumnKey(boardId: string, columnId: string): string {
  return `${boardId}::${columnId}`;
}
