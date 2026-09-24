export type RelayRejectionKind = 
/** Slow down: back this relay off and retry later. */
"rate-limited"
/** Will never be accepted by this relay (blocked, restricted, invalid): stop sending it there. */
 | "terminal"
/**
 * Transient (timeouts, `error:`, `pow:`, a false `duplicate:`): retry with the normal backoff.
 * Only a true acceptance confirms delivery (nostr-sync-audit-2026-09-03).
 */
 | "retry";
/** Classifies a relay's `OK false` / publish error message by its NIP-01 prefix. */
export declare function classifyRelayRejection(message: string | null | undefined): RelayRejectionKind;
export type RelayPublishBudgetOptions = {
    /** Events a relay may receive back to back. */
    burst?: number;
    /** One more event is allowed per interval once the burst is spent. */
    refillIntervalMs?: number;
    /** First backoff after a rate-limit rejection; doubles on each consecutive one. */
    rateLimitBackoffMs?: number;
    maxBackoffMs?: number;
};
export declare class RelayPublishBudget {
    readonly burst: number;
    readonly refillIntervalMs: number;
    readonly rateLimitBackoffMs: number;
    readonly maxBackoffMs: number;
    private relays;
    constructor(options?: RelayPublishBudgetOptions);
    private state;
    private availableAt;
    /**
     * Takes one publish slot on each relay that has one. Returns the relays to send to now, and
     * the earliest time a deferred relay will have a slot (null when none were deferred).
     */
    take(relays: string[], now: number): {
        ready: string[];
        deferredUntil: number | null;
    };
    /** When a relay could next receive an event, without taking a slot. */
    nextAvailableAt(relays: string[], now: number): number | null;
    recordRateLimited(relay: string, now: number): void;
    recordAccepted(relay: string, now: number): void;
}
