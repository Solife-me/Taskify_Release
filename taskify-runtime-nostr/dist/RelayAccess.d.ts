import NDK, { type NDKEvent } from "@nostr-dev-kit/ndk";
export declare function relayProofOfWorkDifficulty(relays: string[]): Promise<number>;
/** Standalone clients share the same auth policy; anonymous reads use an ephemeral key. */
export declare function configureRelayAccess(ndk: NDK, secretKeyHex?: string): void;
export declare function prepareStandaloneEvent(event: NDKEvent, relays: string[]): Promise<void>;
