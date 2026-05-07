import type { Task, Board, CalendarEvent } from "taskify-core";

export {
  TASK_PRIORITY_MARKS,
  isExternalCalendarEvent,
  isListLikeBoard,
} from "taskify-core";

export type {
  TaskPriority,
  Weekday,
  Recurrence,
  Subtask,
  BuiltinReminderPreset,
  CustomReminderPreset,
  ReminderPreset,
  InboxSender,
  InboxItemStatus,
  InboxItem,
  TaskAssigneeStatus,
  TaskAssignee,
  Task,
  CalendarEventParticipant,
  CalendarEventBase,
  DateCalendarEvent,
  TimeCalendarEvent,
  CalendarEvent,
  ExternalCalendarEvent,
  EditItemType,
  EditingState,
  BoardSortMode,
  BoardSortDirection,
  UpcomingBoardGrouping,
  ListColumn,
  CompoundChildId,
  BoardBase,
  Board,
  ListLikeBoard,
} from "taskify-core";

// Legacy aliases retained for compatibility with existing imports
export type PublishTaskFn = (
  task: Task,
  boardOverride?: Board,
  options?: { skipBoardMetadata?: boolean }
) => Promise<void>;

export type PublishCalendarEventFn = (
  event: CalendarEvent,
  boardOverride?: Board,
  options?: { skipBoardMetadata?: boolean }
) => Promise<void>;

export type ScriptureMemoryUpdate = {
  entryId: string;
  completedAt: string;
  stageBefore?: number;
  nextScheduled?: { entryId: string; scheduledAtISO: string };
};

export type CompleteTaskResult = {
  scriptureMemory?: ScriptureMemoryUpdate;
} | null;

export type CompleteTaskFn = (
  id: string,
  options?: { skipScriptureMemoryUpdate?: boolean; inboxAction?: "accept" | "dismiss" | "decline" | "maybe" }
) => CompleteTaskResult;
