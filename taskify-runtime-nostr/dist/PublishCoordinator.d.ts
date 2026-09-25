import { NDKEvent, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import { type NostrOutboxStore } from "./NostrOutbox.js";
import { RelayPublishBudget } from "./RelayPublishBudget.js";
export type RelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
export type PublishOptions = {
    relayUrls?: string[];
    signer?: NDKSigner | Uint8Array | string;
    replaceableKey?: string;
    debounceMs?: number;
    returnEvent?: boolean;
    skipIfIdentical?: boolean;
};
export type PublishResult = number | {
    createdAt: number;
    event: NostrEvent;
};
export declare class NostrWriteQueuedError extends Error {
    readonly code = "WRITE_QUEUED";
    readonly retryable = true;
    constructor();
}
export type PublishCoordinatorOptions = {
    outboxStore?: NostrOutboxStore;
    retryBaseMs?: number;
    retryMaxMs?: number;
    signal?: AbortSignal;
    resolveProofOfWorkDifficulty?: (relayUrls: string[]) => Promise<number>;
    /**
     * Per-relay pacing and rate-limit backoff. Applies when an outbox store is configured (a
     * paced relay must stay queued somewhere); pass `false` to disable.
     */
    publishBudget?: RelayPublishBudget | false;
};
export declare class PublishCoordinator {
    private replaceableCache;
    private pending;
    private readonly debounceDefault;
    private eventCache?;
    private resolveRelaySet;
    private ndk;
    private readonly outboxStore?;
    private readonly retryBaseMs;
    private readonly retryMaxMs;
    private readonly signal?;
    private readonly resolveProofOfWorkDifficulty?;
    private activeOutboxIds;
    private outboxLocks;
    private retryTimers;
    private drainPromise;
    private readonly publishBudget;
    constructor(ndk: NDK, resolveRelaySet: RelayResolver, cache?: EventCache, options?: PublishCoordinatorOptions);
    private buildReplaceableKey;
    private publishNow;
    private resolveRelaySetWithEnsure;
    private scheduleDebouncedPublish;
    private shouldSkipReplaceable;
    private outboxMutationId;
    private relayUrlsForPublish;
    private outboxHasPending;
    private withOutboxLock;
    private enqueueOutbox;
    private publishNowWithOutbox;
    private markOutboxSuccess;
    private markOutboxSuccessLocked;
    private markOutboxFailure;
    private markOutboxFailureLocked;
    /** When every pending relay is held back after refusing the event, wait for the first release. */
    private delayRespectingHeldBackRelays;
    private retryDelayMs;
    private clearOutboxRetry;
    private scheduleOutboxRetry;
    private isDebouncedOutboxId;
    drainOutbox(options?: {
        force?: boolean;
        limit?: number;
    }): Promise<void>;
    private drainOutboxInternal;
    private retryOutboxMutation;
    shutdown(): void;
    publish(templateOrEvent: EventTemplate | NDKEvent, options?: PublishOptions): Promise<PublishResult>;
    publishRaw(event: NostrEvent, options?: PublishOptions): Promise<PublishResult>;
}
