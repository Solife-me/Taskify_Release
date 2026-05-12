import NDK, { NDKEvent, NDKRelaySet, type NDKFilter, type NDKRelay } from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { CursorStore } from "./CursorStore.js";
import { SubscriptionManager, type ManagedSubscription, type SubscribeOptions } from "./SubscriptionManager.js";
import { PublishCoordinator, type PublishResult } from "./PublishCoordinator.js";
import { BoardKeyManager } from "./boardKeys.js";
import { EventCache } from "./EventCache.js";
import { normalizeRelayUrls } from "./relayUrls.js";

export type RelayInfoCacheLike = {
  prime: (relayUrl: string, loader: (nip11Url: string) => Promise<unknown>) => Promise<{ info?: unknown } | null>;
  needsRefresh: (relayUrl: string) => boolean;
  get: (relayUrl: string) => unknown;
  getAgeMs: (relayUrl: string) => number | null;
  getLimits: (relayUrls: string[]) => { maxLimit: number; authRequired?: boolean };
};

export type RelayHealthLike = {
  canAttempt: (relayUrl: string) => boolean;
  markFailure: (relayUrl: string, meta?: { severity?: string; reason?: string }) => void;
  markSuccess: (relayUrl: string) => void;
  onBackoffExpiry: (relayUrl: string, fn: () => void) => void;
  nextAttemptIn: (relayUrl: string) => number;
  status: (relayUrl: string) => { consecutiveFailures?: number } | null;
};

export type RelayAuthManagerLike = {
  respond: (relay: NDKRelay, challenge: string) => Promise<unknown>;
  reset: (relayUrl: string) => void;
  markAuthed: (relay: NDKRelay) => void;
};

export type RuntimeNostrSessionDeps<TWalletClient> = {
  relayInfoCache: RelayInfoCacheLike;
  relayHealth: RelayHealthLike;
  createAuthManager: (ndk: NDK) => RelayAuthManagerLike;
  createWalletClient: (args: {
    ndk: NDK;
    publisher: PublishCoordinator;
    subscriptions: SubscriptionManager;
    resolveRelaySet: (relayUrls?: string[]) => Promise<NDKRelaySet | undefined>;
  }) => TWalletClient;
  isDev?: boolean;
};

export class RuntimeNostrSession<TWalletClient = unknown> {
  private ndk: NDK;
  private initialized = false;
  private knownRelays: Set<string>;
  private relayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loggedDebugSummary = false;

  private readonly relayInfoCache: RelayInfoCacheLike;
  private readonly relayHealth: RelayHealthLike;
  private readonly authManager: RelayAuthManagerLike;
  private readonly isDev: boolean;

  readonly cache: EventCache;
  readonly cursors: CursorStore;
  readonly subscriptions: SubscriptionManager;
  readonly publisher: PublishCoordinator;
  readonly boardKeys: BoardKeyManager;
  readonly walletClient: TWalletClient;

  constructor(relays: string[], deps: RuntimeNostrSessionDeps<TWalletClient>) {
    const normalized = normalizeRelayUrls(relays);
    this.knownRelays = new Set(normalized);
    this.ndk = new NDK({ explicitRelayUrls: normalized, enableOutboxModel: true, autoConnectUserRelays: false });
    this.relayInfoCache = deps.relayInfoCache;
    this.relayHealth = deps.relayHealth;
    this.authManager = deps.createAuthManager(this.ndk);
    this.isDev = Boolean(deps.isDev);

    this.cache = new EventCache();
    this.cursors = new CursorStore();
    const relayResolver = this.buildRelaySet.bind(this);
    this.publisher = new PublishCoordinator(this.ndk, relayResolver, this.cache);
    this.subscriptions = new SubscriptionManager(this.ndk, this.cursors, relayResolver, this.cache, this.resolveRelayLimit.bind(this));
    this.boardKeys = new BoardKeyManager();
    this.walletClient = deps.createWalletClient({ ndk: this.ndk, publisher: this.publisher, subscriptions: this.subscriptions, resolveRelaySet: relayResolver });
    this.setupRelayHooks();
  }

  async init(relays: string[]): Promise<this> {
    const normalized = normalizeRelayUrls(relays);
    await this.ensureRelays(normalized);
    await this.connect();
    return this;
  }

  private async connect(): Promise<void> {
    if (this.initialized) return;
    // 3s: if a relay hasn't connected by then it's unreachable.
    // Subscriptions start against connected relays immediately; dead relays
    // are skipped and retried in the background via scheduleRelayConnect.
    await Promise.race([this.ndk.connect(), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    this.logDebugSummary();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.subscriptions.shutdown();
    try {
      await (this.ndk.pool as any)?.disconnect?.();
    } catch {
      // ignore
    }
  }

  private async buildRelaySet(relayUrls?: string[]): Promise<NDKRelaySet | undefined> {
    const relays = normalizeRelayUrls(relayUrls || Array.from(this.knownRelays));
    if (!relays.length) return undefined;
    await this.ensureRelays(relays);
    const relayObjects = new Set<NDKRelay>();
    for (const relayUrl of relays) {
      const canConnect = this.relayHealth.canAttempt(relayUrl);
      try {
        const relay = this.ndk.pool.getRelay(relayUrl, canConnect);
        relayObjects.add(relay);
        if (!canConnect) this.scheduleRelayConnect(relayUrl);
      } catch {}
    }
    if (!relayObjects.size) return undefined;
    return new NDKRelaySet(relayObjects, this.ndk, this.ndk.pool);
  }

  private async ensureRelays(relays: string[]): Promise<void> {
    const list = normalizeRelayUrls(relays);
    for (const relay of list) {
      this.primeRelayInfo(relay);
      if (this.knownRelays.has(relay)) continue;
      const canConnect = this.relayHealth.canAttempt(relay);
      try {
        this.ndk.addExplicitRelay(relay, undefined, canConnect);
        this.knownRelays.add(relay);
        if (!canConnect) this.scheduleRelayConnect(relay);
      } catch {}
    }
  }

  private async fetchRelayInfo(relayUrl: string): Promise<unknown> {
    try {
      const cached = await this.relayInfoCache.prime(relayUrl, async (nip11Url) => {
        const res = await fetch(nip11Url, { headers: { Accept: "application/nostr+json" } });
        if (!res.ok) {
          this.relayHealth.markFailure(relayUrl, { severity: "low", reason: `nip11:${res.status}` });
          this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
          return null;
        }
        const json = await res.json();
        this.relayHealth.markSuccess(relayUrl);
        return json;
      });
      return cached?.info ?? null;
    } catch {
      this.relayHealth.markFailure(relayUrl, { severity: "low", reason: "nip11:fetch" });
      this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
      return null;
    }
  }

  private resolveRelayLimit(relayUrls: string[]): Promise<number> {
    const relays = normalizeRelayUrls(relayUrls);
    relays.forEach((relay) => this.primeRelayInfo(relay));
    return Promise.resolve(this.relayInfoCache.getLimits(relays).maxLimit);
  }

  async subscribe(filters: NDKFilter | NDKFilter[], options?: SubscribeOptions): Promise<ManagedSubscription> {
    return this.subscriptions.subscribe(filters, options);
  }

  async publish(event: EventTemplate, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult> {
    return this.publisher.publish(event, options);
  }

  async publishRaw(event: NostrEvent, options?: Parameters<PublishCoordinator["publish"]>[1]): Promise<PublishResult> {
    return this.publisher.publishRaw(event, options);
  }

  async fetchEvents(filters: NDKFilter[], relayUrls?: string[], timeoutMs = 8_000, eoseGraceMs = 200, inactivityMs = 1_500): Promise<NostrEvent[]> {
    const relaySet = await this.buildRelaySet(relayUrls);
    return new Promise<NostrEvent[]>((resolve) => {
      const collected: NostrEvent[] = [];
      const seenIds = new Set<string>();
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let firstEventReceived = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        clearTimeout(hardTimer);
        try { sub.stop(); } catch {}
        resolve(collected);
      };

      const startGrace = () => {
        if (!graceTimer && !settled) {
          if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
          graceTimer = setTimeout(settle, eoseGraceMs);
        }
      };

      const hardTimer = setTimeout(settle, timeoutMs);
      const sub = this.ndk.subscribe(filters, { closeOnEose: false, relaySet });
      sub.on("event", (evt: NDKEvent) => {
        if (settled) return;
        const raw = (evt.rawEvent?.() as NostrEvent) ?? (evt as unknown as NostrEvent);
        if (!raw?.id || seenIds.has(raw.id)) return;
        seenIds.add(raw.id);
        collected.push(raw);
        // Reset inactivity timer — settle shortly after events stop arriving
        firstEventReceived = true;
        if (!graceTimer) {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(startGrace, inactivityMs);
        }
      });
      sub.on("eose", () => {
        // NDK subscription-level EOSE: definitive "done" signal
        startGrace();
      });
    });
  }

  private setupRelayHooks() {
    this.ndk.relayAuthDefaultPolicy = async (relay, challenge) => {
      try {
        const event = await this.authManager.respond(relay, challenge);
        return (event as any) ?? false;
      } catch {
        return false;
      }
    };

    this.ndk.pool.on("relay:connect", (relay: NDKRelay) => {
      this.relayHealth.markSuccess(relay.url);
      this.authManager.reset(relay.url);
      this.logDebugSummary();
    });
    this.ndk.pool.on("relay:ready", (relay: NDKRelay) => this.relayHealth.markSuccess(relay.url));
    this.ndk.pool.on("relay:disconnect", (relay: NDKRelay) => {
      this.relayHealth.markFailure(relay.url, { reason: "disconnect" });
      this.authManager.reset(relay.url);
      this.scheduleRelayConnect(relay.url);
    });
    this.ndk.pool.on("relay:authed", (relay: NDKRelay) => {
      this.authManager.markAuthed(relay);
      this.relayHealth.markSuccess(relay.url);
    });
  }

  private primeRelayInfo(relayUrl: string): void {
    if (!this.relayInfoCache.needsRefresh(relayUrl)) return;
    if (!this.relayHealth.canAttempt(relayUrl)) {
      this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
      return;
    }
    void this.fetchRelayInfo(relayUrl);
  }

  private scheduleRelayConnect(relayUrl: string): void {
    if (this.relayRetryTimers.has(relayUrl)) return;
    const delay = this.relayHealth.nextAttemptIn(relayUrl);
    const timer = setTimeout(() => {
      this.relayRetryTimers.delete(relayUrl);
      if (!this.relayHealth.canAttempt(relayUrl)) return this.scheduleRelayConnect(relayUrl);
      try {
        const relay = this.ndk.pool.getRelay(relayUrl, true);
        const connectPromise = relay.connect?.();
        if (connectPromise?.catch) {
          connectPromise.catch((err: unknown) => {
            if (this.isDev) console.debug("[nostr] relay reconnect failed", relayUrl, err);
          });
        }
      } catch {}
    }, delay || 0);
    this.relayRetryTimers.set(relayUrl, timer);
  }

  private logDebugSummary() {
    if (this.loggedDebugSummary || !this.isDev) return;
    this.loggedDebugSummary = true;
    const summary = Array.from(this.knownRelays).map((relayUrl) => {
      const ageMs = this.relayInfoCache.getAgeMs(relayUrl);
      const ageMinutes = ageMs != null ? Math.round(ageMs / 60000) : null;
      const limits = this.relayInfoCache.getLimits([relayUrl]);
      const health = this.relayHealth.status(relayUrl);
      return {
        relay: relayUrl,
        cacheAgeM: ageMinutes,
        authRequired: limits.authRequired,
        backoffMs: this.relayHealth.nextAttemptIn(relayUrl),
        failures: health?.consecutiveFailures ?? 0,
      };
    });
    console.debug("[nostr][debug] relay state", summary);
  }
}
