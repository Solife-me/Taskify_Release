import { NDKEvent, NDKPrivateKeySigner, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import {
  createNostrOutboxMutation,
  cloneNostrEvent,
  earliestRejectionRelease,
  recordOutboxRelayRejections,
  markOutboxPublishFailure,
  mergeOutboxRelayAcks,
  pendingRelayUrlsForMutation,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "./NostrOutbox.js";
import { applyProofOfWork } from "./ProofOfWork.js";
import { RelayPublishBudget, classifyRelayRejection } from "./RelayPublishBudget.js";
import { normalizeRelayUrls } from "./relayUrls.js";

export type RelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;

export type PublishOptions = {
  relayUrls?: string[];
  signer?: NDKSigner | Uint8Array | string;
  replaceableKey?: string;
  debounceMs?: number;
  returnEvent?: boolean;
  skipIfIdentical?: boolean;
};

type PendingPublish = {
  event: NDKEvent;
  relaySet?: NDKRelaySet;
  outboxId?: string | null;
  resolvers: Array<{ resolve: (value: PublishResult) => void; returnEvent: boolean }>;
  rejecters: Array<(error: unknown) => void>;
  timer: ReturnType<typeof setTimeout> | null;
};

export type PublishResult = number | { createdAt: number; event: NostrEvent };
type PublishEventResult = {
  createdAt: number;
  event: NostrEvent;
  /** Relays that accepted the event. */
  ackedRelays: string[];
  /** Relays that refused it outright: kept queued for them but held back (see relayRejections). */
  refusedRelays: string[];
  /** When the remaining relays should be tried: paced by the relay budget, or backed off after a rate limit. */
  notBefore: number | null;
  /** A relay tried now failed transiently (timeout, `error:`): counts as a failed attempt. */
  transientFailure: boolean;
};

export class NostrWriteQueuedError extends Error {
  readonly code = "WRITE_QUEUED";
  readonly retryable = true;

  constructor() {
    super("No relay acknowledged the write; it remains queued for retry.");
    this.name = "NostrWriteQueuedError";
  }
}

export type PublishCoordinatorOptions = {
  outboxStore?: NostrOutboxStore;
  retryBaseMs?: number;
  retryMaxMs?: number;
  signal?: AbortSignal;
  resolveProofOfWorkDifficulty?: (relayUrls: string[]) => Promise<number>;
  /**
   * Per-relay pacing and rate-limit backoff. Applies when an outbox store is configured (a
   * paced relay must stay queued somewhere); pass `false` to disable.
   */
  publishBudget?: RelayPublishBudget | false;
};

function signerFromInput(value?: NDKSigner | Uint8Array | string): NDKSigner | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return new NDKPrivateKeySigner(value);
  if (value instanceof Uint8Array) {
    const hex = Array.from(value)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return new NDKPrivateKeySigner(hex);
  }
  return value;
}

function hashEventShape(event: NostrEvent): string {
  return JSON.stringify({
    kind: event.kind,
    content: event.content,
    tags: event.tags.filter(tag => tag[0] !== "nonce"),
  });
}

export class PublishCoordinator {
  private replaceableCache = new Map<string, string>();
  private pending = new Map<string, PendingPublish>();
  private readonly debounceDefault = 350;
  private eventCache?: EventCache;
  private resolveRelaySet: RelayResolver;
  private ndk: NDK;
  private readonly outboxStore?: NostrOutboxStore;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly signal?: AbortSignal;
  private readonly resolveProofOfWorkDifficulty?: (relayUrls: string[]) => Promise<number>;
  private activeOutboxIds = new Set<string>();
  private outboxLocks = new Map<string, Promise<unknown>>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private drainPromise: Promise<void> | null = null;
  private readonly publishBudget: RelayPublishBudget | null;

  constructor(ndk: NDK, resolveRelaySet: RelayResolver, cache?: EventCache, options?: PublishCoordinatorOptions) {
    this.ndk = ndk;
    this.resolveRelaySet = resolveRelaySet;
    this.eventCache = cache;
    this.outboxStore = options?.outboxStore;
    this.retryBaseMs = options?.retryBaseMs ?? 2_000;
    this.retryMaxMs = options?.retryMaxMs ?? 5 * 60_000;
    this.resolveProofOfWorkDifficulty = options?.resolveProofOfWorkDifficulty;
    this.signal = options?.signal;
    this.publishBudget = options?.publishBudget === false || !options?.outboxStore
      ? null
      : options?.publishBudget ?? new RelayPublishBudget();
  }

  private buildReplaceableKey(event: NDKEvent): string | null {
    if (!event.isReplaceable()) return null;
    const pubkey = event.pubkey || event.author?.pubkey || "";
    if (!pubkey) return null;
    const dTag = event.tags.find((t: string[]) => t[0] === "d")?.[1] || "";
    if (event.isParamReplaceable()) return `replaceable:${event.kind}:${pubkey}:${dTag}`;
    return `replaceable:${event.kind}:${pubkey}`;
  }

  private async publishNow(event: NDKEvent, relaySet?: NDKRelaySet): Promise<PublishEventResult> {
    const createdAt = event.created_at || Math.floor(Date.now() / 1000);
    const intendedRelays = relaySet ? relayUrlsFromRelaySet(relaySet) : [];
    let targetSet = relaySet;
    let notBefore: number | null = null;
    if (this.publishBudget && intendedRelays.length) {
      const { ready, deferredUntil } = this.publishBudget.take(intendedRelays, Date.now());
      notBefore = deferredUntil;
      if (!ready.length) {
        return { createdAt, event: event.rawEvent() as NostrEvent, ackedRelays: [], refusedRelays: [], notBefore, transientFailure: false };
      }
      if (ready.length < intendedRelays.length) targetSet = await this.resolveRelaySetWithEnsure(ready);
    }

    // NDK reports each relay's rejection as an event emission even when the publish as a whole
    // succeeds, and only throws when too few relays accepted.
    const relayErrors = new Map<string, unknown>();
    const onRelayFailed = (relay: { url?: string }, error: unknown) => {
      const url = normalizeRelayUrls([relay?.url || ""])[0];
      if (url) relayErrors.set(url, error);
    };
    const emitter = event as unknown as {
      on?: (name: string, handler: (...args: any[]) => void) => void;
      off?: (name: string, handler: (...args: any[]) => void) => void;
    };
    emitter.on?.("relay:publish:failed", onRelayFailed);
    let publishedRelays: unknown;
    let thrown: unknown = null;
    try {
      publishedRelays = await event.publish(targetSet);
    } catch (error) {
      thrown = error;
      publishedRelays = (error as { publishedToRelays?: unknown })?.publishedToRelays;
      const errors = (error as { errors?: unknown })?.errors;
      // Without per-relay reasons there is nothing to classify: fail as before.
      if (!(errors instanceof Map)) throw error;
      for (const [relay, relayError] of errors) onRelayFailed(relay as { url?: string }, relayError);
    } finally {
      emitter.off?.("relay:publish:failed", onRelayFailed);
    }

    const now = Date.now();
    const accepted = relayUrlsFromPublishResult(publishedRelays);
    for (const [url, relayError] of relayErrors) {
      if (!accepted.includes(url) && classifyRelayRejection(errorToMessageText(relayError)) === "superseded") {
        accepted.push(url);
      }
    }
    const refused: string[] = [];
    const rateLimited: string[] = [];
    let transientFailure = false;
    for (const [url, relayError] of relayErrors) {
      if (accepted.includes(url)) continue;
      switch (classifyRelayRejection(errorToMessageText(relayError))) {
        case "rate-limited":
          rateLimited.push(url);
          this.publishBudget?.recordRateLimited(url, now);
          break;
        case "terminal":
          refused.push(url);
          break;
        case "superseded":
          break;
        default:
          transientFailure = true;
      }
    }
    for (const url of accepted) this.publishBudget?.recordAccepted(url, now);
    if (rateLimited.length && this.publishBudget) {
      const backoffUntil = this.publishBudget.nextAvailableAt(rateLimited, now);
      if (backoffUntil != null) notBefore = notBefore == null ? backoffUntil : Math.min(notBefore, backoffUntil);
    }

    const ackedRelays = normalizeRelayUrls(accepted);
    const refusedRelays = normalizeRelayUrls(refused);
    // Relays still waiting on their budget or a rate-limit backoff will get the event from the
    // outbox shortly, so the write is queued rather than failed, even if every relay tried now
    // refused it or failed transiently. Fail only when no relay took it and none is pending.
    if (!ackedRelays.length && notBefore == null) {
      const failure = thrown ?? new NostrWriteQueuedError();
      // Carried to the outbox so a refusing relay is held back rather than retried at once.
      if (failure && typeof failure === "object") (failure as { refusedRelays?: string[] }).refusedRelays = refusedRelays;
      throw failure;
    }
    const raw = event.rawEvent() as NostrEvent;
    if (accepted.length) this.eventCache?.add(raw);
    return { createdAt, event: raw, ackedRelays, refusedRelays, notBefore, transientFailure };
  }

  private async resolveRelaySetWithEnsure(relayUrls?: string[]): Promise<NDKRelaySet | undefined> {
    return this.resolveRelaySet(normalizeRelayUrls(relayUrls || []));
  }

  private scheduleDebouncedPublish(key: string, pending: PendingPublish, delayMs: number): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(async () => {
      try {
        const result = await this.publishNowWithOutbox(pending.event, pending.relaySet, pending.outboxId);
        pending.resolvers.forEach(({ resolve, returnEvent }) => resolve(returnEvent ? toPublicEventResult(result) : result.createdAt));
      } catch (error) {
        pending.rejecters.forEach((reject) => reject(error));
      } finally {
        this.pending.delete(key);
      }
    }, delayMs);
  }

  private shouldSkipReplaceable(key: string, event: NostrEvent, skipIfIdentical?: boolean): boolean {
    if (!skipIfIdentical) return false;
    const shape = hashEventShape(event);
    const prev = this.replaceableCache.get(key);
    if (prev === shape) return true;
    this.replaceableCache.set(key, shape);
    return false;
  }

  private outboxMutationId(event: NostrEvent, replaceableKey?: string | null): string {
    return replaceableKey ? `nostr:replaceable:${replaceableKey}` : `nostr:event:${event.id}`;
  }

  private relayUrlsForPublish(relaySet?: NDKRelaySet, relayUrls?: string[]): string[] {
    const fromRelaySet = relaySet ? relayUrlsFromRelaySet(relaySet) : [];
    return normalizeRelayUrls(fromRelaySet.length ? fromRelaySet : relayUrls || []);
  }

  private async outboxHasPending(id: string): Promise<boolean> {
    if (!this.outboxStore) return false;
    const mutation = await this.outboxStore.get(id).catch(() => undefined);
    return !!mutation;
  }

  private withOutboxLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.outboxLocks.get(id) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    this.outboxLocks.set(id, operation);
    return operation.finally(() => {
      if (this.outboxLocks.get(id) === operation) this.outboxLocks.delete(id);
    });
  }

  private async enqueueOutbox(args: {
    event: NostrEvent;
    relayUrls: string[];
    replaceableKey?: string | null;
    nextAttemptAt?: number | null;
  }): Promise<string | null> {
    if (!this.outboxStore) return null;
    const id = this.outboxMutationId(args.event, args.replaceableKey);
    return this.withOutboxLock(id, async () => {
      const existing = await this.outboxStore!.get(id).catch(() => undefined);
      const mutation = createNostrOutboxMutation({
        id,
        event: args.event,
        relayUrls: args.relayUrls,
        replaceableKey: args.replaceableKey,
        existing,
        nextAttemptAt: args.nextAttemptAt ?? null,
      });
      try {
        await this.outboxStore!.put(mutation);
      } catch (error) {
        if (args.replaceableKey) this.replaceableCache.delete(args.replaceableKey);
        throw error;
      }
      if (mutation.nextAttemptAt && mutation.nextAttemptAt > Date.now()) {
        this.scheduleOutboxRetry(id, mutation.nextAttemptAt - Date.now());
      }
      return id;
    });
  }

  private async publishNowWithOutbox(event: NDKEvent, relaySet?: NDKRelaySet, outboxId?: string | null): Promise<PublishEventResult> {
    if (outboxId) this.activeOutboxIds.add(outboxId);
    try {
      const result = await this.publishNow(event, relaySet);
      if (outboxId) {
        await this.markOutboxSuccess(
          outboxId, result.ackedRelays, result.event.id, result.notBefore, result.refusedRelays, result.transientFailure);
      }
      return result;
    } catch (error) {
      if (outboxId) await this.markOutboxFailure(outboxId, error, event.id);
      throw error;
    } finally {
      if (outboxId) this.activeOutboxIds.delete(outboxId);
    }
  }

  private async markOutboxSuccess(
    outboxId: string,
    ackedRelays: string[],
    eventId: string,
    notBefore: number | null = null,
    refusedRelays: string[] = [],
    transientFailure = false,
  ): Promise<void> {
    return this.withOutboxLock(outboxId, () =>
      this.markOutboxSuccessLocked(outboxId, ackedRelays, eventId, notBefore, refusedRelays, transientFailure));
  }

  private async markOutboxSuccessLocked(
    outboxId: string,
    ackedRelays: string[],
    eventId: string,
    notBefore: number | null,
    refusedRelays: string[],
    transientFailure: boolean,
  ): Promise<void> {
    if (!this.outboxStore) return;
    const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
    if (!mutation || mutation.payload.event.id !== eventId) return;
    const next = mergeOutboxRelayAcks(mutation, ackedRelays);
    if (!next) {
      await this.outboxStore.delete(outboxId).catch(() => undefined);
      this.clearOutboxRetry(outboxId);
      return;
    }
    // A resolved publish may still acknowledge only a subset of the intended
    // relays. Treat that as a retryable partial result, not as an invitation to
    // spin the outbox immediately. Without a due time the retry timer used to
    // drain the same row at zero delay indefinitely while a relay was offline.
    //
    // Relays that were only paced or rate limited are due when their budget allows, and
    // waiting on the budget is not a failed attempt, so it doesn't grow the backoff.
    const now = Date.now();
    const pacedOnly = notBefore != null && ackedRelays.length === 0 && refusedRelays.length === 0 && !transientFailure;
    const base = pacedOnly ? { ...mutation, updatedAt: now } : recordOutboxRelayRejections(next, refusedRelays, now);
    let delay = pacedOnly
      ? Math.max(0, notBefore - now)
      : Math.max(this.retryDelayMs(next.attempts), notBefore != null ? notBefore - now : 0);
    delay = this.delayRespectingHeldBackRelays(base, delay, now);
    await this.outboxStore.put({ ...base, nextAttemptAt: now + delay }).catch(() => undefined);
    this.scheduleOutboxRetry(outboxId, delay);
  }

  private async markOutboxFailure(outboxId: string, error: unknown, eventId: string): Promise<void> {
    return this.withOutboxLock(outboxId, () => this.markOutboxFailureLocked(outboxId, error, eventId));
  }

  private async markOutboxFailureLocked(outboxId: string, error: unknown, eventId: string): Promise<void> {
    if (!this.outboxStore) return;
    const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
    if (!mutation || mutation.payload.event.id !== eventId) return;
    const attempts = mutation.attempts + 1;
    const now = Date.now();
    const failed = markOutboxPublishFailure({
      mutation,
      error,
      ackedRelays: relayUrlsFromPublishError(error),
      nextAttemptAt: now + this.retryDelayMs(attempts),
    });
    if (!failed) {
      await this.outboxStore.delete(outboxId).catch(() => undefined);
      this.clearOutboxRetry(outboxId);
      return;
    }
    const refused = (error as { refusedRelays?: string[] })?.refusedRelays ?? [];
    const next = recordOutboxRelayRejections(failed, refused, now);
    const delay = this.delayRespectingHeldBackRelays(next, this.retryDelayMs(attempts), now);
    await this.outboxStore.put({ ...next, nextAttemptAt: now + delay }).catch(() => undefined);
    this.scheduleOutboxRetry(outboxId, delay);
  }

  /** When every pending relay is held back after refusing the event, wait for the first release. */
  private delayRespectingHeldBackRelays(mutation: NostrOutboxMutation, delay: number, now: number): number {
    if (pendingRelayUrlsForMutation(mutation, now).length) return delay;
    const release = earliestRejectionRelease(mutation, now);
    return release == null ? delay : Math.max(delay, release - now);
  }

  private retryDelayMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
  }

  private clearOutboxRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  private scheduleOutboxRetry(id: string, delayMs: number): void {
    if (!this.outboxStore) return;
    this.clearOutboxRetry(id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void this.drainOutbox().catch(() => undefined);
    }, Math.max(0, delayMs));
    this.retryTimers.set(id, timer);
  }

  private isDebouncedOutboxId(id: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.outboxId === id && pending.timer) return true;
    }
    return false;
  }

  async drainOutbox(options?: { force?: boolean; limit?: number }): Promise<void> {
    if (!this.outboxStore) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainOutboxInternal(options).finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainOutboxInternal(options?: { force?: boolean; limit?: number }): Promise<void> {
    if (!this.outboxStore) return;
    const rows = await this.outboxStore.listPending();
    const now = Date.now();
    const limit = options?.limit && Number.isFinite(options.limit) ? Math.max(0, options.limit) : rows.length;
    let processed = 0;

    for (const row of rows.sort((a, b) => a.intentAt - b.intentAt)) {
      if (processed >= limit) break;
      if (this.activeOutboxIds.has(row.id) || this.isDebouncedOutboxId(row.id)) continue;
      if (!options?.force && row.nextAttemptAt && row.nextAttemptAt > now) {
        this.scheduleOutboxRetry(row.id, row.nextAttemptAt - now);
        continue;
      }
      processed += 1;
      await this.retryOutboxMutation(row).catch(() => undefined);
    }
  }

  private async retryOutboxMutation(row: NostrOutboxMutation): Promise<void> {
    const relayUrls = pendingRelayUrlsForMutation(row);
    // Every remaining relay refused this event and isn't due again yet.
    if (!relayUrls.length) {
      const release = earliestRejectionRelease(row);
      if (release != null) this.scheduleOutboxRetry(row.id, release - Date.now());
      return;
    }
    const relaySet = await this.resolveRelaySetWithEnsure(relayUrls);
    const event = new NDKEvent(this.ndk, cloneNostrEvent(row.payload.event));
    await this.publishNowWithOutbox(event, relaySet, row.id);
  }

  shutdown(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  async publish(templateOrEvent: EventTemplate | NDKEvent, options?: PublishOptions): Promise<PublishResult> {
    const relaySet = await this.resolveRelaySetWithEnsure(options?.relayUrls);
    const signer = signerFromInput(options?.signer);
    const relayUrls = this.relayUrlsForPublish(relaySet, options?.relayUrls);
    const proofOfWorkDifficulty = this.resolveProofOfWorkDifficulty
      ? await this.resolveProofOfWorkDifficulty(relayUrls)
      : 0;

    const event =
      templateOrEvent instanceof NDKEvent
        ? templateOrEvent
        : new NDKEvent(this.ndk, {
            kind: templateOrEvent.kind,
            content: templateOrEvent.content || "",
            tags: templateOrEvent.tags || [],
            created_at: templateOrEvent.created_at || Math.floor(Date.now() / 1000),
          });

    if (!event.created_at) event.created_at = Math.floor(Date.now() / 1000);
    if (proofOfWorkDifficulty > 0) {
      await applyProofOfWork(event, signer, proofOfWorkDifficulty, { signal: this.signal });
    } else if (!event.sig) {
      await event.sign(signer);
    }

    const raw = event.rawEvent() as NostrEvent;
    const replaceableKey =
      options?.replaceableKey || this.buildReplaceableKey(event) || (event.isReplaceable() ? event.deduplicationKey() : null);
    const outboxId = this.outboxMutationId(raw, replaceableKey);
    const hasPendingOutbox = await this.outboxHasPending(outboxId);

    if (!hasPendingOutbox && replaceableKey && this.shouldSkipReplaceable(replaceableKey, raw, options?.skipIfIdentical !== false)) {
      return options?.returnEvent ? { createdAt: raw.created_at, event: raw } : raw.created_at;
    }

    if (replaceableKey) {
      const existing = this.pending.get(replaceableKey);
      const delay = options?.debounceMs ?? this.debounceDefault;
      const queuedOutboxId = await this.enqueueOutbox({
        event: raw,
        relayUrls,
        replaceableKey,
        nextAttemptAt: Date.now() + delay,
      });
      if (existing) {
        existing.event = event;
        existing.relaySet = relaySet;
        existing.outboxId = queuedOutboxId;
        this.scheduleDebouncedPublish(replaceableKey, existing, delay);
        return new Promise<PublishResult>((resolve, reject) => {
          existing.resolvers.push({ resolve, returnEvent: !!options?.returnEvent });
          existing.rejecters.push(reject);
        });
      }
      const pending: PendingPublish = { event, relaySet, outboxId: queuedOutboxId, resolvers: [], rejecters: [], timer: null };
      this.pending.set(replaceableKey, pending);
      this.scheduleDebouncedPublish(replaceableKey, pending, delay);
      return new Promise<PublishResult>((resolve, reject) => {
        pending.resolvers.push({ resolve, returnEvent: !!options?.returnEvent });
        pending.rejecters.push(reject);
      });
    }

    const queuedOutboxId = await this.enqueueOutbox({ event: raw, relayUrls, replaceableKey });
    const result = await this.publishNowWithOutbox(event, relaySet, queuedOutboxId);
    return options?.returnEvent ? toPublicEventResult(result) : result.createdAt;
  }

  async publishRaw(event: NostrEvent, options?: PublishOptions): Promise<PublishResult> {
    const ndkEvent = new NDKEvent(this.ndk, event);
    return this.publish(ndkEvent, options);
  }
}

function toPublicEventResult(result: PublishEventResult): { createdAt: number; event: NostrEvent } {
  return { createdAt: result.createdAt, event: result.event };
}

function relayUrlsFromRelaySet(relaySet: NDKRelaySet): string[] {
  const relayUrls = (relaySet as unknown as { relayUrls?: string[] }).relayUrls;
  if (Array.isArray(relayUrls)) return normalizeRelayUrls(relayUrls);
  const relays = (relaySet as unknown as { relays?: Set<{ url?: string }> }).relays;
  if (relays instanceof Set) {
    return normalizeRelayUrls(Array.from(relays).map((relay) => relay.url || ""));
  }
  return [];
}

function relayUrlsFromPublishResult(value: unknown): string[] {
  if (!(value instanceof Set)) return [];
  return normalizeRelayUrls(Array.from(value).map((relay) => (relay as { url?: string }).url || ""));
}

function relayUrlsFromPublishError(error: unknown): string[] {
  const publishedToRelays = (error as { publishedToRelays?: unknown })?.publishedToRelays;
  if (!(publishedToRelays instanceof Set)) return [];
  return relayUrlsFromPublishResult(publishedToRelays);
}

function errorToMessageText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}
