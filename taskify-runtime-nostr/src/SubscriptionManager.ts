import type NDK from "@nostr-dev-kit/ndk";
import type {
  NDKEvent,
  NDKFilter,
  NDKRelaySet,
  NDKSubscription,
  NDKSubscriptionOptions,
} from "@nostr-dev-kit/ndk";
import type { NostrEvent } from "nostr-tools";
import { CursorStore } from "./CursorStore.js";
import { EventCache } from "./EventCache.js";
import { normalizeRelayUrls } from "./relayUrls.js";

export type SubscriptionRelayResolver = (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
export type RelayLimitResolver = (relayUrls: string[]) => Promise<number | null>;

export type SubscribeOptions = {
  relayUrls?: string[];
  onEvent?: (event: NostrEvent, relay?: string) => void;
  onEose?: (relay?: string) => void;
  skipSince?: boolean;
  opts?: NDKSubscriptionOptions;
};

export type ManagedSubscription = {
  key: string;
  subscription: NDKSubscription;
  release: () => void;
  filters: NDKFilter[];
  relayUrls: string[];
};

type Handler = { onEvent?: (event: NostrEvent, relay?: string) => void; onEose?: (relay?: string) => void };
type PendingEvent = { raw: NostrEvent; relayUrl?: string };

type SubscriptionState = {
  key: string;
  subscription: NDKSubscription;
  filters: NDKFilter[];
  relayUrls: string[];
  handlers: Set<Handler>;
  refCount: number;
  seenIds: Set<string>;
  pendingEvents: PendingEvent[];
  flushScheduled: boolean;
  pendingEoseRelays: Array<string | undefined>;
  eoseFlushScheduled: boolean;
};

const MAX_SEEN_IDS = 4096;
const FLUSH_BATCH_SIZE = 64;

function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

function uniqueSorted<T>(values: T[], sortFn?: (a: T, b: T) => number): T[] {
  const set = new Set(values);
  return Array.from(set).sort(sortFn as never);
}

function normalizeFilter(filter: NDKFilter): NDKFilter {
  const normalized: NDKFilter = {};
  Object.entries(filter).forEach(([key, value]) => {
    if (value == null) return;
    if (key === "kinds" && Array.isArray(value)) {
      normalized.kinds = uniqueSorted(value.filter((v): v is number => typeof v === "number"), (a, b) => a - b);
    } else if (key === "authors" && Array.isArray(value)) {
      normalized.authors = uniqueSorted(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
    } else if (key.startsWith("#") && Array.isArray(value)) {
      (normalized as Record<string, unknown>)[key] = uniqueSorted(
        value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean),
      );
    } else if (key === "since" || key === "until" || key === "limit") {
      const num = Number(value);
      if (Number.isFinite(num)) (normalized as Record<string, unknown>)[key] = num;
    } else {
      (normalized as Record<string, unknown>)[key] = value as unknown;
    }
  });
  return normalized;
}

function stableStringify(filter: NDKFilter): string {
  const ordered: Record<string, unknown> = {};
  Object.keys(filter).sort().forEach((key) => {
    const value = (filter as Record<string, unknown>)[key];
    ordered[key] = Array.isArray(value) ? value.slice() : value;
  });
  return JSON.stringify(ordered);
}

export class SubscriptionManager {
  private readonly ndk: NDK;
  private readonly cursorStore: CursorStore;
  private readonly eventCache?: EventCache;
  private readonly resolveRelaySet: SubscriptionRelayResolver;
  private readonly relayLimitResolver?: RelayLimitResolver;
  private readonly subs = new Map<string, SubscriptionState>();

  constructor(
    ndk: NDK,
    cursorStore: CursorStore,
    resolveRelaySet: SubscriptionRelayResolver,
    eventCache?: EventCache,
    relayLimitResolver?: RelayLimitResolver,
  ) {
    this.ndk = ndk;
    this.cursorStore = cursorStore;
    this.resolveRelaySet = resolveRelaySet;
    this.eventCache = eventCache;
    this.relayLimitResolver = relayLimitResolver;
  }

  private async clampFilters(filters: NDKFilter[], relayUrls: string[]): Promise<NDKFilter[]> {
    if (!this.relayLimitResolver || !relayUrls.length) return filters;
    try {
      const maxLimit = await this.relayLimitResolver(relayUrls);
      const safeLimit = Number.isFinite(maxLimit) && maxLimit ? maxLimit : 5000;
      return filters.map((f) => (f.limit && f.limit > safeLimit ? { ...f, limit: safeLimit } : f));
    } catch {
      return filters;
    }
  }

  private async normalizeFilters(
    filters: NDKFilter[],
    relayUrls: string[],
    skipSince?: boolean,
  ): Promise<{ normalized: NDKFilter[]; key: string }> {
    const normalized = await this.clampFilters(
      filters.map((f) => {
        const nf = normalizeFilter(f);
        if (!skipSince && nf.since == null) {
          const since = this.cursorStore.getSince(nf);
          if (since) nf.since = since;
        }
        return nf;
      }),
      relayUrls,
    );
    const signature = normalized.map((f) => stableStringify(f)).sort().join("|");
    return { normalized, key: `${relayUrls.join(",")}|${signature}` };
  }

  private scheduleFlush(state: SubscriptionState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    scheduleFrame(() => this.flushPending(state));
  }

  private scheduleEoseFlush(state: SubscriptionState): void {
    if (state.eoseFlushScheduled) return;
    state.eoseFlushScheduled = true;
    scheduleFrame(() => this.flushEose(state));
  }

  private flushPending(state: SubscriptionState): void {
    state.flushScheduled = false;
    const batch = state.pendingEvents.splice(0, FLUSH_BATCH_SIZE);
    for (const { raw, relayUrl } of batch) {
      state.handlers.forEach((h) => {
        try { h.onEvent?.(raw, relayUrl); } catch {}
      });
    }
    if (state.pendingEvents.length > 0) this.scheduleFlush(state);
    else if (state.pendingEoseRelays.length > 0) this.scheduleEoseFlush(state);
  }

  private flushEose(state: SubscriptionState): void {
    state.eoseFlushScheduled = false;
    if (state.pendingEvents.length > 0) {
      this.scheduleFlush(state);
      return;
    }
    const relays = state.pendingEoseRelays.splice(0);
    for (const relayUrl of relays) {
      state.handlers.forEach((h) => {
        try { h.onEose?.(relayUrl); } catch {}
      });
    }
  }

  async subscribe(filtersInput: NDKFilter | NDKFilter[], options?: SubscribeOptions): Promise<ManagedSubscription> {
    const filters = Array.isArray(filtersInput) ? filtersInput : [filtersInput];
    const relayUrls = normalizeRelayUrls(options?.relayUrls || []);
    const { normalized, key } = await this.normalizeFilters(filters, relayUrls, options?.skipSince);
    const existing = this.subs.get(key);
    const handler: Handler = { onEvent: options?.onEvent, onEose: options?.onEose };

    if (existing) {
      existing.refCount += 1;
      existing.handlers.add(handler);
      return { key, subscription: existing.subscription, release: () => this.release(key, handler), filters: existing.filters, relayUrls: existing.relayUrls };
    }

    const relaySet = await this.resolveRelaySet(relayUrls);
    const opts: NDKSubscriptionOptions = { ...options?.opts, closeOnEose: options?.opts?.closeOnEose ?? false, relaySet };

    const state: SubscriptionState = {
      key,
      subscription: null as unknown as NDKSubscription,
      filters: normalized,
      relayUrls,
      handlers: new Set(handler.onEvent || handler.onEose ? [handler] : []),
      refCount: 1,
      seenIds: new Set<string>(),
      pendingEvents: [],
      flushScheduled: false,
      pendingEoseRelays: [],
      eoseFlushScheduled: false,
    };
    this.subs.set(key, state);

    const sub = this.ndk.subscribe(normalized, opts);
    state.subscription = sub;

    sub.on("event", (evt: NDKEvent) => {
      let raw: NostrEvent;
      try { raw = evt.rawEvent() as NostrEvent; } catch { return; }
      if (!raw?.id || typeof raw.id !== "string") return;
      if (state.seenIds.has(raw.id)) return;

      state.seenIds.add(raw.id);
      if (state.seenIds.size > MAX_SEEN_IDS) {
        const [oldest] = state.seenIds;
        if (oldest) state.seenIds.delete(oldest);
      }

      this.eventCache?.add(raw);
      if (raw.created_at && Number.isFinite(raw.created_at)) this.cursorStore.updateMany(state.filters, raw.created_at);
      state.pendingEvents.push({ raw, relayUrl: evt.relay?.url });
      this.scheduleFlush(state);
    });

    sub.on("eose", (relay?: unknown) => {
      const relayUrl = relay && typeof relay === "object" && "url" in relay ? (relay as { url?: string }).url : undefined;
      state.pendingEoseRelays.push(relayUrl);
      if (state.pendingEvents.length > 0) this.scheduleFlush(state);
      else this.scheduleEoseFlush(state);
    });

    return { key, subscription: sub, release: () => this.release(key, handler), filters: normalized, relayUrls };
  }

  private release(key: string, handler?: Handler) {
    const state = this.subs.get(key);
    if (!state) return;
    if (handler) state.handlers.delete(handler);
    state.refCount -= 1;
    if (state.refCount > 0) return;
    try { state.subscription.stop(); } catch {}
    this.subs.delete(key);
  }

  shutdown() {
    for (const [key, state] of this.subs) {
      try { state.subscription.stop(); } catch {}
      this.subs.delete(key);
    }
  }
}
