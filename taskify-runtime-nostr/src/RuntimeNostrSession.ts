import NDK, { NDKEvent, NDKRelaySet, NDKRelayStatus, type NDKFilter, type NDKRelay, type NDKSigner } from "@nostr-dev-kit/ndk";
import { finalizeEvent, verifyEvent, type EventTemplate, type NostrEvent } from "nostr-tools";
import { applyProofOfWork, countLeadingZeroBits, mineEventTemplate, type ProofOfWorkHashFactory, type ProofOfWorkOptions } from "./ProofOfWork.js";
import { createRelayAuthPolicy, type RelayAuthOutcome } from "./RelayAuth.js";
import { CursorStore } from "./CursorStore.js";
import { SubscriptionManager, type ManagedSubscription, type SubscribeOptions } from "./SubscriptionManager.js";
import { PublishCoordinator, type PublishOptions, type PublishResult } from "./PublishCoordinator.js";
import { BoardKeyManager } from "./boardKeys.js";
import { EventCache } from "./EventCache.js";
import type { NostrOutboxStore } from "./NostrOutbox.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import type { RelayInfo } from "./RelayInfoCache.js";

export type RelayInfoCacheLike = {
  prime: (relayUrl: string, loader: (nip11Url: string) => Promise<RelayInfo | null>) => Promise<{ info?: unknown } | null>;
  needsRefresh: (relayUrl: string) => boolean;
  get: (relayUrl: string) => unknown;
  getAgeMs: (relayUrl: string) => number | null;
  getLimits: (relayUrls: string[]) => { maxLimit: number; authRequired?: boolean; minPowDifficulty?: number };
  recordProofOfWorkRequirement?: (relayUrl: string, difficulty: number) => void;
};

export type RelayHealthLike = {
  canAttempt: (relayUrl: string) => boolean;
  markFailure: (relayUrl: string, meta?: { severity?: "low" | "normal" | "high"; reason?: string }) => void;
  markSuccess: (relayUrl: string) => void;
  onBackoffExpiry: (relayUrl: string, fn: () => void) => void;
  nextAttemptIn: (relayUrl: string) => number;
  status: (relayUrl: string) => { consecutiveFailures?: number } | null;
};

export type RelayAuthManagerLike = {
  respond: (relay: NDKRelay, challenge: string) => Promise<unknown>;
  reset: (relayUrl: string) => void;
  markAuthed: (relay: NDKRelay, authEventId?: string) => void;
  markFailed?: (relay: NDKRelay, reason: string, authEventId?: string) => void;
  isAuthed?: (relay: NDKRelay) => boolean;
  outcome?: (relayUrl: string) => RelayAuthOutcome | null;
};

export type RuntimeProofOfWorkSettings = {
  /** Native SHA-256 for mining (e.g. Node's `crypto`); defaults to a portable implementation. */
  hashFactory?: ProofOfWorkHashFactory;
  /** How long one event may be mined before the write fails (default 30 s). */
  timeoutMs?: number;
  /** A floor applied to every write, on top of what relays require (NIP-13 spam signalling). */
  minDifficulty?: number;
  /** Called before mining starts, e.g. to tell a user a slow write is in progress. */
  onMine?: (difficulty: number, relayUrls: string[]) => void;
};

export type RelayRuntimeStatus = {
  url: string;
  connected: boolean;
  status: string;
  /** NIP-11 says the relay requires NIP-42 authentication. */
  authRequired: boolean;
  /** The latest NIP-42 outcome, or null if the relay never challenged this session. */
  auth: RelayAuthOutcome | null;
  /** The NIP-13 difficulty writes to this relay are mined to (advertised or learned). */
  minPowDifficulty: number;
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
  outboxStore?: NostrOutboxStore;
  isDev?: boolean;
  proofOfWork?: RuntimeProofOfWorkSettings;
  /** How long to wait for a relay to accept an AUTH event (default 10 s). */
  authTimeoutMs?: number;
  /**
   * NDK's outbox model (default on) also connects to NDK's own discovery relays. Clients that
   * always name their relays can turn it off so they talk only to relays the user chose.
   */
  enableOutboxModel?: boolean;
};

export class RuntimeNostrSession<TWalletClient = unknown> {
  private ndk: NDK;
  private initialized = false;
  private knownRelays: Set<string>;
  private relayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loggedDebugSummary = false;
  private shuttingDown = false;
  private readonly workAbort = new AbortController();

  private readonly relayInfoCache: RelayInfoCacheLike;
  private readonly relayHealth: RelayHealthLike;
  private readonly authManager: RelayAuthManagerLike;
  private readonly isDev: boolean;
  private readonly proofOfWork: RuntimeProofOfWorkSettings;
  private readonly authTimeoutMs?: number;

  readonly cache: EventCache;
  readonly cursors: CursorStore;
  readonly subscriptions: SubscriptionManager;
  readonly publisher: PublishCoordinator;
  readonly boardKeys: BoardKeyManager;
  readonly walletClient: TWalletClient;

  constructor(relays: string[], deps: RuntimeNostrSessionDeps<TWalletClient>) {
    const normalized = normalizeRelayUrls(relays);
    this.knownRelays = new Set(normalized);
    this.ndk = new NDK({ explicitRelayUrls: normalized, enableOutboxModel: deps.enableOutboxModel ?? true, autoConnectUserRelays: false });
    this.relayInfoCache = deps.relayInfoCache;
    this.relayHealth = deps.relayHealth;
    this.authManager = deps.createAuthManager(this.ndk);
    this.isDev = Boolean(deps.isDev);
    this.proofOfWork = deps.proofOfWork ?? {};
    this.authTimeoutMs = deps.authTimeoutMs;

    this.cache = new EventCache();
    this.cursors = new CursorStore();
    const relayResolver = this.buildRelaySet.bind(this);
    this.publisher = new PublishCoordinator(this.ndk, relayResolver, this.cache, {
      outboxStore: deps.outboxStore,
      resolveProofOfWorkDifficulty: this.resolveProofOfWorkDifficulty.bind(this),
      proofOfWork: this.miningOptions(),
      onProofOfWorkRequired: (relayUrl, difficulty) => {
        this.relayInfoCache.recordProofOfWorkRequirement?.(relayUrl, difficulty);
        if (this.isDev) console.error("[nostr] relay requires proof of work", relayUrl, difficulty);
      },
      signal: this.workAbort.signal,
    });
    this.subscriptions = new SubscriptionManager(this.ndk, this.cursors, relayResolver, this.cache, this.resolveRelayLimit.bind(this));
    this.boardKeys = new BoardKeyManager();
    this.walletClient = deps.createWalletClient({ ndk: this.ndk, publisher: this.publisher, subscriptions: this.subscriptions, resolveRelaySet: relayResolver });
    this.setupRelayHooks();
  }

  async init(relays: string[]): Promise<this> {
    this.shuttingDown = false;
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
    this.shuttingDown = true;
    this.workAbort.abort();
    this.publisher.shutdown();
    this.subscriptions.shutdown();
    for (const timer of this.relayRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.relayRetryTimers.clear();
    for (const pool of [this.ndk.pool, this.ndk.outboxPool]) {
      if (!pool) continue;
      for (const relay of pool.relays.values()) {
        try {
          relay.disconnect();
        } catch {
          // ignore individual relay teardown errors
        }
      }
      try {
        (pool as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // ignore pool teardown errors
      }
    }
    // Some NDK relay implementations emit disconnect asynchronously. Clear a
    // second time after initiating teardown; the hook also checks shuttingDown.
    for (const timer of this.relayRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.relayRetryTimers.clear();
    this.initialized = false;
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
        const res = await fetch(nip11Url, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5_000) });
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

  private async resolveProofOfWorkDifficulty(relayUrls: string[]): Promise<number> {
    const relays = normalizeRelayUrls(relayUrls);
    await Promise.all(relays.map((relay) => this.fetchRelayInfo(relay)));
    const required = this.relayInfoCache.getLimits(relays).minPowDifficulty ?? 0;
    const floor = Number.isInteger(this.proofOfWork.minDifficulty) ? Math.max(0, this.proofOfWork.minDifficulty!) : 0;
    return Math.max(required, floor);
  }

  private miningOptions(): Omit<ProofOfWorkOptions, "signal"> {
    return { hashFactory: this.proofOfWork.hashFactory, timeoutMs: this.proofOfWork.timeoutMs };
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

  async prepareNDKEvent(event: NDKEvent, signer: NDKSigner, relayUrls: string[]): Promise<void> {
    const difficulty = await this.resolveProofOfWorkDifficulty(relayUrls);
    if (difficulty > 0) {
      this.proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relayUrls));
      await applyProofOfWork(event, signer, difficulty, { ...this.miningOptions(), signal: this.workAbort.signal });
    } else if (!event.sig) await event.sign(signer);
  }

  async prepareEvent(template: EventTemplate, secretKey: Uint8Array, relayUrls: string[], options?: ProofOfWorkOptions): Promise<NostrEvent> {
    const difficulty = await this.resolveProofOfWorkDifficulty(relayUrls);
    if (difficulty > 0) this.proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relayUrls));
    return finalizeEvent(await mineEventTemplate(template, secretKey, difficulty, { ...this.miningOptions(), ...options, signal: options?.signal ? AbortSignal.any([options.signal, this.workAbort.signal]) : this.workAbort.signal }), secretKey);
  }

  /**
   * Signs (mining NIP-13 proof of work where relays ask for it) and publishes an event. When a
   * relay refuses it for too little work and names its target, the event is mined again to that
   * target and resent once: replaceable events go to every relay with a newer timestamp so the
   * stronger copy wins everywhere; other events go only to the relays that refused them.
   * `event` is updated in place to the copy that was last published.
   */
  async publishSigned(
    event: NDKEvent,
    signer: NDKSigner,
    relayUrls: string[],
    options?: Omit<PublishOptions, "relayUrls" | "signer">,
  ): Promise<PublishResult> {
    const relays = normalizeRelayUrls(relayUrls);
    await this.prepareNDKEvent(event, signer, relays);
    let result: PublishResult | undefined;
    let failure: unknown = null;
    try {
      result = await this.publishRaw(event.rawEvent() as NostrEvent, { ...options, relayUrls: relays });
    } catch (error) {
      failure = error;
    }
    const achieved = /^[0-9a-f]{64}$/i.test(event.id || "") ? countLeadingZeroBits(event.id) : 0;
    const shortfall = relays.filter((relay) => (this.relayInfoCache.getLimits([relay]).minPowDifficulty ?? 0) > achieved);
    if (!shortfall.length) {
      if (failure) throw failure;
      return result!;
    }

    const replaceable = event.isReplaceable();
    const targets = replaceable ? relays : shortfall;
    event.tags = event.tags.filter((tag) => tag[0] !== "nonce");
    event.sig = undefined;
    event.id = "";
    if (replaceable) event.created_at = Math.max(Math.floor(Date.now() / 1000), (event.created_at ?? 0) + 1);
    await this.prepareNDKEvent(event, signer, targets);
    return this.publishRaw(event.rawEvent() as NostrEvent, { ...options, relayUrls: targets, skipIfIdentical: false });
  }

  createEvent(event?: NostrEvent): NDKEvent {
    return new NDKEvent(this.ndk, event);
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
        // NDK only samples signatures once a relay looks trustworthy. History reads decide
        // where messages are sent and whose profile is shown, so every event is checked here as
        // in SubscriptionManager. The ID is recorded only after the check, so a forged copy
        // cannot shadow the genuine event arriving from another relay.
        let signatureValid = false;
        try {
          signatureValid = verifyEvent({ id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind, created_at: raw.created_at, tags: raw.tags, content: raw.content });
        } catch {
          signatureValid = false;
        }
        if (!signatureValid) return;
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

  relayStatuses(): RelayRuntimeStatus[] {
    return Array.from(this.knownRelays).map((url) => {
      const relay = Array.from(this.ndk.pool.relays.values()).find((candidate) =>
        normalizeRelayUrls([candidate.url])[0] === url);
      const status = relay?.status;
      const limits = this.relayInfoCache.getLimits([url]);
      return {
        url,
        // An authenticated relay is connected too.
        connected: status !== undefined && status >= NDKRelayStatus.CONNECTED,
        status: status === undefined ? "unknown" : NDKRelayStatus[status] ?? String(status),
        authRequired: Boolean(limits.authRequired),
        auth: this.authManager.outcome?.(url) ?? null,
        minPowDifficulty: limits.minPowDifficulty ?? 0,
      };
    });
  }

  private setupRelayHooks() {
    this.ndk.relayAuthDefaultPolicy = createRelayAuthPolicy(this.authManager, { timeoutMs: this.authTimeoutMs });

    this.ndk.pool.on("relay:connect", (relay: NDKRelay) => {
      if (this.shuttingDown) return;
      this.relayHealth.markSuccess(relay.url);
      this.authManager.reset(relay.url);
      this.drainOutbox("relay:connect");
      this.logDebugSummary();
    });
    this.ndk.pool.on("relay:ready", (relay: NDKRelay) => {
      if (this.shuttingDown) return;
      this.relayHealth.markSuccess(relay.url);
      this.drainOutbox("relay:ready");
    });
    this.ndk.pool.on("relay:disconnect", (relay: NDKRelay) => {
      if (this.shuttingDown) return;
      this.relayHealth.markFailure(relay.url, { reason: "disconnect" });
      this.authManager.reset(relay.url);
      this.scheduleRelayConnect(relay.url);
    });
    this.ndk.pool.on("relay:authed", (relay: NDKRelay) => {
      if (this.shuttingDown) return;
      this.authManager.markAuthed(relay);
      this.relayHealth.markSuccess(relay.url);
      this.drainOutbox("relay:authed");
    });
  }

  private drainOutbox(reason: string): void {
    // Relay lifecycle events can arrive in quick succession (connect, ready,
    // auth). Respect each row's persisted retry deadline so those events do not
    // bypass backoff and hammer a relay that just returned a partial result.
    void this.publisher.drainOutbox().catch((err) => {
      if (this.isDev) console.error("[nostr] outbox drain failed", reason, err);
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
    if (this.shuttingDown) return;
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
            if (this.isDev) console.error("[nostr] relay reconnect failed", relayUrl, err);
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
    console.error("[nostr][debug] relay state", summary);
  }
}
