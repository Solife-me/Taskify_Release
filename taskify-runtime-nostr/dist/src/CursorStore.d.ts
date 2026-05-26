import type { NDKFilter } from "@nostr-dev-kit/ndk";
export declare class CursorStore {
    private lastSeen;
    private keyForParts;
    keyFor(filter: NDKFilter): string;
    getSince(filter: NDKFilter): number | undefined;
    update(filter: NDKFilter, createdAt?: number): void;
    updateMany(filters: NDKFilter[], createdAt?: number): void;
}
