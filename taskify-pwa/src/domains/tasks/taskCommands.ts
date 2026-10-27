/**
 * Task commands: each takes the current task list and returns the next list plus the work the
 * caller must do (publish, notify, update other state). Nothing here touches React, storage or
 * the network, so every rule is unit-tested and runs exactly once per user action.
 */
import {
  SCRIPTURE_MEMORY_SERIES_ID,
  isoForWeekdayLocal,
  isListLikeBoard,
  buildNextRecurringTask,
  buildRunningStreakLookup,
  recurringSeriesId,
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
import { isoDatePart, isoFromDateTime, isoTimePart, normalizeTimeZone, startOfDay, taskDateKey } from "../dateTime/dateUtils";
import { mergeTaskAssigneeResponse, normalizeAgentPubkey } from "./assignmentUtils";
import { hiddenUntilForBoard, nextOrderForBoard } from "./boardUtils";
import {
  applyRecurringSeriesCutoffs,
  capRecurringTaskAt,
  detachCancelledRecurringTask,
  recurringSeriesCutoffBefore,
  updateRecurringSeriesCutoff,
  type RecurringSeriesCutoffs,
} from "./recurrenceCutoffs";
import type { Settings } from "./settingsTypes";
import type { Board, Subtask, InboxItem, InboxItemStatus, ScriptureMemoryUpdate, Task, TaskAssignee, TaskAssigneeStatus } from "./taskTypes";
import { taskMovePersistencePlan } from "./taskMovePersistence";
import { hasSyncedTaskChange } from "./taskSyncChanges";
import { isRecoverableBountyTask, mergeLongestStreak, normalizeTaskBounty } from "./taskUtils";

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

export type TaskEditContext = {
  now: Date;
  /** The signed-in user's key as stored on the device. */
  actorPubkey?: string;
};

export type DeleteTaskContext = TaskEditContext & {
  settings: Pick<Settings, "showFullWeekRecurring" | "streaksEnabled">;
  /** "future" ends a recurring series from this occurrence on; otherwise one task is deleted. */
  scope?: "single" | "future";
  /** A recurring task asks which occurrences to delete unless the caller already asked. */
  skipPrompt?: boolean;
};

export type DeleteTaskPlan =
  | { kind: "none" }
  | { kind: "ask-scope"; task: Task }
  | {
      kind: "applied";
      tasks: Task[];
      cutoffs: RecurringSeriesCutoffs;
      publish: Task[];
      publishDeleted: Task[];
      /** The task removed outright, which can be undone. */
      removed: Task | null;
      /** Bounty tasks are archived to Completed rather than deleted. */
      archivedBounties: boolean;
    };

/** A bounty is never deleted outright: it moves to Completed so its ecash stays recoverable. */
function archiveBountyTask(task: Task, deletedAtISO: string, actorPubkey: string | undefined): Task {
  return {
    ...task,
    completed: true,
    completedAt: task.completedAt || deletedAtISO,
    completedBy: task.completedBy ?? (actorPubkey || undefined),
    lastEditedBy: normalizeAgentPubkey(actorPubkey) ?? task.lastEditedBy ?? task.createdBy,
    hiddenUntilISO: undefined,
    bountyDeletedAt: deletedAtISO,
  };
}

export function planDeleteTask(
  tasks: Task[],
  cutoffs: RecurringSeriesCutoffs,
  id: string,
  ctx: DeleteTaskContext,
): DeleteTaskPlan {
  const t = tasks.find((task) => task.id === id);
  if (!t) return { kind: "none" };
  if (!ctx.skipPrompt && t.recurrence) return { kind: "ask-scope", task: t };
  const deletedAtISO = ctx.now.toISOString();

  if (ctx.scope === "future") {
    if (Number.isNaN(Date.parse(t.dueISO))) return { kind: "none" };
    const nextUntil = recurringSeriesCutoffBefore(t);
    if (!nextUntil) return { kind: "none" };
    const seriesId = recurringSeriesId(t);
    const seriesSeed = t.seriesId === seriesId ? t : { ...t, seriesId };
    const cutoffKey = isoDatePart(t.dueISO, t.dueTimeZone);
    let nextCutoffs = updateRecurringSeriesCutoff(cutoffs, seriesSeed, nextUntil);
    const publish: Task[] = [];
    const publishDeleted: Task[] = [];
    const kept: Task[] = [];
    let changed = false;
    for (const task of tasks) {
      if (!task.recurrence || !tasksInSameSeries(task, seriesSeed)) {
        kept.push(task);
        continue;
      }
      nextCutoffs = updateRecurringSeriesCutoff(nextCutoffs, task, nextUntil);
      if (Number.isNaN(Date.parse(task.dueISO))) {
        kept.push(task);
        continue;
      }
      if (isoDatePart(task.dueISO, t.dueTimeZone) >= cutoffKey) {
        const ended = capRecurringTaskAt(task, nextUntil);
        if (task.bounty) {
          const archived = archiveBountyTask(ended, deletedAtISO, ctx.actorPubkey);
          kept.push(archived);
          publish.push(archived);
        } else {
          publishDeleted.push(ended);
        }
        changed = true;
        continue;
      }
      // Earlier occurrences are capped locally but not republished: every client caps the series
      // from the recorded cutoff (native `recordRecurringTaskSeriesCutoff`). Republishing them
      // would rewrite the series' whole history.
      const capped = capRecurringTaskAt(task, nextUntil);
      if (capped !== task) changed = true;
      kept.push(capped);
    }
    return {
      kind: "applied",
      tasks: changed ? applyRecurringSeriesCutoffs(kept, nextCutoffs) : tasks,
      cutoffs: nextCutoffs,
      publish,
      publishDeleted,
      removed: null,
      archivedBounties: publish.some((task) => isRecoverableBountyTask(task)),
    };
  }

  if (t.bounty) {
    const archived = archiveBountyTask(t, deletedAtISO, ctx.actorPubkey);
    return {
      kind: "applied",
      tasks: tasks.map((task) => (task.id === id ? archived : task)),
      cutoffs,
      publish: [archived],
      publishDeleted: [],
      removed: null,
      archivedBounties: true,
    };
  }

  const next = tasks.filter((task) => task.id !== id);
  const publish: Task[] = [];
  // Deleting an occurrence breaks the run: in full-week mode the next open occurrence restarts at 0.
  if (ctx.settings.showFullWeekRecurring && ctx.settings.streaksEnabled && t.recurrence && isFrequentRecurrence(t.recurrence)) {
    const following = next
      .filter((x) => !x.completed && x.recurrence && tasksInSameSeries(x, t) && new Date(x.dueISO) > new Date(t.dueISO))
      .sort((a, b) => new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime())[0];
    if (following) {
      const reset: Task = {
        ...following,
        seriesId: following.seriesId || following.id,
        streak: 0,
        longestStreak: mergeLongestStreak(following, 0),
      };
      next[next.findIndex((x) => x.id === following.id)] = reset;
      publish.push(reset);
    }
  }
  return { kind: "applied", tasks: next, cutoffs, publish, publishDeleted: [t], removed: t, archivedBounties: false };
}

export type RestoreTaskPlan = { tasks: Task[]; publish: Task[]; restored: Task } | null;

/**
 * Reopens a completed task at the bottom of its board. Undoing a streaked completion takes the
 * streak back by one on this occurrence and the open ones after it.
 */
export function planRestoreTask(
  tasks: Task[],
  cutoffs: RecurringSeriesCutoffs,
  id: string,
  ctx: TaskEditContext & { settings: Pick<Settings, "streaksEnabled"> },
): RestoreTaskPlan {
  const t = tasks.find((task) => task.id === id);
  if (!t) return null;
  const nowISO = ctx.now.toISOString();
  const editor = (task: Task) => normalizeAgentPubkey(ctx.actorPubkey) ?? task.lastEditedBy ?? task.createdBy;
  const undoesStreak =
    !isRecoverableBountyTask(t) &&
    ctx.settings.streaksEnabled &&
    !!t.recurrence &&
    isFrequentRecurrence(t.recurrence) &&
    typeof t.streak === "number";
  const streak = undoesStreak ? Math.max(0, (t.streak as number) - 1) : t.streak;
  const bottomOrder =
    tasks.reduce((max, task) => {
      if (task.id === id || task.boardId !== t.boardId) return max;
      return Math.max(max, typeof task.order === "number" ? task.order : -1);
    }, -1) + 1;
  const publish: Task[] = [];
  const restored = detachCancelledRecurringTask(
    {
      ...t,
      completed: false,
      completedAt: undefined,
      completedBy: undefined,
      lastEditedBy: editor(t),
      updatedAt: nowISO,
      bountyDeletedAt: undefined,
      hiddenUntilISO: undefined,
      streak,
      longestStreak: mergeLongestStreak(t, streak),
      order: bottomOrder,
    },
    cutoffs,
  );
  publish.push(restored);
  const next = tasks.map((task) => {
    if (task.id === id) return restored;
    if (
      undoesStreak &&
      !task.completed &&
      task.recurrence &&
      tasksInSameSeries(task, t) &&
      new Date(task.dueISO) > new Date(t.dueISO)
    ) {
      const updated: Task = {
        ...task,
        seriesId: task.seriesId || task.id,
        streak,
        longestStreak: mergeLongestStreak(task, streak),
        lastEditedBy: editor(task),
        updatedAt: nowISO,
      };
      publish.push(updated);
      return updated;
    }
    return task;
  });
  return { tasks: next, publish, restored: t };
}

/** Removes completed tasks from a board's scope; recoverable bounties and unclaimed ecash stay. */
export function planClearCompleted(tasks: Task[], scopeBoardIds: ReadonlySet<string>): { tasks: Task[]; publishDeleted: Task[] } {
  const publishDeleted: Task[] = [];
  const next = tasks.filter((task) => {
    const clear =
      scopeBoardIds.has(task.boardId) &&
      !!task.completed &&
      !isRecoverableBountyTask(task) &&
      (!task.bounty || task.bounty.state === "claimed");
    if (clear) publishDeleted.push(task);
    return !clear;
  });
  return { tasks: publishDeleted.length ? next : tasks, publishDeleted };
}

export type SaveTaskPlan = {
  tasks: Task[];
  saved: Task;
  /** The assignees before the edit, so only newly added people are sent the assignment. */
  previousAssignees: TaskAssignee[] | null;
};

/**
 * Saves an edited or new task. Moving it to another board puts it at that board's end; moving a
 * frequent series' open occurrence later restarts its streak. Authorship is normalized to hex keys.
 */
export function planSaveTask(
  tasks: Task[],
  edited: Task,
  ctx: TaskEditContext & { settings: Pick<Settings, "newTaskPosition" | "streaksEnabled"> },
): SaveTaskPlan {
  const nowISO = ctx.now.toISOString();
  const withSeries = (task: Task): Task =>
    task.recurrence ? { ...task, seriesId: task.seriesId || task.id } : { ...task, seriesId: undefined };
  const withAuthors = (task: Task, previousCreatedBy?: string): Task => {
    const createdBy = normalizeAgentPubkey(task.createdBy || previousCreatedBy || ctx.actorPubkey) ?? undefined;
    const lastEditedBy = normalizeAgentPubkey(task.lastEditedBy || ctx.actorPubkey || createdBy) ?? createdBy;
    return {
      ...task,
      ...(createdBy ? { createdBy } : {}),
      ...(lastEditedBy ? { lastEditedBy } : {}),
      updatedAt: nowISO,
    };
  };

  const index = tasks.findIndex((task) => task.id === edited.id);
  if (index < 0) {
    let next = withAuthors(withSeries(edited));
    if (typeof next.order !== "number") {
      next = { ...next, order: nextOrderForBoard(next.boardId, tasks, ctx.settings.newTaskPosition) };
    }
    const saved = normalizeTaskBounty(next);
    return { tasks: [...tasks, saved], saved, previousAssignees: null };
  }

  const before = tasks[index];
  let next = edited;
  if (before.boardId !== edited.boardId) {
    next = { ...next, order: nextOrderForBoard(edited.boardId, tasks, ctx.settings.newTaskPosition) };
  }
  if (ctx.settings.streaksEnabled && before.recurrence && isFrequentRecurrence(before.recurrence) && !before.completed) {
    if (startOfDay(new Date(edited.dueISO)).getTime() > startOfDay(new Date(before.dueISO)).getTime()) {
      next = { ...next, streak: 0 };
    }
  }
  const saved = normalizeTaskBounty(withAuthors(withSeries(next), before.createdBy));
  const nextTasks = tasks.slice();
  nextTasks[index] = saved;
  return {
    tasks: nextTasks,
    saved,
    previousAssignees: Array.isArray(before.assignees) ? before.assignees : null,
  };
}

/** Moves a task's due date a week later, hiding it until then on its board. */
export function planPostponeTask(
  tasks: Task[],
  boards: Board[],
  id: string,
  ctx: TaskEditContext & { settings: Pick<Settings, "weekStart"> },
): { tasks: Task[]; updated: Task } | null {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  const t = tasks[index];
  const nextDue = startOfDay(new Date(t.dueISO));
  nextDue.setDate(nextDue.getDate() + 7);
  const boardKind = boards.find((board) => board.id === t.boardId)?.kind ?? "week";
  const updated: Task = {
    ...t,
    dueISO: nextDue.toISOString(),
    dueDateEnabled: true,
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) ?? t.lastEditedBy ?? t.createdBy,
    hiddenUntilISO: hiddenUntilForBoard(nextDue.toISOString(), boardKind, ctx.settings.weekStart, ctx.now),
  };
  const next = tasks.slice();
  next[index] = updated;
  return { tasks: next, updated };
}

export function planToggleSubtask(
  tasks: Task[],
  taskId: string,
  subtaskId: string,
  ctx: TaskEditContext,
): { tasks: Task[]; updated: Task } | null {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const t = tasks[index];
  const updated: Task = {
    ...t,
    subtasks: (t.subtasks || []).map((sub) => (sub.id === subtaskId ? { ...sub, completed: !sub.completed } : sub)),
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) ?? t.lastEditedBy ?? t.createdBy,
  };
  const next = tasks.slice();
  next[index] = updated;
  return { tasks: next, updated };
}

export type MoveTaskPlan = { tasks: Task[]; publish: Task[]; publishDeleted: Task[] };

const byOrder = (list: Task[]) => [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

/**
 * Places `moved` on its board before `beforeId` (or at the end) and renumbers the source and target
 * boards in their visible order. Order is device-local, so renumbered neighbours are not published.
 * The task is published (and its old board's copy deleted) only when other devices would see a
 * change.
 */
function placeMovedTask(tasks: Task[], original: Task, moved: Task, beforeId?: string): MoveTaskPlan {
  const arr = tasks.filter((t) => t.id !== original.id);
  const renumber = (boardId: string, insert?: { task: Task; beforeId?: string }) => {
    const ordered = byOrder(arr.filter((t) => t.boardId === boardId));
    if (insert) {
      const beforeIdx = insert.beforeId ? ordered.findIndex((t) => t.id === insert.beforeId) : -1;
      ordered.splice(beforeIdx >= 0 ? beforeIdx : ordered.length, 0, insert.task);
    }
    ordered.forEach((t, index) => {
      if (t === insert?.task) {
        insert.task.order = index;
        return;
      }
      if ((t.order ?? 0) !== index) {
        const idx = arr.findIndex((x) => x.id === t.id);
        if (idx >= 0) arr[idx] = { ...t, order: index };
      }
    });
  };
  if (original.boardId !== moved.boardId) renumber(original.boardId);
  renumber(moved.boardId, { task: moved, beforeId });
  arr.push(moved);

  const persistence = taskMovePersistencePlan(original, moved);
  // A reorder within the same list changes nothing other devices see.
  const changed = !!persistence.sourceToDelete || hasSyncedTaskChange(original, moved);
  return {
    tasks: arr,
    publish: changed ? [persistence.targetToPublish as Task] : [],
    publishDeleted: persistence.sourceToDelete ? [persistence.sourceToDelete as Task] : [],
  };
}

export type MoveTarget = { type: "day"; day: Weekday } | { type: "list"; columnId: string };

/**
 * Drag and drop: moves a task to a weekday (week boards) or a list column, possibly on another
 * board of a compound board, keeping its time of day. Placing a task reveals it and reopens it
 * unless it holds an unclaimed bounty; moving an open series occurrence later restarts its streak.
 */
export function planMoveTask(
  tasks: Task[],
  id: string,
  target: MoveTarget,
  beforeId: string | undefined,
  ctx: TaskEditContext & {
    settings: Pick<Settings, "weekStart" | "streaksEnabled">;
    currentBoard: Board | undefined;
    listColumnSources: ReadonlyMap<string, { boardId: string; columnId: string }>;
  },
): MoveTaskPlan | null {
  if (beforeId && beforeId === id) return null;
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const moved: Task = {
    ...task,
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) || task.lastEditedBy || task.createdBy,
  };
  const prevDue = startOfDay(new Date(task.dueISO));
  const timeZone = normalizeTimeZone(task.dueTimeZone) ?? undefined;
  const originalTime = task.dueTimeEnabled ? isoTimePart(task.dueISO, timeZone) : "";
  if (target.type === "day") {
    moved.column = "day";
    moved.columnId = undefined;
    moved.dueISO = isoForWeekdayLocal(target.day, {
      base: Number.isNaN(prevDue.getTime()) ? undefined : prevDue,
      weekStart: ctx.settings.weekStart,
    });
    moved.dueDateEnabled = true;
  } else {
    if (!isListLikeBoard(ctx.currentBoard)) return null;
    const source = ctx.listColumnSources.get(target.columnId);
    if (!source) return null;
    moved.column = undefined;
    moved.columnId = source.columnId;
    moved.boardId = source.boardId;
  }
  if (originalTime) {
    const withTime = isoFromDateTime(isoDatePart(moved.dueISO), originalTime, timeZone);
    if (withTime) moved.dueISO = withTime;
  }
  if (
    ctx.settings.streaksEnabled &&
    task.recurrence &&
    isFrequentRecurrence(task.recurrence) &&
    !task.completed &&
    startOfDay(new Date(moved.dueISO)).getTime() > prevDue.getTime()
  ) {
    moved.streak = 0;
  }
  moved.hiddenUntilISO = undefined;
  if (moved.completed && (!moved.bounty || moved.bounty.state === "claimed")) {
    moved.completed = false;
    moved.completedAt = undefined;
    moved.completedBy = undefined;
  }
  return placeMovedTask(tasks, task, moved, beforeId);
}

/**
 * Moves a task to another board: the day column of a week board, or the first list of a list
 * board (for a compound board, of its first list child), due this week's first day. It lands at
 * the top or bottom of the board, per the new-task position setting, as an edit's board move does.
 */
export function planMoveTaskToBoard(
  tasks: Task[],
  boards: Board[],
  id: string,
  boardId: string,
  ctx: TaskEditContext & { settings: Pick<Settings, "newTaskPosition"> },
): MoveTaskPlan | null {
  const task = tasks.find((t) => t.id === id);
  const targetBoard = boards.find((b) => b.id === boardId);
  if (!task || !targetBoard || targetBoard.kind === "bible") return null;
  const moved: Task = {
    ...task,
    boardId,
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) || task.lastEditedBy || task.createdBy,
  };
  if (targetBoard.kind === "week") {
    moved.column = "day";
    moved.columnId = undefined;
  } else {
    let listBoard: Extract<Board, { kind: "lists" }> | undefined;
    if (targetBoard.kind === "compound") {
      listBoard = targetBoard.children
        .map((childId) => boards.find((b) => b.id === childId))
        .find((b): b is Extract<Board, { kind: "lists" }> => !!b && b.kind === "lists");
      if (!listBoard || !listBoard.columns.length) return null;
      moved.boardId = listBoard.id;
    } else {
      listBoard = targetBoard as Extract<Board, { kind: "lists" }>;
    }
    moved.column = undefined;
    moved.columnId = listBoard.columns[0]?.id;
    moved.dueISO = isoForWeekdayLocal(0, { base: ctx.now });
  }
  const first = ctx.settings.newTaskPosition === "top"
    ? byOrder(tasks.filter((t) => t.boardId === moved.boardId && t.id !== id))[0]
    : undefined;
  return placeMovedTask(tasks, task, moved, first?.id);
}

/** Moves several tasks into one list column, in the order given, landing per the new-task position. */
export function planMoveTasksToColumn(
  tasks: Task[],
  ids: readonly string[],
  boardId: string,
  columnId: string,
  ctx: TaskEditContext & { settings: Pick<Settings, "newTaskPosition"> },
): MoveTaskPlan {
  let current = tasks;
  const publish = new Map<string, Task>();
  const publishDeleted: Task[] = [];
  const top = ctx.settings.newTaskPosition === "top";
  // Inserted at the top in reverse, so the selection keeps its order there too.
  for (const id of top ? [...ids].reverse() : ids) {
    const task = current.find((t) => t.id === id);
    if (!task) continue;
    const moved: Task = {
      ...task,
      boardId,
      column: undefined,
      columnId,
      lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) || task.lastEditedBy || task.createdBy,
    };
    const first = top ? byOrder(current.filter((t) => t.boardId === boardId && t.id !== id))[0] : undefined;
    const plan = placeMovedTask(current, task, moved, first?.id);
    current = plan.tasks;
    plan.publish.forEach((t) => publish.set(t.id, t));
    publishDeleted.push(...plan.publishDeleted);
  }
  return { tasks: current, publish: [...publish.values()], publishDeleted };
}

/** Saves a note edited in place, with any checklist items the editor turned into subtasks. */
export function planUpdateTaskNote(
  tasks: Task[],
  taskId: string,
  note: string,
  appendedSubtasks: Subtask[],
  ctx: TaskEditContext,
): { tasks: Task[]; updated: Task } | null {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const t = tasks[index];
  const trimmed = note.trim();
  if ((t.note || "") === trimmed && !appendedSubtasks.length) return null;
  const updated: Task = {
    ...t,
    note: trimmed || undefined,
    subtasks: appendedSubtasks.length ? [...(t.subtasks || []), ...appendedSubtasks] : t.subtasks,
    lastEditedBy: normalizeAgentPubkey(ctx.actorPubkey) ?? t.lastEditedBy ?? t.createdBy,
  };
  const next = tasks.slice();
  next[index] = updated;
  return { tasks: next, updated };
}

/** Records an assignee's answer on the assigned task, attributed to them. */
export function planAssignmentResponse(
  tasks: Task[],
  taskId: string,
  responderPubkey: string,
  status: TaskAssigneeStatus,
  respondedAtMs: number,
): { tasks: Task[]; updated: Task } | null {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const t = tasks[index];
  const assignees = mergeTaskAssigneeResponse(t.assignees, responderPubkey, status, respondedAtMs);
  if (assignees === t.assignees) return null;
  const updated: Task = { ...t, assignees, lastEditedBy: responderPubkey };
  const next = tasks.slice();
  next[index] = updated;
  return { tasks: next, updated };
}
