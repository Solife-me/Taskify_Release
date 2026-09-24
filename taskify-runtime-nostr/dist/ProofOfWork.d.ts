import type { NDKEvent, NDKSigner } from "@nostr-dev-kit/ndk";
import { type EventTemplate } from "nostr-tools";
export declare class NostrProofOfWorkError extends Error {
    constructor(message: string);
}
export type ProofOfWorkOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};
export declare function countLeadingZeroBits(hex: string): number;
/** Mine before finalizeEvent, and before retaining any references to the event ID. */
export declare function mineEventTemplate(template: EventTemplate, secretKey: Uint8Array, difficulty: number, options?: ProofOfWorkOptions): Promise<EventTemplate>;
/** Signed events are immutable: callers must prepare proof of work before signing. */
export declare function applyProofOfWork(event: NDKEvent, signer: NDKSigner | undefined, difficulty: number, options?: ProofOfWorkOptions): Promise<void>;
