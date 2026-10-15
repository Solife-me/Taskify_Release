/**
 * Calendar commands take current state and return the next state plus work for the caller.
 * They never touch React, storage or the network.
 */
import type { CalendarEvent } from "../tasks/taskTypes";

export type CalendarEventPlan = {
  events: CalendarEvent[];
  publish: CalendarEvent[];
  publishDeleted: CalendarEvent[];
};

/** Moves selected events to a board or list column while preserving list order. */
export function planMoveCalendarEvents(
  events: CalendarEvent[],
  ids: Iterable<string>,
  boardId: string,
  columnId?: string,
): CalendarEventPlan {
  const selected = ids instanceof Set ? ids : new Set(ids);
  const publish: CalendarEvent[] = [];
  const publishDeleted: CalendarEvent[] = [];
  let changed = false;
  const next = events.map((event) => {
    if (!selected.has(event.id)) return event;
    changed = true;
    if (event.boardId !== boardId) publishDeleted.push(event);
    const updated: CalendarEvent = {
      ...event,
      boardId,
      originBoardId: undefined,
      columnId,
    };
    publish.push(updated);
    return updated;
  });
  return {
    events: changed ? next : events,
    publish,
    publishDeleted,
  };
}
