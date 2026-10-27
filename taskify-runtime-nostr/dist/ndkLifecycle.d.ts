import NDK from "@nostr-dev-kit/ndk";
export declare function installNdkRelayTimerFix(): void;
/** Stops a relay's validation-ratio refresh for good (on shutdown). */
export declare function stopNdkRelayTimers(relay: unknown): void;
/**
 * Closes every relay of an NDK instance for good. Each relay is taken out of its pool, not just
 * disconnected: when more than half of a pool's relays drop within a few seconds, NDK 3.0.3 takes
 * it for a system sleep and reconnects them. NDK has no pool teardown of its own, so the pool's
 * temporary-relay and system-event timers are cleared here too.
 */
export declare function closeNdkPools(ndk: NDK): void;
