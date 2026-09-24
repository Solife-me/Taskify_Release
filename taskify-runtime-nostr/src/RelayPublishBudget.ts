// Per-relay publish pacing. Relays rarely advertise throughput (NIP-11 has no field for it) and
// public ones throttle or ban per IP, so a client should stay under a conservative rate up
// front instead of discovering the limit by being rejected. Each relay gets a token bucket
// (a burst, then a steady refill) plus exponential backoff after a `rate-limited` rejection.

export type RelayRejectionKind =
  /** Slow down: back this relay off and retry later. */
  | "rate-limited"
  /** Will never be accepted by this relay (blocked, restricted, invalid): stop sending it there. */
  | "terminal"
  /**
   * Transient (timeouts, `error:`, `pow:`, a false `duplicate:`): retry with the normal backoff.
   * Only a true acceptance confirms delivery (nostr-sync-audit-2026-09-03).
   */
  | "retry";

/** Classifies a relay's `OK false` / publish error message by its NIP-01 prefix. */
export function classifyRelayRejection(message: string | null | undefined): RelayRejectionKind {
  const text = (message || "").trim().toLowerCase();
  // noteguard's documented message is "rate-limit: …" rather than NIP-01's "rate-limited:".
  if (text.startsWith("rate-limited:") || text.startsWith("rate-limit:")) return "rate-limited";
  if (text.startsWith("blocked:") || text.startsWith("restricted:") || text.startsWith("invalid:")) return "terminal";
  return "retry";
}

export type RelayPublishBudgetOptions = {
  /** Events a relay may receive back to back. */
  burst?: number;
  /** One more event is allowed per interval once the burst is spent. */
  refillIntervalMs?: number;
  /** First backoff after a rate-limit rejection; doubles on each consecutive one. */
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
};

type RelayState = {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  consecutiveRateLimits: number;
};

export class RelayPublishBudget {
  // Defaults match the strictest documented public-relay limit we know of (noteguard's example
  // of 8 events/minute per IP): a burst of 8, then one event every 7.5 s.
  readonly burst: number;
  readonly refillIntervalMs: number;
  readonly rateLimitBackoffMs: number;
  readonly maxBackoffMs: number;
  private relays = new Map<string, RelayState>();

  constructor(options: RelayPublishBudgetOptions = {}) {
    this.burst = Math.max(1, options.burst ?? 8);
    this.refillIntervalMs = Math.max(1, options.refillIntervalMs ?? 7_500);
    this.rateLimitBackoffMs = Math.max(1, options.rateLimitBackoffMs ?? 15_000);
    this.maxBackoffMs = Math.max(this.rateLimitBackoffMs, options.maxBackoffMs ?? 10 * 60_000);
  }

  private state(relay: string, now: number): RelayState {
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

  private availableAt(state: RelayState): number {
    const refillAt = state.tokens > 0 ? state.updatedAt : state.updatedAt + this.refillIntervalMs;
    return Math.max(state.blockedUntil, refillAt);
  }

  /**
   * Takes one publish slot on each relay that has one. Returns the relays to send to now, and
   * the earliest time a deferred relay will have a slot (null when none were deferred).
   */
  take(relays: string[], now: number): { ready: string[]; deferredUntil: number | null } {
    const ready: string[] = [];
    let deferredUntil: number | null = null;
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
  nextAvailableAt(relays: string[], now: number): number | null {
    let earliest: number | null = null;
    for (const relay of relays) {
      const at = Math.max(now, this.availableAt(this.state(relay, now)));
      earliest = earliest == null ? at : Math.min(earliest, at);
    }
    return earliest;
  }

  recordRateLimited(relay: string, now: number): void {
    const state = this.state(relay, now);
    state.consecutiveRateLimits += 1;
    const backoff = Math.min(this.maxBackoffMs, this.rateLimitBackoffMs * 2 ** (state.consecutiveRateLimits - 1));
    state.blockedUntil = Math.max(state.blockedUntil, now + backoff);
    // After the backoff, allow one event and then the steady rate, not a fresh burst.
    state.tokens = 1;
    state.updatedAt = state.blockedUntil;
  }

  recordAccepted(relay: string, now: number): void {
    const state = this.state(relay, now);
    if (state.consecutiveRateLimits > 0) state.consecutiveRateLimits -= 1;
  }
}
