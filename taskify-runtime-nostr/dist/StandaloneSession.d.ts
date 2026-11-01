import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { type NostrEvent } from "nostr-tools";
import type { RelayPublishBudget } from "./RelayPublishBudget.js";
export type StandaloneSessionOptions = {
    relays: string[];
    /** The account that signs writes and answers AUTH; reads without one use an ephemeral key. */
    secretKeyHex?: string;
    /** How long to wait for relays before working with those that connected (default 3 s). */
    connectTimeoutMs?: number;
    /** Optional shared pacing/backoff for writes from short-lived clients. */
    publishBudget?: RelayPublishBudget;
};
/**
 * A short-lived relay connection for one-off reads and writes outside a `RuntimeNostrSession`:
 * profiles, contact lists, bot command lists, inbox relays. It shares the session's AUTH and
 * proof-of-work handling, verifies every event it returns, bounds every wait, and closes
 * completely, so nothing it made keeps a process alive. Prefer `withStandaloneSession`.
 */
export declare class StandaloneNostrSession {
    private readonly ndk;
    readonly relays: string[];
    private readonly publishBudget?;
    private closed;
    private closing;
    private constructor();
    static open(options: StandaloneSessionOptions): Promise<StandaloneNostrSession>;
    private assertOpen;
    /** Events matching `filter` whose signatures verify; whatever arrived by `timeoutMs`. */
    fetchVerified(filter: NDKFilter, options?: {
        timeoutMs?: number;
    }): Promise<NostrEvent[]>;
    /**
     * Signs (with proof of work where relays ask) and publishes, as `publishStandaloneEvent` does.
     * Returns the published event and the relays that took it.
     */
    publish(template: {
        kind: number;
        content: string;
        tags: string[][];
        created_at?: number;
    }): Promise<{
        event: NostrEvent;
        relays: string[];
    }>;
    /** Disconnects every relay and stops everything NDK started. Idempotent. */
    close(): Promise<void>;
}
/** Opens a standalone session, runs `work`, and closes the session however `work` ends. */
export declare function withStandaloneSession<T>(options: StandaloneSessionOptions, work: (session: StandaloneNostrSession) => Promise<T>): Promise<T>;
/**
 * Raw events whose signatures verify. NDK checks every signature on a new connection and then only
 * a sample; standalone reads check all of them, so a relay cannot hand back a forged profile or
 * list. A fresh object is verified because nostr-tools caches a "verified" mark on event objects.
 */
export declare function verifiedRawEvents(events: Iterable<NDKEvent>): NostrEvent[];
