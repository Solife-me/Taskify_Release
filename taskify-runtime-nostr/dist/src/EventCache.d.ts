import type { NostrEvent } from "nostr-tools";
export declare class EventCache {
    private seenIds;
    private maxSize;
    constructor(maxSize?: number);
    has(event: {
        id?: string;
    } | null | undefined): boolean;
    add(event: NostrEvent): void;
}
