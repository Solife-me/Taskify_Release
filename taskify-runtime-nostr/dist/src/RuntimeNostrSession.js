import NDK, { NDKRelaySet } from "@nostr-dev-kit/ndk";
import { CursorStore } from "./CursorStore.js";
import { SubscriptionManager } from "./SubscriptionManager.js";
import { PublishCoordinator } from "./PublishCoordinator.js";
import { BoardKeyManager } from "./boardKeys.js";
import { EventCache } from "./EventCache.js";
import { normalizeRelayUrls } from "./relayUrls.js";
export class RuntimeNostrSession {
    ndk;
    initialized = false;
    knownRelays;
    relayRetryTimers = new Map();
    loggedDebugSummary = false;
    relayInfoCache;
    relayHealth;
    authManager;
    isDev;
    cache;
    cursors;
    subscriptions;
    publisher;
    boardKeys;
    walletClient;
    constructor(relays, deps) {
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
        this.publisher = new PublishCoordinator(this.ndk, relayResolver, this.cache, { outboxStore: deps.outboxStore });
        this.subscriptions = new SubscriptionManager(this.ndk, this.cursors, relayResolver, this.cache, this.resolveRelayLimit.bind(this));
        this.boardKeys = new BoardKeyManager();
        this.walletClient = deps.createWalletClient({ ndk: this.ndk, publisher: this.publisher, subscriptions: this.subscriptions, resolveRelaySet: relayResolver });
        this.setupRelayHooks();
    }
    async init(relays) {
        const normalized = normalizeRelayUrls(relays);
        await this.ensureRelays(normalized);
        await this.connect();
        return this;
    }
    async connect() {
        if (this.initialized)
            return;
        // 3s: if a relay hasn't connected by then it's unreachable.
        // Subscriptions start against connected relays immediately; dead relays
        // are skipped and retried in the background via scheduleRelayConnect.
        await Promise.race([this.ndk.connect(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
        this.logDebugSummary();
        this.initialized = true;
    }
    async shutdown() {
        this.publisher.shutdown();
        this.subscriptions.shutdown();
        try {
            await this.ndk.pool?.disconnect?.();
        }
        catch {
            // ignore
        }
    }
    async buildRelaySet(relayUrls) {
        const relays = normalizeRelayUrls(relayUrls || Array.from(this.knownRelays));
        if (!relays.length)
            return undefined;
        await this.ensureRelays(relays);
        const relayObjects = new Set();
        for (const relayUrl of relays) {
            const canConnect = this.relayHealth.canAttempt(relayUrl);
            try {
                const relay = this.ndk.pool.getRelay(relayUrl, canConnect);
                relayObjects.add(relay);
                if (!canConnect)
                    this.scheduleRelayConnect(relayUrl);
            }
            catch { }
        }
        if (!relayObjects.size)
            return undefined;
        return new NDKRelaySet(relayObjects, this.ndk, this.ndk.pool);
    }
    async ensureRelays(relays) {
        const list = normalizeRelayUrls(relays);
        for (const relay of list) {
            this.primeRelayInfo(relay);
            if (this.knownRelays.has(relay))
                continue;
            const canConnect = this.relayHealth.canAttempt(relay);
            try {
                this.ndk.addExplicitRelay(relay, undefined, canConnect);
                this.knownRelays.add(relay);
                if (!canConnect)
                    this.scheduleRelayConnect(relay);
            }
            catch { }
        }
    }
    async fetchRelayInfo(relayUrl) {
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
        }
        catch {
            this.relayHealth.markFailure(relayUrl, { severity: "low", reason: "nip11:fetch" });
            this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
            return null;
        }
    }
    resolveRelayLimit(relayUrls) {
        const relays = normalizeRelayUrls(relayUrls);
        relays.forEach((relay) => this.primeRelayInfo(relay));
        return Promise.resolve(this.relayInfoCache.getLimits(relays).maxLimit);
    }
    async subscribe(filters, options) {
        return this.subscriptions.subscribe(filters, options);
    }
    async publish(event, options) {
        return this.publisher.publish(event, options);
    }
    async publishRaw(event, options) {
        return this.publisher.publishRaw(event, options);
    }
    async fetchEvents(filters, relayUrls, timeoutMs = 8_000, eoseGraceMs = 200, inactivityMs = 1_500) {
        const relaySet = await this.buildRelaySet(relayUrls);
        return new Promise((resolve) => {
            const collected = [];
            const seenIds = new Set();
            let graceTimer = null;
            let inactivityTimer = null;
            let settled = false;
            let firstEventReceived = false;
            const settle = () => {
                if (settled)
                    return;
                settled = true;
                if (graceTimer)
                    clearTimeout(graceTimer);
                if (inactivityTimer)
                    clearTimeout(inactivityTimer);
                clearTimeout(hardTimer);
                try {
                    sub.stop();
                }
                catch { }
                resolve(collected);
            };
            const startGrace = () => {
                if (!graceTimer && !settled) {
                    if (inactivityTimer) {
                        clearTimeout(inactivityTimer);
                        inactivityTimer = null;
                    }
                    graceTimer = setTimeout(settle, eoseGraceMs);
                }
            };
            const hardTimer = setTimeout(settle, timeoutMs);
            const sub = this.ndk.subscribe(filters, { closeOnEose: false, relaySet });
            sub.on("event", (evt) => {
                if (settled)
                    return;
                const raw = evt.rawEvent?.() ?? evt;
                if (!raw?.id || seenIds.has(raw.id))
                    return;
                seenIds.add(raw.id);
                collected.push(raw);
                // Reset inactivity timer — settle shortly after events stop arriving
                firstEventReceived = true;
                if (!graceTimer) {
                    if (inactivityTimer)
                        clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(startGrace, inactivityMs);
                }
            });
            sub.on("eose", () => {
                // NDK subscription-level EOSE: definitive "done" signal
                startGrace();
            });
        });
    }
    setupRelayHooks() {
        this.ndk.relayAuthDefaultPolicy = async (relay, challenge) => {
            try {
                const event = await this.authManager.respond(relay, challenge);
                return event ?? false;
            }
            catch {
                return false;
            }
        };
        this.ndk.pool.on("relay:connect", (relay) => {
            this.relayHealth.markSuccess(relay.url);
            this.authManager.reset(relay.url);
            this.drainOutbox("relay:connect");
            this.logDebugSummary();
        });
        this.ndk.pool.on("relay:ready", (relay) => {
            this.relayHealth.markSuccess(relay.url);
            this.drainOutbox("relay:ready");
        });
        this.ndk.pool.on("relay:disconnect", (relay) => {
            this.relayHealth.markFailure(relay.url, { reason: "disconnect" });
            this.authManager.reset(relay.url);
            this.scheduleRelayConnect(relay.url);
        });
        this.ndk.pool.on("relay:authed", (relay) => {
            this.authManager.markAuthed(relay);
            this.relayHealth.markSuccess(relay.url);
            this.drainOutbox("relay:authed");
        });
    }
    drainOutbox(reason) {
        void this.publisher.drainOutbox({ force: true }).catch((err) => {
            if (this.isDev)
                console.debug("[nostr] outbox drain failed", reason, err);
        });
    }
    primeRelayInfo(relayUrl) {
        if (!this.relayInfoCache.needsRefresh(relayUrl))
            return;
        if (!this.relayHealth.canAttempt(relayUrl)) {
            this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
            return;
        }
        void this.fetchRelayInfo(relayUrl);
    }
    scheduleRelayConnect(relayUrl) {
        if (this.relayRetryTimers.has(relayUrl))
            return;
        const delay = this.relayHealth.nextAttemptIn(relayUrl);
        const timer = setTimeout(() => {
            this.relayRetryTimers.delete(relayUrl);
            if (!this.relayHealth.canAttempt(relayUrl))
                return this.scheduleRelayConnect(relayUrl);
            try {
                const relay = this.ndk.pool.getRelay(relayUrl, true);
                const connectPromise = relay.connect?.();
                if (connectPromise?.catch) {
                    connectPromise.catch((err) => {
                        if (this.isDev)
                            console.debug("[nostr] relay reconnect failed", relayUrl, err);
                    });
                }
            }
            catch { }
        }, delay || 0);
        this.relayRetryTimers.set(relayUrl, timer);
    }
    logDebugSummary() {
        if (this.loggedDebugSummary || !this.isDev)
            return;
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
