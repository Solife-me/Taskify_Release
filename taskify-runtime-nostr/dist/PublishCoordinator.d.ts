import { NDKEvent, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { type EventTemplate, type NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import { type NostrOutboxPublishPayload, type NostrOutboxStore } from "./NostrOutbox.js";
import { type EventSigner, type ProofOfWorkOptions } from "./ProofOfWork.js";
import { RelayPublishBudget } from "./RelayPublishBudget.js";
export type RelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
export type PublishOptions = {
    relayUrls?: string[];
    signer?: NDKSigner | Uint8Array | string;
    proofOfWorkSigner?: EventSigner;
    replaceableKey?: string;
    debounceMs?: number;
    returnEvent?: boolean;
    skipIfIdentical?: boolean;
    /** Part of a board republish (see `limitQueuedRepublish`). */
    republish?: boolean;
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
    returnOnFirstAcknowledgement?: boolean;
    recoverProofOfWorkSigner?: (payload: NostrOutboxPublishPayload) => Promise<EventSigner | undefined>;
    knownProofOfWorkDifficulty?: (relayUrl: string) => number;
    resolveProofOfWorkDifficulty?: (relayUrls: string[]) => Promise<number>;
    onMine?: (difficulty: number, relays: string[]) => void;
    /** Mining settings (hasher, timeout) used when a publish needs proof of work. */
    proofOfWork?: Omit<ProofOfWorkOptions, "signal">;
    /** Called when a relay refuses an event for too little proof of work and names its target. */
    onProofOfWorkRequired?: (relayUrl: string, difficulty: number) => void;
    /**
     * Per-relay pacing and rate-limit backoff. Applies when an outbox store is configured (a
     * paced relay must stay queued somewhere); pass `false` to disable.
     */
    publishBudget?: RelayPublishBudget | false;
};
export declare class PublishCoordinator {
    private replaceableCache;
    private pending;
    private closed;
    private shutdownPromise;
    private readonly debounceDefault;
    private eventCache?;
    private resolveRelaySet;
    private ndk;
    private readonly outboxStore?;
    private readonly retryBaseMs;
    private readonly retryMaxMs;
    private readonly signal?;
    private readonly recoverProofOfWorkSigner?;
    private readonly knownProofOfWorkDifficulty?;
    private readonly resolveProofOfWorkDifficulty?;
    private readonly onMine?;
    private readonly returnOnFirstAcknowledgement;
    private readonly backgroundPublishes;
    private readonly retrySigners;
    private readonly proofOfWork?;
    private readonly onProofOfWorkRequired?;
    private activeOutboxIds;
    private outboxLocks;
    private readonly relayDrains;
    private readonly relayRetryTimers;
    private readonly retryingRows;
    private readonly outboxMining;
    private readonly publishBudget;
    constructor(ndk: NDK, resolveRelaySet: RelayResolver, cache?: EventCache, options?: PublishCoordinatorOptions);
    private buildReplaceableKey;
    private publishNow;
    private resolveRelaySetWithEnsure;
    private scheduleDebouncedPublish;
    /** Publishes a debounced event now and settles every caller waiting on it. */
    private firePending;
    private shouldSkipReplaceable;
    private outboxMutationId;
    private relayUrlsForPublish;
    private outboxHasPending;
    private withOutboxLock;
    private enqueueOutbox;
    private publishForCaller;
    private persistPartialAcknowledgements;
    private publishNowWithOutbox;
    private publishByRelay;
    private mineVariant;
    private markOutboxSuccess;
    private markOutboxSuccessLocked;
    private markOutboxFailure;
    private markOutboxFailureLocked;
    private retryDelayMs;
    private saveInitialRetry;
    private isDebouncedOutboxId;
    drainOutbox(options?: {
        force?: boolean;
        limit?: number;
        relayUrl?: string;
    }): Promise<void>;
    private enqueueRelayRetries;
    private runRelayDrain;
    private scheduleRelayRetry;
    private retryOutboxMutation;
    private recordRelayRetry;
    /**
     * Stops sending a board's queued republish to public relays; it still reaches `keptRelayUrls`
     * (Taskify's own relays by default). Returns how many queued rows changed.
     */
    limitQueuedRepublish(boardTag: string, keptRelayUrls?: readonly string[]): Promise<number>;
    /**
     * Terminal. Debounced publishes still waiting are sent now, so their callers get the real
     * result rather than a promise that never settles; retries stop; later publishes fail with
     * `RuntimeSessionClosedError`. Idempotent: later calls wait for the first.
     */
    shutdown(): Promise<void>;
    publish(templateOrEvent: EventTemplate | NDKEvent, options?: PublishOptions): Promise<PublishResult>;
    publishRaw(event: NostrEvent, options?: PublishOptions): Promise<PublishResult>;
}
