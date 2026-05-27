import type NDK from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKRelaySet, NDKSubscription, NDKSubscriptionOptions } from "@nostr-dev-kit/ndk";
import type { NostrEvent } from "nostr-tools";
import { CursorStore } from "./CursorStore.js";
import { EventCache } from "./EventCache.js";
export type SubscriptionRelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
export type RelayLimitResolver = (relayUrls: string[]) => Promise<number | null>;
export type SubscribeOptions = {
    relayUrls?: string[];
    onEvent?: (event: NostrEvent, relay?: string) => void;
    onEose?: (relay?: string) => void;
    skipSince?: boolean;
    opts?: NDKSubscriptionOptions;
};
export type ManagedSubscription = {
    key: string;
    subscription: NDKSubscription;
    release: () => void;
    filters: NDKFilter[];
    relayUrls: string[];
};
export declare class SubscriptionManager {
    private readonly ndk;
    private readonly cursorStore;
    private readonly eventCache?;
    private readonly resolveRelaySet;
    private readonly relayLimitResolver?;
    private readonly subs;
    constructor(ndk: NDK, cursorStore: CursorStore, resolveRelaySet: SubscriptionRelayResolver, eventCache?: EventCache, relayLimitResolver?: RelayLimitResolver);
    private clampFilters;
    private normalizeFilters;
    private scheduleFlush;
    private scheduleEoseFlush;
    private flushPending;
    private flushEose;
    subscribe(filtersInput: NDKFilter | NDKFilter[], options?: SubscribeOptions): Promise<ManagedSubscription>;
    private release;
    shutdown(): void;
}
