import { NDKEvent, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import { type NostrOutboxStore } from "./NostrOutbox.js";
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
export type PublishCoordinatorOptions = {
    outboxStore?: NostrOutboxStore;
    retryBaseMs?: number;
    retryMaxMs?: number;
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
    private activeOutboxIds;
    private retryTimers;
    private drainPromise;
    constructor(ndk: NDK, resolveRelaySet: RelayResolver, cache?: EventCache, options?: PublishCoordinatorOptions);
    private buildReplaceableKey;
    private publishNow;
    private resolveRelaySetWithEnsure;
    private scheduleDebouncedPublish;
    private shouldSkipReplaceable;
    private outboxMutationId;
    private relayUrlsForPublish;
    private outboxHasPending;
    private enqueueOutbox;
    private publishNowWithOutbox;
    private markOutboxSuccess;
    private markOutboxFailure;
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
