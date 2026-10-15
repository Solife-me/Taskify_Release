import NDK, { NDKEvent, NDKRelaySet, type NDKFilter, type NDKRelay, type NDKSigner } from "@nostr-dev-kit/ndk";
import { type EventTemplate, type NostrEvent } from "nostr-tools";
import { type ProofOfWorkHashFactory, type ProofOfWorkOptions } from "./ProofOfWork.js";
import { type RelayAuthOutcome } from "./RelayAuth.js";
import { CursorStore } from "./CursorStore.js";
import { SubscriptionManager, type ManagedSubscription, type SubscribeOptions } from "./SubscriptionManager.js";
import { PublishCoordinator, type PublishOptions, type PublishResult } from "./PublishCoordinator.js";
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
        minPowDifficulty?: number;
    };
    recordProofOfWorkRequirement?: (relayUrl: string, difficulty: number) => void;
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
    markAuthed: (relay: NDKRelay, authEventId?: string) => void;
    markFailed?: (relay: NDKRelay, reason: string, authEventId?: string) => void;
    isAuthed?: (relay: NDKRelay) => boolean;
    outcome?: (relayUrl: string) => RelayAuthOutcome | null;
};
export type RuntimeProofOfWorkSettings = {
    /** Native SHA-256 for mining (e.g. Node's `crypto`); defaults to a portable implementation. */
    hashFactory?: ProofOfWorkHashFactory;
    /** How long one event may be mined before the write fails (default 30 s). */
    timeoutMs?: number;
    /** A floor applied to every write, on top of what relays require (NIP-13 spam signalling). */
    minDifficulty?: number;
    /** Called before mining starts, e.g. to tell a user a slow write is in progress. */
    onMine?: (difficulty: number, relayUrls: string[]) => void;
};
export type RelayRuntimeStatus = {
    url: string;
    connected: boolean;
    status: string;
    /** NIP-11 says the relay requires NIP-42 authentication. */
    authRequired: boolean;
    /** The latest NIP-42 outcome, or null if the relay never challenged this session. */
    auth: RelayAuthOutcome | null;
    /** The NIP-13 difficulty writes to this relay are mined to (advertised or learned). */
    minPowDifficulty: number;
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
    proofOfWork?: RuntimeProofOfWorkSettings;
    /** How long to wait for a relay to accept an AUTH event (default 10 s). */
    authTimeoutMs?: number;
    /**
     * NDK's outbox model (default on) also connects to NDK's own discovery relays. Clients that
     * always name their relays can turn it off so they talk only to relays the user chose.
     */
    enableOutboxModel?: boolean;
};
export declare class RuntimeNostrSession<TWalletClient = unknown> {
    private ndk;
    private initialized;
    private knownRelays;
    private relayRetryTimers;
    private loggedDebugSummary;
    private shuttingDown;
    private readonly workAbort;
    private readonly relayInfoCache;
    private readonly relayHealth;
    private readonly authManager;
    private readonly isDev;
    private readonly proofOfWork;
    private readonly authTimeoutMs?;
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
    private resolveProofOfWorkDifficulty;
    private miningOptions;
    private resolveRelayLimit;
    subscribe(filters: NDKFilter | NDKFilter[], options?: SubscribeOptions): Promise<ManagedSubscription>;
    publish(event: EventTemplate, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult>;
    publishRaw(event: NostrEvent, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult>;
    prepareNDKEvent(event: NDKEvent, signer: NDKSigner, relayUrls: string[]): Promise<void>;
    prepareEvent(template: EventTemplate, secretKey: Uint8Array, relayUrls: string[], options?: ProofOfWorkOptions): Promise<NostrEvent>;
    /**
     * Signs (mining NIP-13 proof of work where relays ask for it) and publishes an event. When a
     * relay refuses it for too little work and names its target, the event is mined again to that
     * target and resent once: replaceable events go to every relay with a newer timestamp so the
     * stronger copy wins everywhere; other events go only to the relays that refused them.
     * `event` is updated in place to the copy that was last published.
     */
    publishSigned(event: NDKEvent, signer: NDKSigner, relayUrls: string[], options?: Omit<PublishOptions, "relayUrls" | "signer">): Promise<PublishResult>;
    createEvent(event?: NostrEvent): NDKEvent;
    fetchEvents(filters: NDKFilter[], relayUrls?: string[], timeoutMs?: number, eoseGraceMs?: number, inactivityMs?: number): Promise<NostrEvent[]>;
    relayStatuses(): RelayRuntimeStatus[];
    private setupRelayHooks;
    private drainOutbox;
    private primeRelayInfo;
    private scheduleRelayConnect;
    private logDebugSummary;
}
