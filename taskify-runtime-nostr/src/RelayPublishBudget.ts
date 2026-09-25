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
   * The relay already holds something at least as new: a NIP-09 deletion covering the event
   * (strfry: `deleted: user requested deletion`) or a newer version of its address (`replaced:`).
   * It will never take the event and has no need to, so it counts as done with it.
   */
  | "superseded"
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
  if (text.startsWith("deleted:") || text.startsWith("replaced:")) return "superseded";
  return "retry";
}

/**
 * Relays Taskify operates. They get a generous budget, so a large change (a 60-task board
 * template) lands there in seconds, while public relays receive the same events at their
 * conservative pace. Clients read from every relay, so the change shows up quickly either way.
 */
export const FIRST_PARTY_RELAYS: readonly string[] = ["wss://relay.solife.me", "wss://push.solife.me"];

export type RelayPublishBudgetOptions = {
  /** Events a relay may receive back to back. */
  burst?: number;
  /** One more event is allowed per interval once the burst is spent. */
  refillIntervalMs?: number;
  /** First backoff after a rate-limit rejection; doubles on each consecutive one. */
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
  /** Relays given the first-party budget instead (defaults to `FIRST_PARTY_RELAYS`). */
  firstPartyRelays?: readonly string[];
  firstPartyBurst?: number;
  firstPartyRefillIntervalMs?: number;
};

type RelayState = {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  consecutiveRateLimits: number;
};

export class RelayPublishBudget {
  // Public-relay defaults match the strictest documented limit we know of (noteguard's example of
  // 8 events/minute per IP): a burst of 8, then one event every 7.5 s. First-party relays get a
  // burst of 100, then 10 events/s.
  readonly burst: number;
  readonly refillIntervalMs: number;
  readonly rateLimitBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly firstPartyBurst: number;
  readonly firstPartyRefillIntervalMs: number;
  private readonly firstPartyRelays: Set<string>;
  private relays = new Map<string, RelayState>();

  constructor(options: RelayPublishBudgetOptions = {}) {
    this.burst = Math.max(1, options.burst ?? 8);
    this.refillIntervalMs = Math.max(1, options.refillIntervalMs ?? 7_500);
    this.rateLimitBackoffMs = Math.max(1, options.rateLimitBackoffMs ?? 15_000);
    this.maxBackoffMs = Math.max(this.rateLimitBackoffMs, options.maxBackoffMs ?? 10 * 60_000);
    this.firstPartyBurst = Math.max(1, options.firstPartyBurst ?? 100);
    this.firstPartyRefillIntervalMs = Math.max(1, options.firstPartyRefillIntervalMs ?? 100);
    this.firstPartyRelays = new Set(
      (options.firstPartyRelays ?? FIRST_PARTY_RELAYS).map((relay) => relay.trim().toLowerCase().replace(/\/+$/, "")),
    );
  }

  private isFirstParty(relay: string): boolean {
    return this.firstPartyRelays.has(relay.trim().toLowerCase().replace(/\/+$/, ""));
  }

  private burstFor(relay: string): number {
    return this.isFirstParty(relay) ? this.firstPartyBurst : this.burst;
  }

  private refillFor(relay: string): number {
    return this.isFirstParty(relay) ? this.firstPartyRefillIntervalMs : this.refillIntervalMs;
  }

  private state(relay: string, now: number): RelayState {
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

  private availableAt(relay: string, state: RelayState): number {
    const refillAt = state.tokens > 0 ? state.updatedAt : state.updatedAt + this.refillFor(relay);
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
      const at = this.availableAt(relay, state);
      deferredUntil = deferredUntil == null ? at : Math.min(deferredUntil, at);
    }
    return { ready, deferredUntil };
  }

  /** When a relay could next receive an event, without taking a slot. */
  nextAvailableAt(relays: string[], now: number): number | null {
    let earliest: number | null = null;
    for (const relay of relays) {
      const at = Math.max(now, this.availableAt(relay, this.state(relay, now)));
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
