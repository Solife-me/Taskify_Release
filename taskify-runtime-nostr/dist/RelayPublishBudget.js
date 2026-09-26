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
    if (text.startsWith("banned:"))
        return "banned";
    if (text.startsWith("blocked:") || text.startsWith("restricted:") || text.startsWith("invalid:"))
        return "terminal";
    if (text.startsWith("deleted:") || text.startsWith("replaced:"))
        return "superseded";
    return "retry";
}
/**
 * Relays Taskify operates. They get a generous budget, so a large change (a 60-task board
 * template) lands there in seconds, while public relays receive the same events at their
 * conservative pace. Clients read from every relay, so the change shows up quickly either way.
 */
export const FIRST_PARTY_RELAYS = ["wss://relay.solife.me", "wss://push.solife.me"];
export class RelayPublishBudget {
    // Public-relay defaults fit relay.damus.io's noteguard: 8 posts a minute per IP, but its bucket
    // holds 7 after a quiet spell, and it credits elapsed time in whole seconds, so a post earns its
    // token back only after 8 s (at 7.5 s every post drained it until it refused one). So: a burst
    // of 7, then one event every 10 s, and 20 s after a rate limit, which noteguard needs to accept
    // again from empty. It bans an IP for an hour after 10 refusals in a row. First-party relays
    // get a burst of 100, then 10 events/s.
    burst;
    refillIntervalMs;
    rateLimitBackoffMs;
    maxBackoffMs;
    banBackoffMs;
    firstPartyBurst;
    firstPartyRefillIntervalMs;
    firstPartyRelays;
    relays = new Map();
    constructor(options = {}) {
        this.burst = Math.max(1, options.burst ?? 7);
        this.refillIntervalMs = Math.max(1, options.refillIntervalMs ?? 10_000);
        this.rateLimitBackoffMs = Math.max(1, options.rateLimitBackoffMs ?? 20_000);
        this.maxBackoffMs = Math.max(this.rateLimitBackoffMs, options.maxBackoffMs ?? 10 * 60_000);
        this.banBackoffMs = Math.max(1, options.banBackoffMs ?? 30 * 60_000);
        this.firstPartyBurst = Math.max(1, options.firstPartyBurst ?? 100);
        this.firstPartyRefillIntervalMs = Math.max(1, options.firstPartyRefillIntervalMs ?? 100);
        this.firstPartyRelays = new Set((options.firstPartyRelays ?? FIRST_PARTY_RELAYS).map((relay) => relay.trim().toLowerCase().replace(/\/+$/, "")));
    }
    isFirstParty(relay) {
        return this.firstPartyRelays.has(relay.trim().toLowerCase().replace(/\/+$/, ""));
    }
    burstFor(relay) {
        return this.isFirstParty(relay) ? this.firstPartyBurst : this.burst;
    }
    refillFor(relay) {
        return this.isFirstParty(relay) ? this.firstPartyRefillIntervalMs : this.refillIntervalMs;
    }
    state(relay, now) {
        const burst = this.burstFor(relay);
        const refillInterval = this.refillFor(relay);
        let state = this.relays.get(relay);
        if (!state) {
            state = { tokens: burst, updatedAt: now, blockedUntil: 0, consecutiveRateLimits: 0 };
            this.relays.set(relay, state);
            return state;
        }
        const refilled = Math.floor((now - state.updatedAt) / refillInterval);
        if (refilled > 0) {
            state.tokens = Math.min(burst, state.tokens + refilled);
            state.updatedAt = state.tokens >= burst ? now : state.updatedAt + refilled * refillInterval;
        }
        return state;
    }
    availableAt(relay, state) {
        const refillAt = state.tokens > 0 ? state.updatedAt : state.updatedAt + this.refillFor(relay);
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
            const at = this.availableAt(relay, state);
            deferredUntil = deferredUntil == null ? at : Math.min(deferredUntil, at);
        }
        return { ready, deferredUntil };
    }
    /** When a relay could next receive an event, without taking a slot. */
    nextAvailableAt(relays, now) {
        let earliest = null;
        for (const relay of relays) {
            const at = Math.max(now, this.availableAt(relay, this.state(relay, now)));
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
    /** Nothing gets through a `banned:` relay until the ban lifts; then it resumes slowly. */
    recordBanned(relay, now) {
        const state = this.state(relay, now);
        state.consecutiveRateLimits += 1;
        state.blockedUntil = Math.max(state.blockedUntil, now + this.banBackoffMs);
        state.tokens = 1;
        state.updatedAt = state.blockedUntil;
    }
    recordAccepted(relay, now) {
        const state = this.state(relay, now);
        if (state.consecutiveRateLimits > 0)
            state.consecutiveRateLimits -= 1;
    }
}
