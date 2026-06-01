import type { NostrEvent } from "nostr-tools";
export type NostrOutboxMutationKind = "nostr.publish";
export type NostrOutboxPublishPayload = {
    event: NostrEvent;
    relayUrls: string[];
    replaceableKey?: string | null;
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
};
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
}): NostrOutboxMutation;
export declare function pendingRelayUrlsForMutation(mutation: NostrOutboxMutation): string[];
export declare function mergeOutboxRelayAcks(mutation: NostrOutboxMutation, ackedRelays: string[], nowMs?: number): NostrOutboxMutation | null;
export declare function markOutboxPublishFailure(args: {
    mutation: NostrOutboxMutation;
    ackedRelays?: string[];
    error: unknown;
    nextAttemptAt: number;
    nowMs?: number;
}): NostrOutboxMutation | null;
export declare function errorToMessage(error: unknown): string;
