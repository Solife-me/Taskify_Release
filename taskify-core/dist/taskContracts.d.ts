export type TaskPriority = 1 | 2 | 3;
export declare const TASK_PRIORITY_MARKS: Record<TaskPriority, string>;
import type { Weekday } from "./weekDate.js";
import type { ReminderPreset } from "./reminderUtils.js";
import type { CalendarRsvpFb, CalendarRsvpStatus } from "./calendarDecode.js";
import type { SharedContactPayload, SharedTaskPayload } from "./shareContracts.js";
export type Recurrence = {
    type: "none";
    untilISO?: string;
} | {
    type: "daily";
    untilISO?: string;
} | {
    type: "weekly";
    days: Weekday[];
    untilISO?: string;
} | {
    type: "every";
    n: number;
    unit: "hour" | "day" | "week";
    untilISO?: string;
} | {
    type: "monthlyDay";
    day: number;
    interval?: number;
    untilISO?: string;
};
export type Subtask = {
    id: string;
    title: string;
    completed?: boolean;
};
export type InboxSender = {
    pubkey: string;
    name?: string;
    npub?: string;
};
export type InboxItemStatus = "pending" | "accepted" | "declined" | "tentative" | "deleted" | "read";
export type TaskDocument = Record<string, unknown>;
export type InboxItem = {
    type: "board";
    boardId: string;
    boardName?: string;
    relays?: string[];
    sender: InboxSender;
    receivedAt: string;
    status?: InboxItemStatus;
    dmEventId?: string;
} | {
    type: "contact";
    contact: SharedContactPayload;
    sender: InboxSender;
    receivedAt: string;
    status?: InboxItemStatus;
    dmEventId?: string;
} | {
    type: "task";
    task: SharedTaskPayload;
    sender: InboxSender;
    receivedAt: string;
    status?: InboxItemStatus;
    dmEventId?: string;
};
export type TaskAssigneeStatus = "pending" | "accepted" | "declined" | "tentative";
export type TaskAssignee = {
    pubkey: string;
    relay?: string;
    status?: TaskAssigneeStatus;
    respondedAt?: number;
};
export type Task = {
    id: string;
    boardId: string;
    title: string;
    dueISO: string;
    createdBy?: string;
    lastEditedBy?: string;
    createdAt?: number;
    updatedAt?: string;
    _nostrAt?: number;
    priority?: TaskPriority;
    note?: string;
    images?: string[];
    documents?: TaskDocument[];
    dueDateEnabled?: boolean;
    completed?: boolean;
    completedAt?: string;
    completedBy?: string;
    recurrence?: Recurrence;
    column?: "day";
    columnId?: string;
    hiddenUntilISO?: string;
    order?: number;
    streak?: number;
    longestStreak?: number;
    seriesId?: string;
    subtasks?: Subtask[];
    assignees?: TaskAssignee[];
    dueTimeEnabled?: boolean;
    dueTimeZone?: string;
    reminders?: ReminderPreset[];
    reminderTime?: string;
    scriptureMemoryId?: string;
    scriptureMemoryStage?: number;
    scriptureMemoryPrevReviewISO?: string | null;
    scriptureMemoryScheduledAt?: string;
    bountyLists?: string[];
    bountyDeletedAt?: string;
    inboxItem?: InboxItem;
    bounty?: {
        id: string;
        token: string;
        amount?: number;
        mint?: string;
        lock?: "p2pk" | "htlc" | "none" | "unknown";
        owner?: string;
        sender?: string;
        receiver?: string;
        state: "locked" | "unlocked" | "revoked" | "claimed";
        updatedAt: string;
        enc?: {
            alg: "aes-gcm-256";
            iv: string;
            ct: string;
        } | {
            alg: "nip04";
            data: string;
        } | null;
    };
};
export type CalendarEventParticipant = {
    pubkey: string;
    relay?: string;
    role?: string;
};
export type CalendarEventBase = {
    id: string;
    boardId: string;
    title: string;
    createdBy?: string;
    lastEditedBy?: string;
    columnId?: string;
    order?: number;
    summary?: string;
    description?: string;
    documents?: TaskDocument[];
    image?: string;
    locations?: string[];
    geohash?: string;
    participants?: CalendarEventParticipant[];
    hashtags?: string[];
    references?: string[];
    reminders?: ReminderPreset[];
    reminderTime?: string;
    hiddenUntilISO?: string;
    recurrence?: Recurrence;
    seriesId?: string;
    readOnly?: boolean;
    external?: boolean;
    originBoardId?: string;
    eventKey?: string;
    inviteTokens?: Record<string, string>;
    canonicalAddress?: string;
    viewAddress?: string;
    inviteToken?: string;
    inviteRelays?: string[];
    boardPubkey?: string;
    rsvpStatus?: CalendarRsvpStatus;
    rsvpCreatedAt?: number;
    rsvpFb?: CalendarRsvpFb;
};
export type DateCalendarEvent = CalendarEventBase & {
    kind: "date";
    startDate: string;
    endDate?: string;
};
export type TimeCalendarEvent = CalendarEventBase & {
    kind: "time";
    startISO: string;
    endISO?: string;
    startTzid?: string;
    endTzid?: string;
};
export type CalendarEvent = DateCalendarEvent | TimeCalendarEvent;
export type ExternalCalendarEvent = CalendarEvent & {
    external: true;
    boardPubkey: string;
};
export declare function isExternalCalendarEvent(event: CalendarEvent): event is ExternalCalendarEvent;
export type EditItemType = "task" | "event";
export type EditingState = {
    type: "task";
    originalType: EditItemType;
    originalId: string;
    task: Task;
} | {
    type: "event";
    originalType: EditItemType;
    originalId: string;
    event: CalendarEvent;
};
export type BoardSortMode = "manual" | "due" | "priority" | "created" | "alpha";
export type BoardSortDirection = "asc" | "desc";
export type UpcomingBoardGrouping = "mixed" | "grouped";
export type ListColumn = {
    id: string;
    name: string;
};
export type CompoundChildId = string;
export type BoardBase = {
    id: string;
    name: string;
    nostr?: {
        boardId: string;
        relays: string[];
    };
    archived?: boolean;
    hidden?: boolean;
    clearCompletedDisabled?: boolean;
};
export type Board = (BoardBase & {
    kind: "week";
}) | (BoardBase & {
    kind: "lists";
    columns: ListColumn[];
    indexCardEnabled?: boolean;
}) | (BoardBase & {
    kind: "compound";
    children: CompoundChildId[];
    indexCardEnabled?: boolean;
    hideChildBoardNames?: boolean;
}) | (BoardBase & {
    kind: "bible";
});
export type ListLikeBoard = Extract<Board, {
    kind: "lists" | "compound";
}>;
export declare function isListLikeBoard(board: Board | null | undefined): board is ListLikeBoard;
