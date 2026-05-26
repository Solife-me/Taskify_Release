const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const JITTER_RATIO = 0.2;
function jitterDelay(base) {
    const spread = base * JITTER_RATIO;
    return base + Math.round((Math.random() * spread - spread / 2));
}
export class RelayHealthTracker {
    states = new Map();
    pendingTimers = new Map();
    canAttempt(relayUrl) {
        const state = this.states.get(relayUrl);
        if (!state?.nextAllowedAttemptAt)
            return true;
        return state.nextAllowedAttemptAt <= Date.now();
    }
    nextAttemptIn(relayUrl) {
        const state = this.states.get(relayUrl);
        if (!state?.nextAllowedAttemptAt)
            return 0;
        return Math.max(0, state.nextAllowedAttemptAt - Date.now());
    }
    markSuccess(relayUrl) {
        const state = this.states.get(relayUrl) || { consecutiveFailures: 0 };
        state.consecutiveFailures = 0;
        state.lastSuccessAt = Date.now();
        state.nextAllowedAttemptAt = undefined;
        this.states.set(relayUrl, state);
        const timer = this.pendingTimers.get(relayUrl);
        if (timer) {
            clearTimeout(timer);
            this.pendingTimers.delete(relayUrl);
        }
    }
    markFailure(relayUrl, opts = {}) {
        const now = Date.now();
        const state = this.states.get(relayUrl) || { consecutiveFailures: 0 };
        const severityWeight = opts.severity === "low" ? 0.5 : opts.severity === "high" ? 1.5 : 1;
        state.consecutiveFailures = Math.max(0, state.consecutiveFailures) + 1;
        state.lastFailureAt = now;
        const exponent = Math.max(0, state.consecutiveFailures - 1);
        const backoff = BASE_BACKOFF_MS * 2 ** exponent * severityWeight;
        const clamped = Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, backoff));
        state.nextAllowedAttemptAt = now + jitterDelay(clamped);
        this.states.set(relayUrl, state);
    }
    status(relayUrl) {
        return this.states.get(relayUrl) || null;
    }
    onBackoffExpiry(relayUrl, cb) {
        if (this.canAttempt(relayUrl)) {
            cb();
            return;
        }
        if (this.pendingTimers.has(relayUrl))
            return;
        const delay = this.nextAttemptIn(relayUrl);
        const timer = setTimeout(() => {
            this.pendingTimers.delete(relayUrl);
            cb();
        }, delay || BASE_BACKOFF_MS);
        this.pendingTimers.set(relayUrl, timer);
    }
}
