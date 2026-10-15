import NDK, { NDKEvent, type NDKRelay } from "@nostr-dev-kit/ndk";
type RelayAuthOptions = {
    loadSecretKeyHex: () => string | null;
    /**
     * Answer challenges with a throwaway key when no account key is available, so relays that
     * gate reads behind NIP-42 still serve signed-out clients. Off by default.
     */
    allowEphemeralKey?: boolean;
};
export type RelayAuthOutcome = {
    state: "authenticated" | "failed" | "no-key";
    at: number;
    reason?: string;
    /** True when the relay was answered with a throwaway key rather than the account's. */
    ephemeral?: boolean;
};
export declare class RelayAuthManager {
    private readonly ndk;
    private readonly authPerConnection;
    private readonly outcomes;
    private readonly loadSecretKeyHex;
    private readonly allowEphemeralKey;
    private ephemeralSigner;
    /** AUTH events signed with the throwaway key, so their outcome can say so. */
    private readonly ephemeralAuthEvents;
    constructor(ndk: NDK, options: RelayAuthOptions);
    private connectionKey;
    private outcomeKey;
    private loadSigner;
    buildAuthEvent(relayUrl: string, challenge: string): Promise<NDKEvent | null>;
    respond(relay: NDKRelay, challenge: string): Promise<NDKEvent | undefined>;
    markAuthed(relay: NDKRelay, authEventId?: string): void;
    /** The relay refused the AUTH event (or never answered it). Its next challenge is answered afresh. */
    markFailed(relay: NDKRelay, reason: string, authEventId?: string): void;
    isAuthed(relay: NDKRelay): boolean;
    /** The latest NIP-42 outcome seen for a relay, or null if it never challenged this client. */
    outcome(relayUrl: string): RelayAuthOutcome | null;
    reset(relayUrl: string): void;
}
export type RelayAuthResponder = {
    respond: (relay: NDKRelay, challenge: string) => Promise<unknown>;
    markAuthed: (relay: NDKRelay, authEventId?: string) => void;
    markFailed?: (relay: NDKRelay, reason: string, authEventId?: string) => void;
    isAuthed?: (relay: NDKRelay) => boolean;
};
/**
 * NIP-42 policy for NDK relays. NDK 3 sends a returned AUTH event itself, but lets a refused or
 * dropped AUTH escape as an unhandled rejection (which ends a Node process) and never resends
 * writes the relay answered with `auth-required:`. This policy sends the AUTH event, waits for the
 * relay's verdict, and then finishes what NDK leaves undone: resend held writes, or fail them.
 */
export declare function createRelayAuthPolicy(responder: RelayAuthResponder, options?: {
    timeoutMs?: number;
}): (relay: NDKRelay, challenge: string) => Promise<boolean | NDKEvent>;
export {};
