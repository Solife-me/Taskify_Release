import type { Task, Board, CalendarEvent, Recurrence, Weekday } from "./taskTypes";
import {
  isoDatePart,
  parseDateKey,
  startOfDay,
  isoTimePart,
  formatDateKeyFromParts,
  isoFromDateTime,
  normalizeTimeZone,
} from "../dateTime/dateUtils";
import { ISO_DATE_PATTERN } from "../appTypes";
import type { Settings } from "./settingsTypes";

// ---- Compound child helpers ----

export type CompoundChildId = string;

export function parseCompoundChildInput(raw: string): { boardId: string; relays: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { boardId: "", relays: [] };
  let boardId = trimmed;
  let relaySegment = "";
  const atIndex = trimmed.indexOf("@");
  if (atIndex >= 0) {
    boardId = trimmed.slice(0, atIndex).trim();
    relaySegment = trimmed.slice(atIndex + 1).trim();
  } else {
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex >= 0) {
      boardId = trimmed.slice(0, spaceIndex).trim();
      relaySegment = trimmed.slice(spaceIndex + 1).trim();
    }
  }
  const relays = relaySegment
    ? relaySegment.split(/[\s,]+/).map((relay) => relay.trim()).filter(Boolean)
    : [];
  return { boardId, relays };
}

export function boardScopeIds(board: Board, boards: Board[]): string[] {
  const ids = new Set<string>();
  const addId = (value?: string | null) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  const addBoard = (target: Board | undefined) => {
    if (!target) return;
    addId(target.id);
    addId(target.nostr?.boardId);
  };

  addBoard(board);

  if (board.kind === "compound") {
    board.children.forEach((childId) => {
      addId(childId);
      addBoard(findBoardByCompoundChildId(boards, childId));
    });
  }

  return Array.from(ids);
}

export function findBoardByCompoundChildId(boards: Board[], childId: string): Board | undefined {
  return boards.find((board) => {
    if (board.id === childId) return true;
    return !!board.nostr?.boardId && board.nostr.boardId === childId;
  });
}

export function compoundChildMatchesBoard(childId: string, board: Board): boolean {
  return childId === board.id || (!!board.nostr?.boardId && childId === board.nostr.boardId);
}

export function normalizeCompoundChildId(boards: Board[], childId: string): string {
  const match = findBoardByCompoundChildId(boards, childId);
  return match ? match.id : childId;
}

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

// ---- Week helpers ----

export function startOfWeek(d: Date, weekStart: Weekday): Date {
  const sd = startOfDay(d);
  const current = sd.getDay() as Weekday;
  const ws = (weekStart === 1 || weekStart === 6) ? weekStart : 0; // only Mon(1)/Sat(6)/Sun(0)
  let diff = current - ws;
  if (diff < 0) diff += 7;
  return new Date(sd.getTime() - diff * 86400000);
}

// ---- Recurrence helpers ----

export function nextOccurrence(
  currentISO: string,
  rule: Recurrence,
  keepTime = false,
  timeZone?: string,
): string | null {
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) {
    const dateKey = isoDatePart(currentISO, safeZone);
    const dateParts = parseDateKey(dateKey);
    if (dateParts) {
      const baseTime = keepTime ? isoTimePart(currentISO, safeZone) : "";
      const applyDate = (parts: { year: number; month: number; day: number }): string => {
        const nextDateKey = formatDateKeyFromParts(parts.year, parts.month, parts.day);
        return isoFromDateTime(nextDateKey, baseTime || undefined, safeZone);
      };
      const addDays = (d: number) => {
        const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
        base.setUTCDate(base.getUTCDate() + d);
        return {
          year: base.getUTCFullYear(),
          month: base.getUTCMonth() + 1,
          day: base.getUTCDate(),
        };
      };
      const weekdayForParts = (parts: { year: number; month: number; day: number }) =>
        new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() as Weekday;
      let next: string | null = null;
      switch (rule.type) {
        case "none":
          next = null; break;
        case "daily":
          next = applyDate(addDays(1)); break;
        case "weekly": {
          if (!rule.days.length) return null;
          for (let i = 1; i <= 28; i++) {
            const cand = addDays(i);
            const wd = weekdayForParts(cand);
            if (rule.days.includes(wd)) { next = applyDate(cand); break; }
          }
          break;
        }
        case "every": {
          if (rule.unit === "hour") {
            const current = new Date(currentISO);
            const n = new Date(current.getTime() + rule.n * 3600000);
            next = n.toISOString();
          } else {
            const daysToAdd = rule.unit === "day" ? rule.n : rule.n * 7;
            next = applyDate(addDays(daysToAdd));
          }
          break;
        }
        case "monthlyDay": {
          const interval = Math.max(1, rule.interval ?? 1);
          const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1 + interval, 1));
          const n = {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: Math.min(rule.day, 28),
          };
          next = applyDate(n);
          break;
        }
      }
      if (next && rule.untilISO) {
        const limitKey = isoDatePart(rule.untilISO, safeZone);
        const nextKey = isoDatePart(next, safeZone);
        if (nextKey > limitKey) return null;
      }
      return next;
    }
  }
  const currentDate = new Date(currentISO);
  const curDay = startOfDay(currentDate);
  const timeOffset = currentDate.getTime() - curDay.getTime();
  const baseTime = keepTime ? isoTimePart(currentISO) : "";
  const applyTime = (day: Date): string => {
    if (keepTime && baseTime) {
      const datePart = isoDatePart(day.toISOString());
      return isoFromDateTime(datePart, baseTime);
    }
    return new Date(day.getTime() + timeOffset).toISOString();
  };
  const addDays = (d: number) => {
    const nextDay = startOfDay(new Date(curDay.getTime() + d * 86400000));
    return applyTime(nextDay);
  };
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null; break;
    case "daily":
      next = addDays(1); break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) { next = cand; break; }
      }
      break;
    }
    case "every": {
      if (rule.unit === "hour") {
        const current = new Date(currentISO);
        const n = new Date(current.getTime() + rule.n * 3600000);
        next = n.toISOString();
      } else {
        const daysToAdd = rule.unit === "day" ? rule.n : rule.n * 7;
        next = addDays(daysToAdd);
      }
      break;
    }
    case "monthlyDay": {
      const y = curDay.getFullYear(), m = curDay.getMonth();
      const interval = Math.max(1, rule.interval ?? 1);
      const n = startOfDay(new Date(y, m + interval, Math.min(rule.day, 28)));
      next = applyTime(n);
      break;
    }
  }
  if (next && rule.untilISO) {
    const limit = startOfDay(new Date(rule.untilISO)).getTime();
    const n = startOfDay(new Date(next)).getTime();
    if (n > limit) return null;
  }
  return next;
}

// ---- Visibility helpers ----

export function revealsOnDueDate(rule: Recurrence): boolean {
  if (isFrequentRecurrence(rule)) return true;
  return false;
}

export function isFrequentRecurrence(rule?: Recurrence | null): boolean {
  if (!rule) return false;
  if (rule.type === "daily" || rule.type === "weekly") return true;
  if (rule.type === "every") {
    return rule.unit === "day" || rule.unit === "week";
  }
  return false;
}

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

/** Decide when the next instance should re-appear (hiddenUntilISO). */
export function hiddenUntilForNext(
  nextISO: string,
  rule: Recurrence,
  weekStart: Weekday
): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (revealsOnDueDate(rule)) {
    return nextMidnight.toISOString();
  }
  const sow = startOfWeek(nextMidnight, weekStart);
  return sow.toISOString();
}

export function hiddenUntilForBoard(dueISO: string, boardKind: Board["kind"], weekStart: Weekday): string | undefined {
  const dueDate = startOfDay(new Date(dueISO));
  if (Number.isNaN(dueDate.getTime())) return undefined;
  const today = startOfDay(new Date());
  if (boardKind === "lists" || boardKind === "compound") {
    return dueDate.getTime() > today.getTime() ? dueDate.toISOString() : undefined;
  }
  const nowSow = startOfWeek(new Date(), weekStart);
  const dueSow = startOfWeek(dueDate, weekStart);
  return dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
}

export function applyHiddenForFuture(task: Task, weekStart: Weekday, boardKind: Board["kind"]): void {
  if (task.dueDateEnabled === false) {
    task.hiddenUntilISO = undefined;
    return;
  }
  task.hiddenUntilISO = hiddenUntilForBoard(task.dueISO, boardKind, weekStart);
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
): string | undefined {
  if (boardKind !== "lists" && boardKind !== "compound") return undefined;
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return undefined;
  const parsed = parseDateKey(dateKey);
  if (!parsed) return undefined;
  const eventDate = new Date(parsed.year, parsed.month - 1, parsed.day);
  if (Number.isNaN(eventDate.getTime())) return undefined;
  const eventWeekStart = startOfWeek(eventDate, weekStart);
  const currentWeekStart = startOfWeek(new Date(), weekStart);
  if (eventWeekStart.getTime() > currentWeekStart.getTime()) {
    return eventWeekStart.toISOString();
  }
  return undefined;
}

export function applyHiddenForCalendarEvent(event: CalendarEvent, weekStart: Weekday, boardKind: Board["kind"]): CalendarEvent {
  const hiddenUntilISO = hiddenUntilForCalendarEvent(event, boardKind, weekStart);
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
