export type RelayLimitation = {
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    default_limit?: number;
    max_message_length?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    min_pow_difficulty?: number;
};
export type RelayInfo = {
    name?: string;
    description?: string;
    pubkey?: string;
    contact?: string;
    supported_nips?: number[];
    software?: string;
    version?: string;
    limitation?: RelayLimitation;
};
export type CachedRelayInfo = {
    fetchedAt: number;
    info: RelayInfo;
    limitation: RelayLimitation;
};
export type RelayLimits = {
    maxLimit: number;
    maxMessageLength: number;
    maxSubscriptions: number;
    authRequired: boolean;
    minPowDifficulty: number;
};
export type RelayInfoStorage = {
    getItem: (key: string) => string | null | undefined;
    setItem: (key: string, value: string) => void;
};
type RelayInfoCacheOptions = {
    ttlMs?: number;
    failureTtlMs?: number;
    storage?: RelayInfoStorage;
    storageKey?: string;
    maxEntries?: number;
    learnedPowTtlMs?: number;
};
export declare function normalizeRelayCacheKey(relayUrl: string): string | null;
export declare function buildNip11Url(relayUrl: string): string | null;
export declare class RelayInfoCache {
    private readonly ttlMs;
    private readonly failureTtlMs;
    private readonly cache;
    private readonly failures;
    private readonly inFlight;
    private readonly storage?;
    private readonly storageKey;
    private readonly maxEntries;
    private readonly learnedPow;
    private readonly learnedPowTtlMs;
    constructor(options?: RelayInfoCacheOptions);
    private isExpired;
    private hasRecentFailure;
    get(relayUrl: string): CachedRelayInfo | null;
    getAgeMs(relayUrl: string): number | null;
    getLimits(relayUrls: string[]): RelayLimits;
    prime(relayUrl: string, fetcher: (nip11Url: string) => Promise<RelayInfo | null>): Promise<CachedRelayInfo | null>;
    /** Records the difficulty a relay demanded in a `pow:` rejection; it never lowers a known requirement. */
    recordProofOfWorkRequirement(relayUrl: string, difficulty: number): void;
    /** The difficulty learned from this relay's rejections, or 0. */
    learnedProofOfWork(relayUrl: string): number;
    needsRefresh(relayUrl: string): boolean;
    private normalizeEntry;
    private restore;
    private restoreRelayInfo;
    private restoreLearnedProofOfWork;
    private persist;
}
export {};
