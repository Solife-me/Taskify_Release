// Per-relay publish pacing. Relays rarely advertise throughput (NIP-11 has no field for it) and
// public ones throttle or ban per IP, so a client should stay under a conservative rate up
// front instead of discovering the limit by being rejected. Each relay gets a token bucket
// (a burst, then a steady refill) plus exponential backoff after a `rate-limited` rejection.

export type RelayRejectionKind =
  /** Slow down: back this relay off and retry later. */
  | "rate-limited"
  /**
   * The relay refuses everything from this network for a while (noteguard: `banned: too many
   * rate-limit violations, try again later`, an hour after 10 refusals in a row).
   */
  | "banned"
  /** Will never be accepted by this relay (blocked, restricted, invalid): stop sending it there. */
  | "terminal"
  /**
   * The relay already holds something at least as new: a NIP-09 deletion covering the event
   * (strfry: `deleted: user requested deletion`) or a newer version of its address (`replaced:`).
   * It will never take the event and has no need to, so it counts as done with it.
   */
  | "superseded"
  /**
   * Not enough NIP-13 proof of work. Resending the same signed event can't succeed, so the
   * relay is held back for it and the caller re-mines a new event (see `parseProofOfWorkRejection`).
   */
  | "pow"
  /**
   * Transient (timeouts, `error:`, a false `duplicate:`): retry with the normal backoff.
   * Only a true acceptance confirms delivery (nostr-sync-audit-2026-09-03).
   */
  | "retry";

/** Classifies a relay's `OK false` / publish error message by its NIP-01 prefix. */
export function classifyRelayRejection(message: string | null | undefined): RelayRejectionKind {
  const text = (message || "").trim().toLowerCase();
  // noteguard's documented message is "rate-limit: …" rather than NIP-01's "rate-limited:".
  if (text.startsWith("rate-limited:") || text.startsWith("rate-limit:")) return "rate-limited";
  if (text.startsWith("banned:")) return "banned";
  if (text.startsWith("blocked:") || text.startsWith("restricted:") || text.startsWith("invalid:")) return "terminal";
  if (text.startsWith("deleted:") || text.startsWith("replaced:")) return "superseded";
  if (text.startsWith("pow:")) return "pow";
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
  /** Minimum delay before one more event is allowed once the burst is spent. */
  refillIntervalMs?: number;
  /** Random delay added once per relay, keeping clients on one public IP from synchronizing. */
  refillJitterMs?: number;
  /** Lease preventing a second serial attempt while the first has not acknowledged (45 s). */
  publishLeaseMs?: number;
  /** First backoff after a rate-limit rejection; doubles on each consecutive one. */
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a relay that answers `banned:` is left alone. */
  banBackoffMs?: number;
  /** Relays given the first-party budget instead (defaults to `FIRST_PARTY_RELAYS`). */
  firstPartyRelays?: readonly string[];
  firstPartyBurst?: number;
  firstPartyRefillIntervalMs?: number;
  /** Optional synchronous persistence, used by short-lived clients such as the CLI. */
  stateStore?: RelayPublishBudgetStateStore;
};

type RelayState = {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  consecutiveRateLimits: number;
  /** Selected base-plus-jitter interval; absent in snapshots written by older clients. */
  refillIntervalMs?: number;
  /** Only used for one-slot relays; expires so a crashed CLI cannot wedge the shared budget. */
  inFlightUntil?: number;
};

export type RelayPublishBudgetSnapshot = {
  version: 1;
  relays: Record<string, RelayState>;
};

/**
 * Atomically updates a publish-budget snapshot. The callback form lets a file-backed client hold
 * a cross-process lock across read/modify/write, so simultaneous CLI commands share one budget.
 */
export type RelayPublishBudgetStateStore = {
  update(operation: (snapshot: RelayPublishBudgetSnapshot | null) => RelayPublishBudgetSnapshot): RelayPublishBudgetSnapshot;
};

export class RelayPublishBudget {
  // A public relay gets one event immediately, then one every 10-12 s. A one-slot lease keeps a
  // slow acknowledgement from overlapping the next publish; it expires after 45 s so a crashed
  // CLI cannot wedge the shared budget. Per-relay jitter keeps clients behind one NAT from
  // publishing in lockstep. This is deliberately below relay.damus.io's example limit of 8 posts/
  // minute per IP, whose remaining shared-IP budget a client cannot observe. First-party relays
  // still get 100, then 10 events/s.
  readonly burst: number;
  readonly refillIntervalMs: number;
  readonly refillJitterMs: number;
  readonly publishLeaseMs: number;
  readonly rateLimitBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly banBackoffMs: number;
  readonly firstPartyBurst: number;
  readonly firstPartyRefillIntervalMs: number;
  private readonly firstPartyRelays: Set<string>;
  private readonly stateStore?: RelayPublishBudgetStateStore;
  private relays = new Map<string, RelayState>();

  constructor(options: RelayPublishBudgetOptions = {}) {
    this.burst = Math.max(1, options.burst ?? 1);
    this.refillIntervalMs = Math.max(1, options.refillIntervalMs ?? 10_000);
    this.refillJitterMs = Math.max(0, options.refillJitterMs ?? 2_000);
    this.publishLeaseMs = Math.max(1, options.publishLeaseMs ?? 45_000);
    this.rateLimitBackoffMs = Math.max(1, options.rateLimitBackoffMs ?? 20_000);
    this.maxBackoffMs = Math.max(this.rateLimitBackoffMs, options.maxBackoffMs ?? 10 * 60_000);
    this.banBackoffMs = Math.max(1, options.banBackoffMs ?? 30 * 60_000);
    this.firstPartyBurst = Math.max(1, options.firstPartyBurst ?? 100);
    this.firstPartyRefillIntervalMs = Math.max(1, options.firstPartyRefillIntervalMs ?? 100);
    this.stateStore = options.stateStore;
    this.firstPartyRelays = new Set(
      (options.firstPartyRelays ?? FIRST_PARTY_RELAYS).map((relay) => relay.trim().toLowerCase().replace(/\/+$/, "")),
    );
  }

  private snapshot(): RelayPublishBudgetSnapshot {
    return {
      version: 1,
      relays: Object.fromEntries(Array.from(this.relays, ([relay, state]) => [relay, { ...state }])),
    };
  }

  private restore(snapshot: RelayPublishBudgetSnapshot | null): void {
    this.relays.clear();
    if (!snapshot || snapshot.version !== 1 || !snapshot.relays || typeof snapshot.relays !== "object") return;
    for (const [relay, value] of Object.entries(snapshot.relays)) {
      const state = value as Partial<RelayState>;
      if (![state.tokens, state.updatedAt, state.blockedUntil, state.consecutiveRateLimits]
        .every((number) => typeof number === "number" && Number.isFinite(number))) continue;
      this.relays.set(relay, {
        tokens: Math.max(0, state.tokens!),
        updatedAt: state.updatedAt!,
        blockedUntil: Math.max(0, state.blockedUntil!),
        consecutiveRateLimits: Math.max(0, Math.floor(state.consecutiveRateLimits!)),
        refillIntervalMs: typeof state.refillIntervalMs === "number" && Number.isFinite(state.refillIntervalMs)
          ? Math.max(1, state.refillIntervalMs)
          : undefined,
        inFlightUntil: typeof state.inFlightUntil === "number" && Number.isFinite(state.inFlightUntil)
          ? Math.max(0, state.inFlightUntil)
          : undefined,
      });
    }
  }

  private withPersistentState<T>(operation: () => T): T {
    if (!this.stateStore) return operation();
    let result!: T;
    const snapshot = this.stateStore.update((current) => {
      this.restore(current);
      result = operation();
      return this.snapshot();
    });
    this.restore(snapshot);
    return result;
  }

  private isFirstParty(relay: string): boolean {
    return this.firstPartyRelays.has(relay.trim().toLowerCase().replace(/\/+$/, ""));
  }

  private burstFor(relay: string): number {
    return this.isFirstParty(relay) ? this.firstPartyBurst : this.burst;
  }

  private newRefillInterval(relay: string): number {
    if (this.isFirstParty(relay)) return this.firstPartyRefillIntervalMs;
    return this.refillIntervalMs + Math.floor(Math.random() * (this.refillJitterMs + 1));
  }

  private refillFor(relay: string, state: RelayState): number {
    state.refillIntervalMs ??= this.newRefillInterval(relay);
    return state.refillIntervalMs;
  }

  private state(relay: string, now: number): RelayState {
    const burst = this.burstFor(relay);
    let state = this.relays.get(relay);
    if (!state) {
      state = {
        tokens: burst,
        updatedAt: now,
        blockedUntil: 0,
        consecutiveRateLimits: 0,
        refillIntervalMs: this.newRefillInterval(relay),
      };
      this.relays.set(relay, state);
      return state;
    }
    // A persisted older policy may have more public tokens than the current one-token capacity.
    state.tokens = Math.min(burst, state.tokens);
    const refillInterval = this.refillFor(relay, state);
    const refilled = Math.floor((now - state.updatedAt) / refillInterval);
    if (refilled > 0) {
      state.tokens = Math.min(burst, state.tokens + refilled);
      state.updatedAt = state.tokens >= burst ? now : state.updatedAt + refilled * refillInterval;
    }
    return state;
  }

  private availableAt(relay: string, state: RelayState, now: number): number {
    const refillAt = state.tokens > 0 ? state.updatedAt : state.updatedAt + this.refillFor(relay, state);
    const inFlightAt = (state.inFlightUntil ?? 0) > now ? state.inFlightUntil! : 0;
    return Math.max(state.blockedUntil, refillAt, inFlightAt);
  }

  /**
   * Takes one publish slot on each relay that has one. Returns the relays to send to now, and
   * the earliest time a deferred relay will have a slot (null when none were deferred).
   */
  take(relays: string[], now: number): { ready: string[]; deferredUntil: number | null } {
    return this.withPersistentState(() => {
      const ready: string[] = [];
      let deferredUntil: number | null = null;
      for (const relay of relays) {
        const state = this.state(relay, now);
        const inFlight = (state.inFlightUntil ?? 0) > now;
        if (state.blockedUntil <= now && state.tokens > 0 && !inFlight) {
          state.tokens -= 1;
          if (this.burstFor(relay) === 1) state.inFlightUntil = now + this.publishLeaseMs;
          ready.push(relay);
          continue;
        }
        const at = this.availableAt(relay, state, now);
        deferredUntil = deferredUntil == null ? at : Math.min(deferredUntil, at);
      }
      return { ready, deferredUntil };
    });
  }

  /** When a relay could next receive an event, without taking a slot. */
  nextAvailableAt(relays: string[], now: number): number | null {
    return this.withPersistentState(() => {
      let earliest: number | null = null;
      for (const relay of relays) {
        const at = Math.max(now, this.availableAt(relay, this.state(relay, now), now));
        earliest = earliest == null ? at : Math.min(earliest, at);
      }
      return earliest;
    });
  }

  /** Marks an attempted relay complete. Idempotent; callers use it for every outcome. */
  release(relay: string, now: number): void {
    this.withPersistentState(() => {
      const state = this.state(relay, now);
      state.inFlightUntil = undefined;
    });
  }

  recordRateLimited(relay: string, now: number): void {
    this.withPersistentState(() => {
      const state = this.state(relay, now);
      state.consecutiveRateLimits += 1;
      const backoff = Math.min(this.maxBackoffMs, this.rateLimitBackoffMs * 2 ** (state.consecutiveRateLimits - 1));
      state.blockedUntil = Math.max(state.blockedUntil, now + backoff);
      state.inFlightUntil = undefined;
      // After the backoff, allow one event and then the steady rate, not a fresh burst.
      state.tokens = 1;
      state.updatedAt = state.blockedUntil;
    });
  }

  /** Nothing gets through a `banned:` relay until the ban lifts; then it resumes slowly. */
  recordBanned(relay: string, now: number): void {
    this.withPersistentState(() => {
      const state = this.state(relay, now);
      state.consecutiveRateLimits += 1;
      state.blockedUntil = Math.max(state.blockedUntil, now + this.banBackoffMs);
      state.inFlightUntil = undefined;
      state.tokens = 1;
      state.updatedAt = state.blockedUntil;
    });
  }

  recordAccepted(relay: string, now: number): void {
    this.withPersistentState(() => {
      const state = this.state(relay, now);
      state.inFlightUntil = undefined;
      if (state.consecutiveRateLimits > 0) state.consecutiveRateLimits -= 1;
    });
  }
}

/**
 * Takes a publish slot when one becomes available. Used for retries that must complete in the
 * same short-lived operation, such as re-mining after a `pow:` refusal. Normal queued writes use
 * `take` directly and leave deferral to the durable outbox.
 */
export async function takeWhenPublishSlotIsAvailable(
  budget: RelayPublishBudget,
  relays: string[],
  options: {
    maxWaitMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<{ ready: string[]; deferredUntil: number | null }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + Math.max(0, options.maxWaitMs ?? 60_000);
  let deferredUntil: number | null = null;
  while (true) {
    const current = now();
    const selection = budget.take(relays, current);
    deferredUntil = selection.deferredUntil;
    if (selection.ready.length || deferredUntil == null || deferredUntil > deadline) return selection;
    await sleep(Math.max(1, deferredUntil - current));
  }
}
