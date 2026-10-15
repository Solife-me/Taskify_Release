import NDK, { type NDKEvent, type NDKRelay } from "@nostr-dev-kit/ndk";
import { RelayInfoCache } from "./RelayInfoCache.js";
import type { RuntimeProofOfWorkSettings } from "./RuntimeNostrSession.js";
/**
 * Settings for clients that talk to relays outside a `RuntimeNostrSession` (profile and contact
 * updates, one-off lookups). A CLI passes its persistent relay-info cache here so NIP-11 limits
 * and learned proof-of-work targets carry over between runs.
 */
export declare function configureStandaloneRelayAccess(options: {
    relayInfoCache?: RelayInfoCache;
    proofOfWork?: RuntimeProofOfWorkSettings;
    authTimeoutMs?: number;
}): void;
export declare function relayProofOfWorkDifficulty(relays: string[]): Promise<number>;
/** Records a relay's `pow:` rejection so later writes are mined to its target. */
export declare function recordRelayProofOfWorkRejection(relayUrl: string, message: string): number | null;
/** Standalone clients share the same auth policy; anonymous reads use an ephemeral key. */
export declare function configureRelayAccess(ndk: NDK, secretKeyHex?: string): void;
export declare function prepareStandaloneEvent(event: NDKEvent, relays: string[]): Promise<void>;
/**
 * Signs (with proof of work where relays ask for it) and publishes an event from a standalone
 * NDK instance. A relay that refuses it for too little work and names a target gets one
 * re-mined copy, as `RuntimeNostrSession.publishSigned` does.
 */
export declare function publishStandaloneEvent(event: NDKEvent, relays: string[]): Promise<Set<NDKRelay>>;
