import type { NDKEvent, NDKSigner } from "@nostr-dev-kit/ndk";
import { type EventTemplate, type NostrEvent } from "nostr-tools";
export declare class NostrProofOfWorkError extends Error {
    constructor(message: string);
}
/**
 * Builds a hasher for one mining run. The serialized event is split around the nonce, so the
 * prefix is hashed once and each attempt only hashes the nonce and the rest of the event.
 * Platforms with a native SHA-256 (Node's `crypto`) can supply a faster factory.
 */
export type ProofOfWorkHashFactory = (prefix: string, suffix: string) => (nonce: string) => Uint8Array;
export type ProofOfWorkOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    hashFactory?: ProofOfWorkHashFactory;
};
/** NIP-13 difficulties above this would take hours on a client; relays asking for more are refused. */
export declare const MAX_PROOF_OF_WORK_DIFFICULTY = 32;
export declare function countLeadingZeroBits(hex: string): number;
/** The difficulty an event's nonce tag commits to (NIP-13), or 0 without one. */
export declare function committedProofOfWorkDifficulty(tags: string[][]): number;
/**
 * Reads the difficulty a relay asked for from its `OK false "pow: …"` message, e.g. khatru's
 * "pow: difficulty 8 is less than 20". Returns null when the message names no target.
 */
export declare function parseProofOfWorkRejection(message: string | null | undefined): number | null;
/** Mine before finalizeEvent, and before retaining any references to the event ID. */
export declare function mineEventTemplate(template: EventTemplate, secretKey: Uint8Array, difficulty: number, options?: ProofOfWorkOptions): Promise<EventTemplate>;
/** Mines for a public key whose secret is held elsewhere (an extension or a remote signer). */
export declare function mineEventTemplateFor(template: EventTemplate, pubkey: string, difficulty: number, options?: ProofOfWorkOptions): Promise<EventTemplate>;
export type EventSigner = {
    pubkey: string;
    sign: (template: EventTemplate) => Promise<NostrEvent>;
    /** Sender-encrypted recovery material for one-time signing keys. */
    sealedKey?: string;
};
export declare function localEventSigner(secretKey: Uint8Array): EventSigner;
export declare function satisfiesProofOfWork(event: NostrEvent, difficulty: number): boolean;
/** Derives a second signed event with the same author, timestamp and payload. */
export declare function signProofOfWorkVariant(event: NostrEvent, difficulty: number, signer: EventSigner, options?: ProofOfWorkOptions): Promise<NostrEvent>;
/** Signed events are immutable: callers must prepare proof of work before signing. */
export declare function applyProofOfWork(event: NDKEvent, signer: NDKSigner | undefined, difficulty: number, options?: ProofOfWorkOptions): Promise<void>;
