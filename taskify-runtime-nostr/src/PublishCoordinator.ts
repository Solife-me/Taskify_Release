import { NDKEvent, NDKPrivateKeySigner, type NDKRelaySet, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { EventCache } from "./EventCache.js";
import {
  createNostrOutboxMutation,
  cloneNostrEvent,
  markOutboxPublishFailure,
  mergeOutboxRelayAcks,
  pendingRelayUrlsForMutation,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "./NostrOutbox.js";
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
type PublishEventResult = { createdAt: number; event: NostrEvent; ackedRelays: string[] };

export type PublishCoordinatorOptions = {
  outboxStore?: NostrOutboxStore;
  retryBaseMs?: number;
  retryMaxMs?: number;
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
    tags: event.tags,
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
  private activeOutboxIds = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private drainPromise: Promise<void> | null = null;

  constructor(ndk: NDK, resolveRelaySet: RelayResolver, cache?: EventCache, options?: PublishCoordinatorOptions) {
    this.ndk = ndk;
    this.resolveRelaySet = resolveRelaySet;
    this.eventCache = cache;
    this.outboxStore = options?.outboxStore;
    this.retryBaseMs = options?.retryBaseMs ?? 2_000;
    this.retryMaxMs = options?.retryMaxMs ?? 5 * 60_000;
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
    const publishedRelays = await event.publish(relaySet);
    const raw = event.rawEvent() as NostrEvent;
    this.eventCache?.add(raw);
    return { createdAt, event: raw, ackedRelays: relayUrlsFromPublishResult(publishedRelays) };
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

  private async enqueueOutbox(args: {
    event: NostrEvent;
    relayUrls: string[];
    replaceableKey?: string | null;
    nextAttemptAt?: number | null;
  }): Promise<string | null> {
    if (!this.outboxStore) return null;
    const id = this.outboxMutationId(args.event, args.replaceableKey);
    const existing = await this.outboxStore.get(id).catch(() => undefined);
    const mutation = createNostrOutboxMutation({
      id,
      event: args.event,
      relayUrls: args.relayUrls,
      replaceableKey: args.replaceableKey,
      existing,
      nextAttemptAt: args.nextAttemptAt ?? null,
    });
    try {
      await this.outboxStore.put(mutation);
    } catch {
      return null;
    }
    if (mutation.nextAttemptAt && mutation.nextAttemptAt > Date.now()) {
      this.scheduleOutboxRetry(id, mutation.nextAttemptAt - Date.now());
    }
    return id;
  }

  private async publishNowWithOutbox(event: NDKEvent, relaySet?: NDKRelaySet, outboxId?: string | null): Promise<PublishEventResult> {
    if (outboxId) this.activeOutboxIds.add(outboxId);
    try {
      const result = await this.publishNow(event, relaySet);
      if (outboxId) await this.markOutboxSuccess(outboxId, result.ackedRelays);
      return result;
    } catch (error) {
      if (outboxId) await this.markOutboxFailure(outboxId, error);
      throw error;
    } finally {
      if (outboxId) this.activeOutboxIds.delete(outboxId);
    }
  }

  private async markOutboxSuccess(outboxId: string, ackedRelays: string[]): Promise<void> {
    if (!this.outboxStore) return;
    const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
    if (!mutation) return;
    const next = mergeOutboxRelayAcks(mutation, ackedRelays);
    if (!next) {
      await this.outboxStore.delete(outboxId).catch(() => undefined);
      this.clearOutboxRetry(outboxId);
      return;
    }
    await this.outboxStore.put(next).catch(() => undefined);
    this.scheduleOutboxRetry(outboxId, 0);
  }

  private async markOutboxFailure(outboxId: string, error: unknown): Promise<void> {
    if (!this.outboxStore) return;
    const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
    if (!mutation) return;
    const attempts = mutation.attempts + 1;
    const delay = this.retryDelayMs(attempts);
    const next = markOutboxPublishFailure({
      mutation,
      error,
      ackedRelays: relayUrlsFromPublishError(error),
      nextAttemptAt: Date.now() + delay,
    });
    if (!next) {
      await this.outboxStore.delete(outboxId).catch(() => undefined);
      this.clearOutboxRetry(outboxId);
      return;
    }
    await this.outboxStore.put(next).catch(() => undefined);
    this.scheduleOutboxRetry(outboxId, delay);
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
    if (!event.sig || signer) await event.sign(signer);

    const raw = event.rawEvent() as NostrEvent;
    const replaceableKey =
      options?.replaceableKey || this.buildReplaceableKey(event) || (event.isReplaceable() ? event.deduplicationKey() : null);
    const outboxId = this.outboxMutationId(raw, replaceableKey);
    const hasPendingOutbox = await this.outboxHasPending(outboxId);

    if (!hasPendingOutbox && replaceableKey && this.shouldSkipReplaceable(replaceableKey, raw, options?.skipIfIdentical !== false)) {
      return options?.returnEvent ? { createdAt: raw.created_at, event: raw } : raw.created_at;
    }

    const relayUrls = this.relayUrlsForPublish(relaySet, options?.relayUrls);

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
