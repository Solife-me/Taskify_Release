import { isChatInboxResponseStatus, type ChatInboxResponse } from "taskify-core";
import type { InboxItemStatus, Task } from "../tasks/taskTypes";
import type { CalendarInvite, CalendarInviteStatus } from "../calendar/calendarInvitesHook";

// Shared items (tasks, boards, contacts) arrive as inbox tasks. Answering one here is recorded
// on the task; these helpers turn that into the synced chat state and back, so another signed-in
// device stops offering Add/Dismiss for something already handled.

const STATUS_NOTE_LINES: Record<ChatInboxResponse["status"], string> = {
  accepted: "Action: Added",
  tentative: "Action: Maybe",
  declined: "Action: Declined",
  deleted: "Action: Dismissed",
};

function isAwaitingResponse(status: InboxItemStatus | undefined): boolean {
  return !status || status === "pending" || status === "read";
}

function wrapEventId(task: Task): string | null {
  const id = task.inboxItem?.dmEventId?.trim().toLowerCase();
  return id || null;
}

export function collectInboxResponses(tasks: readonly Task[]): Record<string, ChatInboxResponse> {
  const responses: Record<string, ChatInboxResponse> = {};
  for (const task of tasks) {
    const status = task.inboxItem?.status;
    if (!isChatInboxResponseStatus(status)) continue;
    const id = wrapEventId(task);
    if (!id) continue;
    const answeredAt = Date.parse(task.completedAt || task.updatedAt || "");
    responses[id] = { status, at: Number.isFinite(answeredAt) ? Math.floor(answeredAt / 1000) : 0 };
  }
  return responses;
}

export function pendingInboxEventIds(tasks: readonly Task[]): string[] {
  const ids: string[] = [];
  for (const task of tasks) {
    if (!task.inboxItem || !isAwaitingResponse(task.inboxItem.status)) continue;
    const id = wrapEventId(task);
    if (id) ids.push(id);
  }
  return ids.sort();
}

/**
 * Marks pending inbox items answered with the other device's response. Only the local record
 * changes: adding the task, contact or board already happened on the device that answered, and
 * reaches this one through its own sync. Returns `tasks` itself when nothing applies.
 */
export function applyInboxResponsesToTasks(
  tasks: Task[],
  responses: Record<string, ChatInboxResponse>,
): Task[] {
  let changed = false;
  const next = tasks.map((task) => {
    if (!task.inboxItem || !isAwaitingResponse(task.inboxItem.status)) return task;
    const id = wrapEventId(task);
    const response = id ? responses[id] : undefined;
    if (!response) return task;
    changed = true;
    // Stamp the other device's time so re-deriving this response reproduces it exactly.
    const answeredAt = new Date(response.at * 1000).toISOString();
    const noteHasStatus = typeof task.note === "string" && task.note.includes("Action:");
    return {
      ...task,
      inboxItem: { ...task.inboxItem, status: response.status },
      note: noteHasStatus ? task.note : [task.note, STATUS_NOTE_LINES[response.status]].filter(Boolean).join("\n"),
      completed: true,
      completedAt: answeredAt,
    } as Task;
  });
  return changed ? next : tasks;
}

// Calendar invites are stored once per calendar address, but may arrive in more than one gift
// wrap (a resend, or a copy per relay set). Native clients key an invite by whichever wrap they
// saw first, so a response is published under every wrap id this device saw, and a remote
// response matches on any of them.

const CALENDAR_STATUS_TO_SYNC: Partial<Record<CalendarInviteStatus, ChatInboxResponse["status"]>> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  dismissed: "deleted",
};

const SYNC_TO_CALENDAR_STATUS: Record<ChatInboxResponse["status"], CalendarInviteStatus> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  deleted: "dismissed",
};

function inviteWrapIds(invite: CalendarInvite): string[] {
  return (invite.dmEventIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean);
}

function isInviteAwaitingResponse(invite: CalendarInvite): boolean {
  return invite.status === "pending" || invite.status === "read";
}

export function collectCalendarInviteResponses(invites: readonly CalendarInvite[]): Record<string, ChatInboxResponse> {
  const responses: Record<string, ChatInboxResponse> = {};
  for (const invite of invites) {
    const status = CALENDAR_STATUS_TO_SYNC[invite.status];
    if (!status) continue;
    const answeredAt = Date.parse(invite.respondedAt || "");
    const at = Number.isFinite(answeredAt) ? Math.floor(answeredAt / 1000) : 0;
    for (const id of inviteWrapIds(invite)) responses[id] = { status, at };
  }
  return responses;
}

export function pendingCalendarInviteEventIds(invites: readonly CalendarInvite[]): string[] {
  return invites.filter(isInviteAwaitingResponse).flatMap(inviteWrapIds).sort();
}

/**
 * Marks pending invites answered with another device's response. `accepted` lists the invites
 * newly accepted or marked maybe, which the caller adds to this device's calendar (locally only:
 * the RSVP already went out from the device that answered).
 */
export function applyInboxResponsesToCalendarInvites(
  invites: CalendarInvite[],
  responses: Record<string, ChatInboxResponse>,
): { invites: CalendarInvite[]; accepted: CalendarInvite[] } {
  const accepted: CalendarInvite[] = [];
  let changed = false;
  const next = invites.map((invite) => {
    if (!isInviteAwaitingResponse(invite)) return invite;
    const response = inviteWrapIds(invite).map((id) => responses[id]).find(Boolean);
    if (!response) return invite;
    changed = true;
    const updated: CalendarInvite = {
      ...invite,
      status: SYNC_TO_CALENDAR_STATUS[response.status],
      respondedAt: new Date(response.at * 1000).toISOString(),
    };
    if (response.status === "accepted" || response.status === "tentative") accepted.push(updated);
    return updated;
  });
  return { invites: changed ? next : invites, accepted };
}
