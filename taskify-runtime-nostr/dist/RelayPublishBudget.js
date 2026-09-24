// Per-relay publish pacing. Relays rarely advertise throughput (NIP-11 has no field for it) and
// public ones throttle or ban per IP, so a client should stay under a conservative rate up
// front instead of discovering the limit by being rejected. Each relay gets a token bucket
// (a burst, then a steady refill) plus exponential backoff after a `rate-limited` rejection.
/** Classifies a relay's `OK false` / publish error message by its NIP-01 prefix. */
export function classifyRelayRejection(message) {
    const text = (message || "").trim().toLowerCase();
    // noteguard's documented message is "rate-limit: …" rather than NIP-01's "rate-limited:".
    if (text.startsWith("rate-limited:") || text.startsWith("rate-limit:"))
        return "rate-limited";
    if (text.startsWith("duplicate:"))
        return "delivered";
    if (text.startsWith("blocked:") || text.startsWith("restricted:") || text.startsWith("invalid:"))
        return "terminal";
    return "retry";
}
export class RelayPublishBudget {
    // Defaults match the strictest documented public-relay limit we know of (noteguard's example
    // of 8 events/minute per IP): a burst of 8, then one event every 7.5 s.
    burst;
    refillIntervalMs;
    rateLimitBackoffMs;
    maxBackoffMs;
    relays = new Map();
    constructor(options = {}) {
        this.burst = Math.max(1, options.burst ?? 8);
        this.refillIntervalMs = Math.max(1, options.refillIntervalMs ?? 7_500);
        this.rateLimitBackoffMs = Math.max(1, options.rateLimitBackoffMs ?? 15_000);
        this.maxBackoffMs = Math.max(this.rateLimitBackoffMs, options.maxBackoffMs ?? 10 * 60_000);
    }
    state(relay, now) {
        let state = this.relays.get(relay);
        if (!state) {
            state = { tokens: this.burst, updatedAt: now, blockedUntil: 0, consecutiveRateLimits: 0 };
            this.relays.set(relay, state);
            return state;
        }
        const refilled = Math.floor((now - state.updatedAt) / this.refillIntervalMs);
        if (refilled > 0) {
            state.tokens = Math.min(this.burst, state.tokens + refilled);
            state.updatedAt = state.tokens >= this.burst ? now : state.updatedAt + refilled * this.refillIntervalMs;
        }
        return state;
    }
    availableAt(state) {
        const refillAt = state.tokens > 0 ? state.updatedAt : state.updatedAt + this.refillIntervalMs;
        return Math.max(state.blockedUntil, refillAt);
    }
    /**
     * Takes one publish slot on each relay that has one. Returns the relays to send to now, and
     * the earliest time a deferred relay will have a slot (null when none were deferred).
     */
    take(relays, now) {
        const ready = [];
        let deferredUntil = null;
        for (const relay of relays) {
            const state = this.state(relay, now);
            if (state.blockedUntil <= now && state.tokens > 0) {
                state.tokens -= 1;
                ready.push(relay);
                continue;
            }
            const at = this.availableAt(state);
            deferredUntil = deferredUntil == null ? at : Math.min(deferredUntil, at);
        }
        return { ready, deferredUntil };
    }
    /** When a relay could next receive an event, without taking a slot. */
    nextAvailableAt(relays, now) {
        let earliest = null;
        for (const relay of relays) {
            const at = Math.max(now, this.availableAt(this.state(relay, now)));
            earliest = earliest == null ? at : Math.min(earliest, at);
        }
        return earliest;
    }
    recordRateLimited(relay, now) {
        const state = this.state(relay, now);
        state.consecutiveRateLimits += 1;
        const backoff = Math.min(this.maxBackoffMs, this.rateLimitBackoffMs * 2 ** (state.consecutiveRateLimits - 1));
        state.blockedUntil = Math.max(state.blockedUntil, now + backoff);
        // After the backoff, allow one event and then the steady rate, not a fresh burst.
        state.tokens = 1;
        state.updatedAt = state.blockedUntil;
    }
    recordAccepted(relay, now) {
        const state = this.state(relay, now);
        if (state.consecutiveRateLimits > 0)
            state.consecutiveRateLimits -= 1;
    }
}
