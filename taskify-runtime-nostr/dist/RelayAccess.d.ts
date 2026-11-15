import NDK, { NDKEvent, type NDKRelay } from "@nostr-dev-kit/ndk";
import { type NostrEvent } from "nostr-tools";
import { RelayInfoCache } from "./RelayInfoCache.js";
import { type EventSigner } from "./ProofOfWork.js";
import type { RuntimeProofOfWorkSettings } from "./RuntimeNostrSession.js";
import { type RelayPublishBudget } from "./RelayPublishBudget.js";
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
/** Relay-specific delivery for one-shot clients, where there is no durable publisher. */
export declare function publishWithRelayProofOfWork(original: NostrEvent, relays: string[], signer: EventSigner, submit: (event: NostrEvent, relays: string[]) => Promise<{
    accepted: string[];
    rejections: Map<string, string>;
}>, settings?: RuntimeProofOfWorkSettings): Promise<void>;
/** Signs the original in place and uses relay-specific proof for one-off writes. */
export declare function publishStandaloneEvent(event: NDKEvent, relays: string[], publishBudget?: RelayPublishBudget): Promise<Set<NDKRelay>>;
