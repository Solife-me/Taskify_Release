export type RelayHealthState = {
    consecutiveFailures: number;
    lastFailureAt?: number;
    lastSuccessAt?: number;
    nextAllowedAttemptAt?: number;
};
type FailureOptions = {
    reason?: string;
    severity?: "low" | "normal" | "high";
};
export declare class RelayHealthTracker {
    private readonly states;
    private readonly pendingTimers;
    canAttempt(relayUrl: string): boolean;
    nextAttemptIn(relayUrl: string): number;
    markSuccess(relayUrl: string): void;
    markFailure(relayUrl: string, opts?: FailureOptions): void;
    status(relayUrl: string): RelayHealthState | null;
    onBackoffExpiry(relayUrl: string, cb: () => void): void;
}
export {};
