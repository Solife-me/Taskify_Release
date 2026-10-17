import NDK, { NDKEvent, NDKRelaySet, NDKRelayStatus } from "@nostr-dev-kit/ndk";
import { finalizeEvent, verifyEvent } from "nostr-tools";
import { applyProofOfWork, countLeadingZeroBits, mineEventTemplate, mineEventTemplateFor } from "./ProofOfWork.js";
import { createRelayAuthPolicy } from "./RelayAuth.js";
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
    shuttingDown = false;
    workAbort = new AbortController();
    relayInfoCache;
    relayHealth;
    authManager;
    isDev;
    proofOfWork;
    authTimeoutMs;
    cache;
    cursors;
    subscriptions;
    publisher;
    boardKeys;
    walletClient;
    constructor(relays, deps) {
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
                if (this.isDev)
                    console.error("[nostr] relay requires proof of work", relayUrl, difficulty);
            },
            signal: this.workAbort.signal,
        });
        this.subscriptions = new SubscriptionManager(this.ndk, this.cursors, relayResolver, this.cache, this.resolveRelayLimit.bind(this));
        this.boardKeys = new BoardKeyManager();
        this.walletClient = deps.createWalletClient({ ndk: this.ndk, publisher: this.publisher, subscriptions: this.subscriptions, resolveRelaySet: relayResolver });
        this.setupRelayHooks();
    }
    async init(relays) {
        this.shuttingDown = false;
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
        this.shuttingDown = true;
        this.workAbort.abort();
        this.publisher.shutdown();
        this.subscriptions.shutdown();
        for (const timer of this.relayRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.relayRetryTimers.clear();
        for (const pool of [this.ndk.pool, this.ndk.outboxPool]) {
            if (!pool)
                continue;
            for (const relay of pool.relays.values()) {
                try {
                    relay.disconnect();
                }
                catch {
                    // ignore individual relay teardown errors
                }
            }
            try {
                pool.destroy?.();
            }
            catch {
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
        }
        catch {
            this.relayHealth.markFailure(relayUrl, { severity: "low", reason: "nip11:fetch" });
            this.relayHealth.onBackoffExpiry(relayUrl, () => this.primeRelayInfo(relayUrl));
            return null;
        }
    }
    async resolveProofOfWorkDifficulty(relayUrls) {
        const relays = normalizeRelayUrls(relayUrls);
        await Promise.all(relays.map((relay) => this.fetchRelayInfo(relay)));
        const required = this.relayInfoCache.getLimits(relays).minPowDifficulty ?? 0;
        const floor = Number.isInteger(this.proofOfWork.minDifficulty) ? Math.max(0, this.proofOfWork.minDifficulty) : 0;
        return Math.max(required, floor);
    }
    miningOptions() {
        return { hashFactory: this.proofOfWork.hashFactory, timeoutMs: this.proofOfWork.timeoutMs };
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
    async prepareNDKEvent(event, signer, relayUrls) {
        const difficulty = await this.resolveProofOfWorkDifficulty(relayUrls);
        if (difficulty > 0) {
            this.proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relayUrls));
            await applyProofOfWork(event, signer, difficulty, { ...this.miningOptions(), signal: this.workAbort.signal });
        }
        else if (!event.sig)
            await event.sign(signer);
    }
    async prepareEvent(template, secretKey, relayUrls, options) {
        const difficulty = await this.resolveProofOfWorkDifficulty(relayUrls);
        if (difficulty > 0)
            this.proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relayUrls));
        return finalizeEvent(await mineEventTemplate(template, secretKey, difficulty, this.preparedMiningOptions(options)), secretKey);
    }
    /**
     * `prepareEvent` for a key held elsewhere: mines proof of work for `signer.pubkey` where the
     * relays ask for it, then has the signer sign the finished template.
     */
    async prepareEventWith(template, signer, relayUrls, options) {
        const difficulty = await this.resolveProofOfWorkDifficulty(relayUrls);
        if (difficulty > 0)
            this.proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relayUrls));
        const mined = await mineEventTemplateFor(template, signer.pubkey, difficulty, this.preparedMiningOptions(options));
        const signed = await signer.sign(mined);
        if (signed.pubkey !== signer.pubkey || !verifyEvent(signed))
            throw new Error("The signer returned an invalid event.");
        return signed;
    }
    preparedMiningOptions(options) {
        return {
            ...this.miningOptions(),
            ...options,
            signal: options?.signal ? AbortSignal.any([options.signal, this.workAbort.signal]) : this.workAbort.signal,
        };
    }
    /**
     * Signs (mining NIP-13 proof of work where relays ask for it) and publishes an event. When a
     * relay refuses it for too little work and names its target, the event is mined again to that
     * target and resent once: replaceable events go to every relay with a newer timestamp so the
     * stronger copy wins everywhere; other events go only to the relays that refused them.
     * `event` is updated in place to the copy that was last published.
     */
    async publishSigned(event, signer, relayUrls, options) {
        const relays = normalizeRelayUrls(relayUrls);
        await this.prepareNDKEvent(event, signer, relays);
        let result;
        let failure = null;
        try {
            result = await this.publishRaw(event.rawEvent(), { ...options, relayUrls: relays });
        }
        catch (error) {
            failure = error;
        }
        const achieved = /^[0-9a-f]{64}$/i.test(event.id || "") ? countLeadingZeroBits(event.id) : 0;
        const shortfall = relays.filter((relay) => (this.relayInfoCache.getLimits([relay]).minPowDifficulty ?? 0) > achieved);
        if (!shortfall.length) {
            if (failure)
                throw failure;
            return result;
        }
        const replaceable = event.isReplaceable();
        const targets = replaceable ? relays : shortfall;
        event.tags = event.tags.filter((tag) => tag[0] !== "nonce");
        event.sig = undefined;
        event.id = "";
        if (replaceable)
            event.created_at = Math.max(Math.floor(Date.now() / 1000), (event.created_at ?? 0) + 1);
        await this.prepareNDKEvent(event, signer, targets);
        return this.publishRaw(event.rawEvent(), { ...options, relayUrls: targets, skipIfIdentical: false });
    }
    createEvent(event) {
        return new NDKEvent(this.ndk, event);
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
                // NDK only samples signatures once a relay looks trustworthy. History reads decide
                // where messages are sent and whose profile is shown, so every event is checked here as
                // in SubscriptionManager. The ID is recorded only after the check, so a forged copy
                // cannot shadow the genuine event arriving from another relay.
                let signatureValid = false;
                try {
                    signatureValid = verifyEvent({ id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind, created_at: raw.created_at, tags: raw.tags, content: raw.content });
                }
                catch {
                    signatureValid = false;
                }
                if (!signatureValid)
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
    relayStatuses() {
        return Array.from(this.knownRelays).map((url) => {
            const relay = Array.from(this.ndk.pool.relays.values()).find((candidate) => normalizeRelayUrls([candidate.url])[0] === url);
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
    setupRelayHooks() {
        this.ndk.relayAuthDefaultPolicy = createRelayAuthPolicy(this.authManager, { timeoutMs: this.authTimeoutMs });
        this.ndk.pool.on("relay:connect", (relay) => {
            if (this.shuttingDown)
                return;
            this.relayHealth.markSuccess(relay.url);
            this.authManager.reset(relay.url);
            this.drainOutbox("relay:connect");
            this.logDebugSummary();
        });
        this.ndk.pool.on("relay:ready", (relay) => {
            if (this.shuttingDown)
                return;
            this.relayHealth.markSuccess(relay.url);
            this.drainOutbox("relay:ready");
        });
        this.ndk.pool.on("relay:disconnect", (relay) => {
            if (this.shuttingDown)
                return;
            this.relayHealth.markFailure(relay.url, { reason: "disconnect" });
            this.authManager.reset(relay.url);
            this.scheduleRelayConnect(relay.url);
        });
        this.ndk.pool.on("relay:authed", (relay) => {
            if (this.shuttingDown)
                return;
            this.authManager.markAuthed(relay);
            this.relayHealth.markSuccess(relay.url);
            this.drainOutbox("relay:authed");
        });
    }
    drainOutbox(reason) {
        // Relay lifecycle events can arrive in quick succession (connect, ready,
        // auth). Respect each row's persisted retry deadline so those events do not
        // bypass backoff and hammer a relay that just returned a partial result.
        void this.publisher.drainOutbox().catch((err) => {
            if (this.isDev)
                console.error("[nostr] outbox drain failed", reason, err);
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
        if (this.shuttingDown)
            return;
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
                            console.error("[nostr] relay reconnect failed", relayUrl, err);
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
        console.error("[nostr][debug] relay state", summary);
    }
}
