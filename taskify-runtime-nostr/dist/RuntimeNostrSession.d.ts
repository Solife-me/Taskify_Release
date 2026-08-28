import NDK, { NDKEvent, NDKRelaySet, type NDKFilter, type NDKRelay } from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { CursorStore } from "./CursorStore.js";
import { SubscriptionManager, type ManagedSubscription, type SubscribeOptions } from "./SubscriptionManager.js";
import { PublishCoordinator, type PublishResult } from "./PublishCoordinator.js";
import { BoardKeyManager } from "./boardKeys.js";
import { EventCache } from "./EventCache.js";
import type { NostrOutboxStore } from "./NostrOutbox.js";
import type { RelayInfo } from "./RelayInfoCache.js";
export type RelayInfoCacheLike = {
    prime: (relayUrl: string, loader: (nip11Url: string) => Promise<RelayInfo | null>) => Promise<{
        info?: unknown;
    } | null>;
    needsRefresh: (relayUrl: string) => boolean;
    get: (relayUrl: string) => unknown;
    getAgeMs: (relayUrl: string) => number | null;
    getLimits: (relayUrls: string[]) => {
        maxLimit: number;
        authRequired?: boolean;
    };
};
export type RelayHealthLike = {
    canAttempt: (relayUrl: string) => boolean;
    markFailure: (relayUrl: string, meta?: {
        severity?: "low" | "normal" | "high";
        reason?: string;
    }) => void;
    markSuccess: (relayUrl: string) => void;
    onBackoffExpiry: (relayUrl: string, fn: () => void) => void;
    nextAttemptIn: (relayUrl: string) => number;
    status: (relayUrl: string) => {
        consecutiveFailures?: number;
    } | null;
};
export type RelayAuthManagerLike = {
    respond: (relay: NDKRelay, challenge: string) => Promise<unknown>;
    reset: (relayUrl: string) => void;
    markAuthed: (relay: NDKRelay) => void;
};
export type RuntimeNostrSessionDeps<TWalletClient> = {
    relayInfoCache: RelayInfoCacheLike;
    relayHealth: RelayHealthLike;
    createAuthManager: (ndk: NDK) => RelayAuthManagerLike;
    createWalletClient: (args: {
        ndk: NDK;
        publisher: PublishCoordinator;
        subscriptions: SubscriptionManager;
        resolveRelaySet: (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
    }) => TWalletClient;
    outboxStore?: NostrOutboxStore;
    isDev?: boolean;
};
export declare class RuntimeNostrSession<TWalletClient = unknown> {
    private ndk;
    private initialized;
    private knownRelays;
    private relayRetryTimers;
    private loggedDebugSummary;
    private shuttingDown;
    private readonly relayInfoCache;
    private readonly relayHealth;
    private readonly authManager;
    private readonly isDev;
    readonly cache: EventCache;
    readonly cursors: CursorStore;
    readonly subscriptions: SubscriptionManager;
    readonly publisher: PublishCoordinator;
    readonly boardKeys: BoardKeyManager;
    readonly walletClient: TWalletClient;
    constructor(relays: string[], deps: RuntimeNostrSessionDeps<TWalletClient>);
    init(relays: string[]): Promise<this>;
    private connect;
    shutdown(): Promise<void>;
    private buildRelaySet;
    private ensureRelays;
    private fetchRelayInfo;
    private resolveRelayLimit;
    subscribe(filters: NDKFilter | NDKFilter[], options?: SubscribeOptions): Promise<ManagedSubscription>;
    publish(event: EventTemplate, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult>;
    publishRaw(event: NostrEvent, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult>;
    createEvent(event?: NostrEvent): NDKEvent;
    fetchEvents(filters: NDKFilter[], relayUrls?: string[], timeoutMs?: number, eoseGraceMs?: number, inactivityMs?: number): Promise<NostrEvent[]>;
    relayStatuses(): Array<{
        url: string;
        connected: boolean;
        status: string;
    }>;
    private setupRelayHooks;
    private drainOutbox;
    private primeRelayInfo;
    private scheduleRelayConnect;
    private logDebugSummary;
}
