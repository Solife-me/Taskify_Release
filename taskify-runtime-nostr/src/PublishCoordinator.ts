import { NDKEvent, NDKPrivateKeySigner, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { getEventHash, type EventTemplate, type NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import {
  createNostrOutboxMutation,
  cloneNostrEvent,
  earliestRejectionRelease,
  recordOutboxRelayRejections,
  markOutboxPublishFailure,
  mergeOutboxRelayAcks,
  narrowRepublishedMutations,
  pendingRelayUrlsForMutation,
  type NostrOutboxMutation,
  type NostrOutboxPublishPayload,
  type NostrOutboxStore,
} from "./NostrOutbox.js";
import { MAX_PROOF_OF_WORK_DIFFICULTY, NostrProofOfWorkError, parseProofOfWorkRejection, satisfiesProofOfWork, signProofOfWorkVariant, type EventSigner, type ProofOfWorkOptions } from "./ProofOfWork.js";
import { FIRST_PARTY_RELAYS, RelayPublishBudget, classifyRelayRejection } from "./RelayPublishBudget.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import { RuntimeSessionClosedError } from "./sessionErrors.js";

export type RelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;

export type PublishOptions = {
  relayUrls?: string[];
  signer?: NDKSigner | Uint8Array | string;
  proofOfWorkSigner?: EventSigner;
  replaceableKey?: string;
  debounceMs?: number;
  returnEvent?: boolean;
  skipIfIdentical?: boolean;
  /** Part of a board republish (see `limitQueuedRepublish`). */
  republish?: boolean;
};

type PendingPublish = {
  event: NDKEvent;
  relaySet?: NDKRelaySet;
  outboxId?: string | null;
  proofOfWorkSigner?: EventSigner;
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
  proofOfWorkRequired?: Map<string, number>;
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
  returnOnFirstAcknowledgement?: boolean;
  recoverProofOfWorkSigner?: (payload: NostrOutboxPublishPayload) => Promise<EventSigner | undefined>;
  knownProofOfWorkDifficulty?: (relayUrl: string) => number;
  resolveProofOfWorkDifficulty?: (relayUrls: string[]) => Promise<number>;
  onMine?: (difficulty: number, relays: string[]) => void;
  /** Mining settings (hasher, timeout) used when a publish needs proof of work. */
  proofOfWork?: Omit<ProofOfWorkOptions, "signal">;
  /** Called when a relay refuses an event for too little proof of work and names its target. */
  onProofOfWorkRequired?: (relayUrl: string, difficulty: number) => void;
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
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly debounceDefault = 350;
  private eventCache?: EventCache;
  private resolveRelaySet: RelayResolver;
  private ndk: NDK;
  private readonly outboxStore?: NostrOutboxStore;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly signal?: AbortSignal;
  private readonly recoverProofOfWorkSigner?: PublishCoordinatorOptions["recoverProofOfWorkSigner"];
  private readonly knownProofOfWorkDifficulty?: PublishCoordinatorOptions["knownProofOfWorkDifficulty"];
  private readonly resolveProofOfWorkDifficulty?: PublishCoordinatorOptions["resolveProofOfWorkDifficulty"];
  private readonly onMine?: PublishCoordinatorOptions["onMine"];
  private readonly returnOnFirstAcknowledgement: boolean;
  private readonly backgroundPublishes = new Set<Promise<PublishEventResult>>();
  private readonly retrySigners = new Map<string, EventSigner>();
  private readonly proofOfWork?: Omit<ProofOfWorkOptions, "signal">;
  private readonly onProofOfWorkRequired?: (relayUrl: string, difficulty: number) => void;
  private activeOutboxIds = new Map<string, symbol>();
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
    this.returnOnFirstAcknowledgement = options?.returnOnFirstAcknowledgement === true;
    this.recoverProofOfWorkSigner = options?.recoverProofOfWorkSigner;
    this.knownProofOfWorkDifficulty = options?.knownProofOfWorkDifficulty;
    this.resolveProofOfWorkDifficulty = options?.resolveProofOfWorkDifficulty;
    this.onMine = options?.onMine;
    this.proofOfWork = options?.proofOfWork;
    this.onProofOfWorkRequired = options?.onProofOfWorkRequired;
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

  private async publishNow(
    event: NDKEvent, relaySet?: NDKRelaySet, acknowledge?: (relay: string) => void,
  ): Promise<PublishEventResult> {
    const createdAt = event.created_at || Math.floor(Date.now() / 1000);
    const intendedRelays = relaySet ? relayUrlsFromRelaySet(relaySet) : [];
    let targetSet = relaySet;
    let notBefore: number | null = null;
    const attemptedRelays: string[] = [];
    if (this.publishBudget && intendedRelays.length) {
      const { ready, deferredUntil } = this.publishBudget.take(intendedRelays, Date.now());
      notBefore = deferredUntil;
      if (!ready.length) {
        return { createdAt, event: event.rawEvent() as NostrEvent, ackedRelays: [], refusedRelays: [], notBefore, transientFailure: false };
      }
      attemptedRelays.push(...ready);
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
    const onRelayPublished = (relay: { url?: string }) => {
      const url = normalizeRelayUrls([relay?.url ?? ""])[0];
      if (url && (!intendedRelays.length || intendedRelays.includes(url))) acknowledge?.(url);
    };
    emitter.on?.("relay:publish:failed", onRelayFailed);
    if (acknowledge) emitter.on?.("relay:published", onRelayPublished);
    let publishedRelays: unknown;
    let thrown: unknown = null;
    try {
      if (this.publishBudget && targetSet && attemptedRelays.length < intendedRelays.length) {
        targetSet = await this.resolveRelaySetWithEnsure(attemptedRelays);
        if (!targetSet) throw new NostrWriteQueuedError();
      }
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
      if (acknowledge) emitter.off?.("relay:published", onRelayPublished);
      const releasedAt = Date.now();
      for (const relay of attemptedRelays) this.publishBudget?.release(relay, releasedAt);
    }

    const now = Date.now();
    const accepted = relayUrlsFromPublishResult(publishedRelays);
    for (const [url, relayError] of relayErrors) {
      if (!accepted.includes(url) && classifyRelayRejection(errorToMessageText(relayError)) === "superseded") {
        accepted.push(url);
      }
    }
    const refused: string[] = [];
    const proofOfWorkRequired = new Map<string, number>();
    const rateLimited: string[] = [];
    let transientFailure = false;
    for (const [url, relayError] of relayErrors) {
      if (accepted.includes(url)) continue;
      switch (classifyRelayRejection(errorToMessageText(relayError))) {
        case "rate-limited":
          rateLimited.push(url);
          this.publishBudget?.recordRateLimited(url, now);
          break;
        case "banned":
          rateLimited.push(url);
          this.publishBudget?.recordBanned(url, now);
          break;
        case "terminal":
          refused.push(url);
          break;
        case "pow": {
          const required = parseProofOfWorkRejection(errorToMessageText(relayError));
          if (required != null && required <= MAX_PROOF_OF_WORK_DIFFICULTY &&
              !satisfiesProofOfWork(event.rawEvent() as NostrEvent, required)) {
            proofOfWorkRequired.set(url, required);
            this.onProofOfWorkRequired?.(url, required);
          } else {
            refused.push(url);
          }
          break;
        }
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
    if (ackedRelays.length) acknowledge?.(ackedRelays[0]);
    const refusedRelays = normalizeRelayUrls(refused);
    // Relays still waiting on their budget or a rate-limit backoff will get the event from the
    // outbox shortly, so the write is queued rather than failed, even if every relay tried now
    // refused it or failed transiently. Fail only when no relay took it and none is pending.
    if (!ackedRelays.length && notBefore == null) {
      const failure = thrown ?? new NostrWriteQueuedError();
      // Carried to the outbox so a refusing relay is held back rather than retried at once.
      if (failure && typeof failure === "object") Object.assign(failure, { refusedRelays, proofOfWorkRequired });
      throw failure;
    }
    const raw = event.rawEvent() as NostrEvent;
    if (accepted.length) this.eventCache?.add(raw);
    return { createdAt, event: raw, ackedRelays, refusedRelays, notBefore, transientFailure, proofOfWorkRequired };
  }

  private async resolveRelaySetWithEnsure(relayUrls?: string[]): Promise<NDKRelaySet | undefined> {
    return this.resolveRelaySet(normalizeRelayUrls(relayUrls || []));
  }

  private scheduleDebouncedPublish(key: string, pending: PendingPublish, delayMs: number): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => void this.firePending(key, pending), delayMs);
  }

  /** Publishes a debounced event now and settles every caller waiting on it. */
  private async firePending(key: string, pending: PendingPublish): Promise<void> {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    try {
      const result = await this.publishForCaller(pending.event, pending.relaySet, pending.outboxId, pending.proofOfWorkSigner);
      pending.resolvers.forEach(({ resolve, returnEvent }) => resolve(returnEvent ? toPublicEventResult(result) : result.createdAt));
    } catch (error) {
      pending.rejecters.forEach((reject) => reject(error));
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
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
    isRepublish?: boolean;
    proofOfWorkSealedKey?: string;
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
        isRepublish: args.isRepublish,
        proofOfWorkSealedKey: args.proofOfWorkSealedKey,
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

  private publishForCaller(
    event: NDKEvent, relaySet?: NDKRelaySet, outboxId?: string | null, signer?: EventSigner,
  ): Promise<PublishEventResult> {
    if (!outboxId || !this.outboxStore || !this.returnOnFirstAcknowledgement) {
      return this.publishNowWithOutbox(event, relaySet, outboxId, signer);
    }
    const plain = event.rawEvent() as NostrEvent;
    let acknowledge!: (result: PublishEventResult) => void;
    const first = new Promise<PublishEventResult>(resolve => { acknowledge = resolve; });
    let sawAcknowledgement = false;
    const publish = this.publishNowWithOutbox(event, relaySet, outboxId, signer, relay => {
      if (sawAcknowledgement) return;
      sawAcknowledgement = true;
      void this.persistPartialAcknowledgements(outboxId, plain.id, [relay]).then(() => {
        acknowledge({
          createdAt: plain.created_at, event: plain, ackedRelays: [relay],
          refusedRelays: [], notBefore: null, transientFailure: false,
        });
      }).catch(() => undefined);
    });
    this.backgroundPublishes.add(publish);
    void publish.finally(() => this.backgroundPublishes.delete(publish)).catch(() => undefined);
    return Promise.race([publish, first]);
  }

  private async persistPartialAcknowledgements(id: string, eventId: string, relays: string[]): Promise<void> {
    await this.withOutboxLock(id, async () => {
      const current = await this.outboxStore!.get(id);
      if (!current || current.payload.event.id !== eventId) return;
      const next = mergeOutboxRelayAcks(current, relays);
      if (next) await this.outboxStore!.put({ ...next, attempts: current.attempts, nextAttemptAt: current.nextAttemptAt });
    });
  }

  private async publishNowWithOutbox(
    event: NDKEvent, relaySet?: NDKRelaySet, outboxId?: string | null, signer?: EventSigner,
    acknowledge?: (relay: string) => void,
  ): Promise<PublishEventResult> {
    const write = Symbol();
    if (outboxId) {
      this.activeOutboxIds.set(outboxId, write);
      if (signer) {
        this.retrySigners.delete(outboxId);
        this.retrySigners.set(outboxId, signer);
        if (this.retrySigners.size > 256) this.retrySigners.delete(this.retrySigners.keys().next().value!);
      }
    }
    try {
      const result = await this.publishByRelay(event, relaySet, outboxId, signer, acknowledge);
      if (outboxId) {
        await this.markOutboxSuccess(
          outboxId, result.ackedRelays, result.event.id, result.notBefore, result.refusedRelays, result.transientFailure);
      }
      return result;
    } catch (error) {
      if (outboxId) await this.markOutboxFailure(outboxId, error, event.id);
      throw error;
    } finally {
      if (outboxId && this.activeOutboxIds.get(outboxId) === write) this.activeOutboxIds.delete(outboxId);
    }
  }

  private async publishByRelay(
    event: NDKEvent, relaySet?: NDKRelaySet, outboxId?: string | null, signer?: EventSigner,
    acknowledge?: (relay: string) => void,
  ): Promise<PublishEventResult> {
    const relays = this.relayUrlsForPublish(relaySet);
    if (!relays.length || (!this.knownProofOfWorkDifficulty && !this.resolveProofOfWorkDifficulty)) {
      return this.publishNow(event, relaySet, acknowledge);
    }
    const plain = event.rawEvent() as NostrEvent;
    const row = outboxId ? await this.outboxStore?.get(outboxId) : undefined;
    if (outboxId && row?.payload.event.id !== plain.id) throw new NostrWriteQueuedError();
    const targets = row ? relays.filter(relay => row.pendingRelays.includes(relay)) : relays;
    const requirements = new Map(targets.map(relay => [relay, this.knownProofOfWorkDifficulty?.(relay) ?? 0]));
    const ordinary = targets.filter(relay => !requirements.get(relay));
    const aggregate: PublishEventResult = {
      createdAt: plain.created_at, event: plain, ackedRelays: [], refusedRelays: [],
      notBefore: null, transientFailure: false,
    };
    let failure: unknown;
    const submit = async (wireEvent: NDKEvent, urls: string[], set?: NDKRelaySet) => {
      try {
        const selected = set ?? await this.resolveRelaySetWithEnsure(urls);
        if (!selected) throw new NostrWriteQueuedError();
        const result = await this.publishNow(wireEvent, selected, acknowledge);
        aggregate.ackedRelays.push(...result.ackedRelays);
        aggregate.refusedRelays.push(...result.refusedRelays);
        if (result.notBefore != null) aggregate.notBefore = Math.min(aggregate.notBefore ?? Infinity, result.notBefore);
        aggregate.transientFailure ||= result.transientFailure;
        return result.proofOfWorkRequired;
      } catch (error) {
        failure = error;
        aggregate.ackedRelays.push(...relayUrlsFromPublishError(error));
        aggregate.refusedRelays.push(...((error as { refusedRelays?: string[] })?.refusedRelays ?? []));
        return (error as { proofOfWorkRequired?: Map<string, number> })?.proofOfWorkRequired;
      }
    };

    if (ordinary.length) {
      const refused = await submit(event, ordinary, ordinary.length === relays.length ? relaySet : undefined);
      for (const [relay, difficulty] of refused ?? []) requirements.set(relay, difficulty);
    }
    // With a cold cache, ordinary delivery has already started. Only destinations that still
    // need a copy can affect this event's proof-of-work requirements.
    await Promise.all(targets.filter(relay => !requirements.get(relay) && !aggregate.ackedRelays.includes(relay))
      .map(async relay => {
        const difficulty = await this.resolveProofOfWorkDifficulty?.([relay]).catch(() => 0);
        if (difficulty) requirements.set(relay, difficulty);
      }));

    let variant = row?.payload.proofOfWorkEvent;
    let strict = targets.filter(relay => (requirements.get(relay) ?? 0) > 0 && !aggregate.ackedRelays.includes(relay));
    for (let attempt = 0; strict.length && attempt < 2; attempt += 1) {
      const difficulty = Math.max(...strict.map(relay => requirements.get(relay)!));
      try {
        if (satisfiesProofOfWork(plain, difficulty)) {
          variant = plain;
        } else if (!variant || !satisfiesProofOfWork(variant, difficulty)) {
          if (signer?.pubkey !== plain.pubkey) signer = row ? await this.recoverProofOfWorkSigner?.(row.payload) : undefined;
          if (!signer) throw new NostrProofOfWorkError("The original signer is required to prepare this relay's proof of work.");
          this.onMine?.(difficulty, strict);
          variant = await signProofOfWorkVariant(plain, difficulty, signer, { ...this.proofOfWork, signal: this.signal });
        }
        if (outboxId && this.outboxStore) {
          const wireEvent = variant;
          const stillCurrent = await this.withOutboxLock(outboxId, async () => {
            const current = await this.outboxStore!.get(outboxId);
            if (!current || current.payload.event.id !== plain.id) return false;
            const next = mergeOutboxRelayAcks(current, aggregate.ackedRelays);
            if (!next) return false;
            await this.outboxStore!.put({
              ...next, attempts: current.attempts, nextAttemptAt: current.nextAttemptAt,
              payload: { ...next.payload, proofOfWorkEvent: wireEvent },
            });
            return true;
          });
          if (!stillCurrent) break;
        }
        const refused = await submit(new NDKEvent(this.ndk, cloneNostrEvent(variant)), strict);
        strict = strict.filter(relay => refused?.has(relay) && !aggregate.ackedRelays.includes(relay));
        for (const relay of strict) requirements.set(relay, refused!.get(relay)!);
      } catch (error) {
        failure = error;
        aggregate.transientFailure = true;
        break;
      }
    }
    aggregate.refusedRelays = aggregate.refusedRelays.filter(relay => !aggregate.ackedRelays.includes(relay));
    if (!aggregate.ackedRelays.length && aggregate.notBefore == null) {
      const error = failure ?? new NostrWriteQueuedError();
      if (error && typeof error === "object") Object.assign(error, { refusedRelays: aggregate.refusedRelays });
      throw error;
    }
    return aggregate;
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
      this.retrySigners.delete(outboxId);
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
      this.retrySigners.delete(outboxId);
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
    if (!this.outboxStore || this.closed) return;
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
    // A closed publisher leaves the outbox for the next session.
    if (this.closed) return;
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
    await this.publishNowWithOutbox(event, relaySet, row.id, this.retrySigners.get(row.id));
  }

  /**
   * Stops sending a board's queued republish to public relays; it still reaches `keptRelayUrls`
   * (Taskify's own relays by default). Returns how many queued rows changed.
   */
  async limitQueuedRepublish(boardTag: string, keptRelayUrls: readonly string[] = FIRST_PARTY_RELAYS): Promise<number> {
    if (!this.outboxStore) return 0;
    const rows = await this.outboxStore.listPending();
    const { updated, completedIds } = narrowRepublishedMutations(rows, { boardTag, keptRelayUrls });
    let changed = 0;
    const apply = async (id: string, eventId: string, write: () => Promise<void>) => {
      if (this.activeOutboxIds.has(id)) return;
      await this.withOutboxLock(id, async () => {
        const current = await this.outboxStore!.get(id).catch(() => undefined);
        // Skip a row replaced by a newer event since it was read.
        if (!current || current.payload.event.id !== eventId) return;
        await write();
        changed += 1;
      });
    };
    for (const row of updated) {
      await apply(row.id, row.payload.event.id, () => this.outboxStore!.put(row));
    }
    const completed = new Map(rows.map((row) => [row.id, row]));
    for (const id of completedIds) {
      const row = completed.get(id);
      if (!row) continue;
      await apply(id, row.payload.event.id, async () => {
        await this.outboxStore!.delete(id);
        this.clearOutboxRetry(id);
        this.retrySigners.delete(id);
      });
    }
    return changed;
  }

  /**
   * Terminal. Debounced publishes still waiting are sent now, so their callers get the real
   * result rather than a promise that never settles; retries stop; later publishes fail with
   * `RuntimeSessionClosedError`. Idempotent: later calls wait for the first.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    const waiting = Array.from(this.pending.entries());
    this.shutdownPromise = Promise.all(waiting.map(([key, pending]) => this.firePending(key, pending))).then(async () => {
      await Promise.allSettled(this.backgroundPublishes);
      this.pending.clear();
      this.retrySigners.clear();
    });
    return this.shutdownPromise;
  }

  async publish(templateOrEvent: EventTemplate | NDKEvent, options?: PublishOptions): Promise<PublishResult> {
    if (this.closed) throw new RuntimeSessionClosedError("publish");
    const relaySet = await this.resolveRelaySetWithEnsure(options?.relayUrls);
    const signer = signerFromInput(options?.signer) ?? (templateOrEvent instanceof NDKEvent && templateOrEvent.sig ? undefined : this.ndk.signer);
    const relayUrls = this.relayUrlsForPublish(relaySet, options?.relayUrls);
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
    if (!event.sig) await event.sign(signer);
    const raw = event.rawEvent() as NostrEvent;
    const proofOfWorkSigner: EventSigner | undefined = options?.proofOfWorkSigner ?? (signer && (await signer.user()).pubkey === raw.pubkey ? {
      pubkey: raw.pubkey,
      sign: async (template: EventTemplate) => {
        const id = getEventHash({ ...template, pubkey: raw.pubkey });
        const sig = await signer.sign({ ...template, pubkey: raw.pubkey, id });
        return { ...template, pubkey: raw.pubkey, id, sig };
      },
    } : undefined);
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
        isRepublish: options?.republish,
        proofOfWorkSealedKey: proofOfWorkSigner?.sealedKey,
      });
      if (existing) {
        existing.event = event;
        existing.relaySet = relaySet;
        existing.outboxId = queuedOutboxId;
        existing.proofOfWorkSigner = proofOfWorkSigner;
        this.scheduleDebouncedPublish(replaceableKey, existing, delay);
        return new Promise<PublishResult>((resolve, reject) => {
          existing.resolvers.push({ resolve, returnEvent: !!options?.returnEvent });
          existing.rejecters.push(reject);
        });
      }
      const pending: PendingPublish = { event, relaySet, outboxId: queuedOutboxId, proofOfWorkSigner, resolvers: [], rejecters: [], timer: null };
      this.pending.set(replaceableKey, pending);
      this.scheduleDebouncedPublish(replaceableKey, pending, delay);
      return new Promise<PublishResult>((resolve, reject) => {
        pending.resolvers.push({ resolve, returnEvent: !!options?.returnEvent });
        pending.rejecters.push(reject);
      });
    }

    const queuedOutboxId = await this.enqueueOutbox({
      event: raw, relayUrls, replaceableKey, isRepublish: options?.republish, proofOfWorkSealedKey: proofOfWorkSigner?.sealedKey,
    });
    const result = await this.publishForCaller(event, relaySet, queuedOutboxId, proofOfWorkSigner);
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
