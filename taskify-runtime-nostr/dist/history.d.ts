import type { NDKFilter } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from 'nostr-tools';
import type { ManagedSubscription, SubscribeOptions } from './SubscriptionManager.js';
type HistorySession = {
    subscribe(filters: NDKFilter[], options: SubscribeOptions): Promise<Pick<ManagedSubscription, 'release' | 'filters'>>;
};
/** Read each relay independently; a timeout is not evidence that history is complete. */
export declare function recoverRelayHistory(session: HistorySession, filter: NDKFilter, relay: string, onEvent: (event: NostrEvent) => Promise<void>, options?: {
    signal?: AbortSignal;
    pageSize?: number;
    maxPageSize?: number;
    timeoutMs?: number;
}): Promise<void>;
export {};
