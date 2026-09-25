import type { NostrEvent } from "nostr-tools";
export type NostrOutboxMutationKind = "nostr.publish";
export type NostrOutboxPublishPayload = {
    event: NostrEvent;
    relayUrls: string[];
    replaceableKey?: string | null;
};
/** When a relay that refused an event outright may be offered it again. */
export type OutboxRelayRejection = {
    count: number;
    retryAfter: number;
};
export type NostrOutboxMutation = {
    id: string;
    kind: NostrOutboxMutationKind;
    payload: NostrOutboxPublishPayload;
    intentAt: number;
    attempts: number;
    lastError: string | null;
    ackedRelays: string[];
    pendingRelays: string[];
    nextAttemptAt: number | null;
    updatedAt: number;
    /**
     * Relays that refused this event outright (blocked/restricted/invalid). The event stays queued
     * for them, since it may be the only copy, but each is held back until its retry time instead
     * of being resent on every attempt. Matches native `RelayRejectionBackoff`.
     */
    relayRejections?: Record<string, OutboxRelayRejection>;
    /**
     * Queued by a board republish: current state resent, not a new change. Absent only on rows
     * written before the flag existed (see `narrowRepublishedMutations`).
     */
    isRepublish?: boolean;
};
/** Records outright refusals: 1 hour after the first, doubling each time, capped at a week. */
export declare function recordOutboxRelayRejections(mutation: NostrOutboxMutation, relayUrls: string[], nowMs?: number): NostrOutboxMutation;
/** When the earliest held-back relay may be retried, or null when none are held back. */
export declare function earliestRejectionRelease(mutation: NostrOutboxMutation, nowMs?: number): number | null;
export type NostrOutboxStore = {
    get(id: string): Promise<NostrOutboxMutation | undefined>;
    put(mutation: NostrOutboxMutation): Promise<void>;
    delete(id: string): Promise<void>;
    listPending(): Promise<NostrOutboxMutation[]>;
};
export declare function cloneNostrEvent(event: NostrEvent): NostrEvent;
export declare function createNostrOutboxMutation(args: {
    id: string;
    event: NostrEvent;
    relayUrls: string[];
    replaceableKey?: string | null;
    nowMs?: number;
    existing?: NostrOutboxMutation;
    nextAttemptAt?: number | null;
    isRepublish?: boolean;
}): NostrOutboxMutation;
/**
 * Stops sending a board's republished rows anywhere but `keptRelayUrls` (Taskify's own relays).
 * A republish resends current state that other devices already have, but a row can still carry
 * the only copy of an edit it replaced in the queue, so rows are narrowed rather than dropped:
 * they still reach a kept relay, which every client reads. A row that targets none of the kept
 * relays is left untouched. Matches native `NostrOutboxStore.limitRepublishedEntries`.
 *
 * Rows from before `isRepublish` existed can't say which a republish queued, so there a burst of
 * at least `legacyBurstMinimum` rows for the board, queued no more than `legacyBurstGapMs` apart,
 * counts: ordinary edits never queue that many at once.
 */
export declare function narrowRepublishedMutations(rows: NostrOutboxMutation[], options: {
    boardTag: string;
    keptRelayUrls: readonly string[];
    legacyBurstMinimum?: number;
    legacyBurstGapMs?: number;
}): {
    updated: NostrOutboxMutation[];
    completedIds: string[];
};
/** The relays to send to now: still pending, and not held back after refusing the event. */
export declare function pendingRelayUrlsForMutation(mutation: NostrOutboxMutation, nowMs?: number): string[];
export declare function mergeOutboxRelayAcks(mutation: NostrOutboxMutation, ackedRelays: string[], nowMs?: number): NostrOutboxMutation | null;
export declare function markOutboxPublishFailure(args: {
    mutation: NostrOutboxMutation;
    ackedRelays?: string[];
    error: unknown;
    nextAttemptAt: number;
    nowMs?: number;
}): NostrOutboxMutation | null;
export declare function errorToMessage(error: unknown): string;
