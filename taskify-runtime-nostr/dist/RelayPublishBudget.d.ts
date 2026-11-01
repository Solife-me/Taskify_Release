export type RelayRejectionKind = 
/** Slow down: back this relay off and retry later. */
"rate-limited"
/**
 * The relay refuses everything from this network for a while (noteguard: `banned: too many
 * rate-limit violations, try again later`, an hour after 10 refusals in a row).
 */
 | "banned"
/** Will never be accepted by this relay (blocked, restricted, invalid): stop sending it there. */
 | "terminal"
/**
 * The relay already holds something at least as new: a NIP-09 deletion covering the event
 * (strfry: `deleted: user requested deletion`) or a newer version of its address (`replaced:`).
 * It will never take the event and has no need to, so it counts as done with it.
 */
 | "superseded"
/**
 * Not enough NIP-13 proof of work. Resending the same signed event can't succeed, so the
 * relay is held back for it and the caller re-mines a new event (see `parseProofOfWorkRejection`).
 */
 | "pow"
/**
 * Transient (timeouts, `error:`, a false `duplicate:`): retry with the normal backoff.
 * Only a true acceptance confirms delivery (nostr-sync-audit-2026-09-03).
 */
 | "retry";
/** Classifies a relay's `OK false` / publish error message by its NIP-01 prefix. */
export declare function classifyRelayRejection(message: string | null | undefined): RelayRejectionKind;
/**
 * Relays Taskify operates. They get a generous budget, so a large change (a 60-task board
 * template) lands there in seconds, while public relays receive the same events at their
 * conservative pace. Clients read from every relay, so the change shows up quickly either way.
 */
export declare const FIRST_PARTY_RELAYS: readonly string[];
export type RelayPublishBudgetOptions = {
    /** Events a relay may receive back to back. */
    burst?: number;
    /** Minimum delay before one more event is allowed once the burst is spent. */
    refillIntervalMs?: number;
    /** Random delay added once per relay, keeping clients on one public IP from synchronizing. */
    refillJitterMs?: number;
    /** Lease preventing a second serial attempt while the first has not acknowledged (45 s). */
    publishLeaseMs?: number;
    /** First backoff after a rate-limit rejection; doubles on each consecutive one. */
    rateLimitBackoffMs?: number;
    maxBackoffMs?: number;
    /** How long a relay that answers `banned:` is left alone. */
    banBackoffMs?: number;
    /** Relays given the first-party budget instead (defaults to `FIRST_PARTY_RELAYS`). */
    firstPartyRelays?: readonly string[];
    firstPartyBurst?: number;
    firstPartyRefillIntervalMs?: number;
    /** Optional synchronous persistence, used by short-lived clients such as the CLI. */
    stateStore?: RelayPublishBudgetStateStore;
};
type RelayState = {
    tokens: number;
    updatedAt: number;
    blockedUntil: number;
    consecutiveRateLimits: number;
    /** Selected base-plus-jitter interval; absent in snapshots written by older clients. */
    refillIntervalMs?: number;
    /** Only used for one-slot relays; expires so a crashed CLI cannot wedge the shared budget. */
    inFlightUntil?: number;
};
export type RelayPublishBudgetSnapshot = {
    version: 1;
    relays: Record<string, RelayState>;
};
/**
 * Atomically updates a publish-budget snapshot. The callback form lets a file-backed client hold
 * a cross-process lock across read/modify/write, so simultaneous CLI commands share one budget.
 */
export type RelayPublishBudgetStateStore = {
    update(operation: (snapshot: RelayPublishBudgetSnapshot | null) => RelayPublishBudgetSnapshot): RelayPublishBudgetSnapshot;
};
export declare class RelayPublishBudget {
    readonly burst: number;
    readonly refillIntervalMs: number;
    readonly refillJitterMs: number;
    readonly publishLeaseMs: number;
    readonly rateLimitBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly banBackoffMs: number;
    readonly firstPartyBurst: number;
    readonly firstPartyRefillIntervalMs: number;
    private readonly firstPartyRelays;
    private readonly stateStore?;
    private relays;
    constructor(options?: RelayPublishBudgetOptions);
    private snapshot;
    private restore;
    private withPersistentState;
    private isFirstParty;
    private burstFor;
    private newRefillInterval;
    private refillFor;
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
    /** Marks an attempted relay complete. Idempotent; callers use it for every outcome. */
    release(relay: string, now: number): void;
    recordRateLimited(relay: string, now: number): void;
    /** Nothing gets through a `banned:` relay until the ban lifts; then it resumes slowly. */
    recordBanned(relay: string, now: number): void;
    recordAccepted(relay: string, now: number): void;
}
/**
 * Takes a publish slot when one becomes available. Used for retries that must complete in the
 * same short-lived operation, such as re-mining after a `pow:` refusal. Normal queued writes use
 * `take` directly and leave deferral to the durable outbox.
 */
export declare function takeWhenPublishSlotIsAvailable(budget: RelayPublishBudget, relays: string[], options?: {
    maxWaitMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{
    ready: string[];
    deferredUntil: number | null;
}>;
export {};
