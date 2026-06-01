export type RelayLimitation = {
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    default_limit?: number;
    max_message_length?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
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
    constructor(options?: RelayInfoCacheOptions);
    private isExpired;
    private hasRecentFailure;
    get(relayUrl: string): CachedRelayInfo | null;
    getAgeMs(relayUrl: string): number | null;
    getLimits(relayUrls: string[]): RelayLimits;
    prime(relayUrl: string, fetcher: (nip11Url: string) => Promise<RelayInfo | null>): Promise<CachedRelayInfo | null>;
    needsRefresh(relayUrl: string): boolean;
    private normalizeEntry;
    private restore;
    private persist;
}
export {};
