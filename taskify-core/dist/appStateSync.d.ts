export declare const APP_STATE_SYNC_KIND = 30078;
export declare const APP_STATE_SYNC_CLIENT_TAG = "taskify.app";
export declare const BIBLE_TRACKER_SYNC_D_TAG = "taskify-bible-tracker";
export declare const SCRIPTURE_MEMORY_SYNC_D_TAG = "taskify-scripture-memory";
export declare const CHAT_STATE_SYNC_D_TAG = "taskify-chat-state";
/**
 * Three-way merge of a set: an element added on either side is kept, one removed on either
 * side (present in `base`) is dropped. Without a base every element on either side is kept.
 */
export declare function mergeSetThreeWay<T extends string | number>(base: readonly T[] | undefined, local: readonly T[], remote: readonly T[]): T[];
export type ScriptureMemorySyncEntry = {
    id: string;
    bookId: string;
    chapter: number;
    startVerse: number | null;
    endVerse: number | null;
    addedAtISO: string;
    lastReviewISO?: string;
    scheduledAtISO?: string;
    stage: number;
    totalReviews: number;
};
export type ScriptureMemorySyncState = {
    entries: ScriptureMemorySyncEntry[];
    lastReviewISO?: string;
};
export declare function mergeScriptureMemoryStates<S extends ScriptureMemorySyncState>(base: ScriptureMemorySyncState | null | undefined, local: S, remote: ScriptureMemorySyncState): S;
export type BibleTrackerSyncArchiveEntry = {
    id: string;
    savedAtISO: string;
    lastResetISO: string;
    progress: Record<string, number[]>;
    verses: Record<string, Record<string, number[]>>;
    verseCounts: Record<string, Record<string, number>>;
    completedBooks: Record<string, {
        completedAtISO: string;
    }>;
};
export type BibleTrackerSyncState = {
    lastResetISO: string;
    progress: Record<string, number[]>;
    verses: Record<string, Record<string, number[]>>;
    verseCounts: Record<string, Record<string, number>>;
    completedBooks: Record<string, {
        completedAtISO: string;
    }>;
    archive: BibleTrackerSyncArchiveEntry[];
};
export declare function mergeBibleTrackerStates<S extends BibleTrackerSyncState>(base: BibleTrackerSyncState | null | undefined, local: S, remote: BibleTrackerSyncState): S;
/**
 * Order-independent fingerprints of the synced content. Clients compare these, not raw JSON,
 * to decide whether there is anything to publish: raw JSON also changes with key order and
 * with device-only UI fields (the PWA's `expandedBooks`), and treating either as a change
 * would republish on every expand/collapse and let two devices bounce merges back and forth.
 */
export declare function bibleTrackerSyncKey(state: BibleTrackerSyncState): string;
/**
 * The part of a Bible tracker that syncs. Device-only UI state such as which books are expanded
 * stays on the device: it is left out of the published payload as well as the comparison.
 */
export declare function bibleTrackerSyncContent(state: BibleTrackerSyncState): BibleTrackerSyncState;
export declare function scriptureMemorySyncKey(state: ScriptureMemorySyncState): string;
export type ChatInboxResponseStatus = "accepted" | "declined" | "tentative" | "deleted";
export type ChatInboxResponse = {
    status: ChatInboxResponseStatus;
    /** Unix seconds when the response was made. */
    at: number;
};
export type ChatSyncState = {
    /** Conversation key (lowercased peer pubkey or group id) -> read-through Unix seconds. */
    readThrough: Record<string, number>;
    /** Shared-item gift-wrap event id -> the response given on some device. */
    inboxResponses: Record<string, ChatInboxResponse>;
};
export type ChatSyncPayload = ChatSyncState & {
    version: 1;
    timestamp: number;
};
export declare function isChatInboxResponseStatus(value: unknown): value is ChatInboxResponseStatus;
export declare function emptyChatSyncState(): ChatSyncState;
export declare function sanitizeChatSyncState(raw: unknown): ChatSyncState;
export declare function mergeChatSyncStates(a: ChatSyncState, b: ChatSyncState): ChatSyncState;
/**
 * True when merging `local` into `remote` would change nothing — i.e. there is nothing for
 * this device to publish. Checks only `local`'s entries, so it stays cheap on every keystroke.
 */
export declare function chatSyncStateCovers(remote: ChatSyncState, local: ChatSyncState): boolean;
export declare function chatSyncStatesEqual(a: ChatSyncState, b: ChatSyncState): boolean;
/**
 * Keeps the synced chat state small: drops shared-item responses older than `maxAgeSeconds`
 * and keeps only the newest `maxEntries` of each map. A dropped read marker costs at most a
 * stale unread badge on a device that never opened that conversation.
 */
export declare function pruneChatSyncState(state: ChatSyncState, options: {
    nowSeconds: number;
    maxAgeSeconds?: number;
    maxEntries?: number;
}): ChatSyncState;
