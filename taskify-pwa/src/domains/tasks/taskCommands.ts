/**
 * Task commands: each takes the current task list and returns the next list plus the work the
 * caller must do (publish, notify, update other state). Nothing here touches React, storage or
 * the network, so every rule is unit-tested and runs exactly once per user action.
 */
import {
  SCRIPTURE_MEMORY_SERIES_ID,
  buildNextRecurringTask,
  buildRunningStreakLookup,
  isAssignedSharedTask,
  isFrequentRecurrence,
  tasksInSameSeries,
  type Weekday,
} from "taskify-core";
import type { ScriptureMemoryState } from "../scripture/scriptureTypes";
import {
  chooseNextScriptureEntry,
  formatScriptureReference,
  markScriptureEntryReviewed,
  scriptureFrequencyToRecurrence,
} from "../scripture/scriptureUtils";
import { isoDatePart, startOfDay, taskDateKey } from "../dateTime/dateUtils";
import { normalizeAgentPubkey } from "./assignmentUtils";
import { nextOrderForBoard } from "./boardUtils";
import type { Settings } from "./settingsTypes";
import type { InboxItem, InboxItemStatus, ScriptureMemoryUpdate, Task, TaskAssigneeStatus } from "./taskTypes";
import { mergeLongestStreak } from "./taskUtils";

export type InboxAction = "accept" | "dismiss" | "decline" | "maybe";

export type TaskAssignmentReply = {
  item: Extract<InboxItem, { type: "task" }>;
  status: TaskAssigneeStatus;
};

export type CompleteTaskContext = {
  now: Date;
  /** The signed-in user's key as stored on the device; recorded as `completedBy`. */
  actorPubkey?: string;
  settings: Pick<Settings, "streaksEnabled" | "weekStart" | "newTaskPosition">;
  scripture: { state: ScriptureMemoryState; baseDays: number };
  inboxAction?: InboxAction;
  /** True when a shared task was just accepted onto a chosen board. */
  acceptedIntoBoard?: boolean;
};

export type CompleteTaskPlan = {
  tasks: Task[];
  /** Published in order: the completed task, then its next occurrence. */
  publish: Task[];
  inboxAction: { item: InboxItem; action: InboxAction } | null;
  assignmentReply: TaskAssignmentReply | null;
  scriptureReview: ScriptureMemoryUpdate | null;
};

const STATUS_FOR_ACTION: Record<InboxAction, InboxItemStatus> = {
  accept: "accepted",
  maybe: "tentative",
  decline: "declined",
  dismiss: "deleted",
};

const NOTE_FOR_STATUS: Partial<Record<InboxItemStatus, string>> = {
  accepted: "Action: Added",
  tentative: "Action: Maybe",
  declined: "Action: Declined",
  deleted: "Action: Dismissed",
};

function isAnsweredInboxStatus(status: InboxItemStatus | undefined): boolean {
  return status === "accepted" || status === "declined" || status === "tentative" || status === "deleted";
}

/**
 * Completes a task: answers its inbox item if it has one, advances the streak, and opens the next
 * occurrence of a recurring series. A Scripture Memory review schedules the next passage.
 */
export function planCompleteTask(tasks: Task[], id: string, ctx: CompleteTaskContext): CompleteTaskPlan {
  const pending = tasks.find((task) => task.id === id)?.inboxItem;
  const plan: CompleteTaskPlan = {
    tasks,
    publish: [],
    inboxAction: null,
    assignmentReply:
      ctx.acceptedIntoBoard && pending?.type === "task" && isAssignedSharedTask(pending.task)
        ? { item: pending, status: "accepted" }
        : null,
    scriptureReview: null,
  };
  const cur = tasks.find((task) => task.id === id);
  if (!cur) return plan;

  let working = cur;
  if (cur.inboxItem && !isAnsweredInboxStatus(cur.inboxItem.status)) {
    const isTaskAssignment = cur.inboxItem.type === "task" && isAssignedSharedTask(cur.inboxItem.task);
    const requested = ctx.inboxAction ?? "accept";
    // An assignment can be declined but not silently dismissed: the sender is waiting for an answer.
    const action: InboxAction = isTaskAssignment && requested === "dismiss" ? "decline" : requested;
    const status = STATUS_FOR_ACTION[action];
    const inboxItem = { ...cur.inboxItem, status } as InboxItem;
    const noteHasStatus = typeof cur.note === "string" && cur.note.includes("Action:");
    working = {
      ...cur,
      inboxItem,
      note: noteHasStatus ? cur.note : [cur.note, NOTE_FOR_STATUS[status]].filter(Boolean).join("\n"),
    };
    plan.inboxAction = { item: inboxItem, action };
    if (inboxItem.type === "task" && isAssignedSharedTask(inboxItem.task) && status !== "deleted") {
      plan.assignmentReply = {
        item: inboxItem,
        status: status === "accepted" ? "accepted" : status === "tentative" ? "tentative" : "declined",
      };
    }
  }

  const nowISO = ctx.now.toISOString();
  // Count from the series' running streak, not this instance's stored copy: instances generated
  // ahead of time (full-week mode) carry the streak from when they were made. The streak grows on
  // every completion, including late ones.
  let streak = buildRunningStreakLookup(tasks)(working);
  if (ctx.settings.streaksEnabled && working.recurrence && isFrequentRecurrence(working.recurrence)) {
    streak += 1;
  }
  const longestStreak = mergeLongestStreak(working, streak);

  const done: Task = {
    ...working,
    seriesId: working.seriesId || working.id,
    completed: true,
    completedAt: nowISO,
    completedBy: ctx.actorPubkey || undefined,
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) || working.lastEditedBy || working.createdBy,
    updatedAt: nowISO,
    bountyDeletedAt: undefined,
    streak,
    longestStreak,
  };
  if (working.scriptureMemoryId) {
    plan.scriptureReview = {
      entryId: working.scriptureMemoryId,
      completedAt: nowISO,
      stageBefore: typeof working.scriptureMemoryStage === "number" ? working.scriptureMemoryStage : 0,
    };
  }
  const updated = tasks.map((task) => (task.id === id ? done : task));
  plan.tasks = updated;
  plan.publish = [done];

  const next = planNextOccurrence(working, updated, streak, longestStreak, ctx, plan.scriptureReview);
  if (next) {
    plan.tasks = [...updated, next.task];
    plan.publish.push(next.task);
    if (next.scheduled && plan.scriptureReview) {
      plan.scriptureReview = { ...plan.scriptureReview, nextScheduled: next.scheduled };
    }
  }
  return plan;
}

function planNextOccurrence(
  working: Task,
  updated: Task[],
  streak: number,
  longestStreak: number | undefined,
  ctx: CompleteTaskContext,
  scriptureReview: ScriptureMemoryUpdate | null,
): { task: Task; scheduled?: { entryId: string; scheduledAtISO: string } } | null {
  const isScriptureReview = working.seriesId === SCRIPTURE_MEMORY_SERIES_ID || !!working.scriptureMemoryId;
  const recurrence = isScriptureReview
    ? working.recurrence ?? scriptureFrequencyToRecurrence(ctx.scripture.baseDays)
    : working.recurrence;
  if (!recurrence) return null;
  // A Scripture Memory review is spaced from when it was done, not from a due date it was left
  // overdue on.
  const scheduledFromISO = isScriptureReview
    ? new Date(Math.max(Date.parse(working.dueISO) || 0, startOfDay(ctx.now).getTime())).toISOString()
    : working.dueISO;
  const nextTask = buildNextRecurringTask(working, {
    weekStart: ctx.settings.weekStart as Weekday,
    recurrence,
    scheduledFromISO,
    now: ctx.now.getTime(),
  });
  if (!nextTask) return null;

  const seriesSeed = working.seriesId ? working : { ...working, seriesId: working.seriesId || working.id };
  const nextDateKey = isoDatePart(nextTask.dueISO, working.dueTimeZone);
  if (updated.some((task) => tasksInSameSeries(task, seriesSeed) && taskDateKey(task) === nextDateKey)) return null;

  let task: Task = {
    ...nextTask,
    lastEditedBy: working.lastEditedBy || working.createdBy,
    order: nextOrderForBoard(working.boardId, updated, ctx.settings.newTaskPosition),
    streak,
    longestStreak,
    dueTimeEnabled: typeof working.dueTimeEnabled === "boolean" ? working.dueTimeEnabled : undefined,
  };
  if (working.seriesId !== SCRIPTURE_MEMORY_SERIES_ID) return { task };

  // The next review shows whichever passage is most due once this one counts as reviewed.
  const previewState = scriptureReview
    ? markScriptureEntryReviewed(
        ctx.scripture.state,
        scriptureReview.entryId,
        scriptureReview.completedAt,
        scriptureReview.stageBefore,
      )
    : ctx.scripture.state;
  const selection = chooseNextScriptureEntry(previewState.entries, ctx.scripture.baseDays, new Date(nextTask.dueISO));
  if (!selection) return null;
  const nowISO = ctx.now.toISOString();
  task = {
    ...task,
    title: `Review ${formatScriptureReference(selection.entry)}`,
    scriptureMemoryId: selection.entry.id,
    scriptureMemoryStage: selection.entry.stage ?? 0,
    scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
    scriptureMemoryScheduledAt: nowISO,
  };
  return { task, scheduled: { entryId: selection.entry.id, scheduledAtISO: nowISO } };
}
