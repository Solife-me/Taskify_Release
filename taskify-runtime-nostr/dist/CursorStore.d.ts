import type { NDKFilter } from "@nostr-dev-kit/ndk";
export declare class CursorStore {
    private lastSeen;
    private keyForParts;
    keyFor(filter: NDKFilter): string;
    private scopedKey;
    getSince(filter: NDKFilter, relayUrls?: string[]): number | undefined;
    update(filter: NDKFilter, createdAt?: number, relayUrls?: string[]): void;
    updateMany(filters: NDKFilter[], createdAt?: number, relayUrls?: string[]): void;
}
