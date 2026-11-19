import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools";
import { createNostrOutboxMutation, cloneNostrEvent, recordOutboxRelayRejections, markOutboxPublishFailure, mergeOutboxRelayAcks, narrowRepublishedMutations, pendingOutboxRelays, outboxRelayRetry, outboxRelayRetryAt, errorToMessage, } from "./NostrOutbox.js";
import { MAX_PROOF_OF_WORK_DIFFICULTY, NostrProofOfWorkError, parseProofOfWorkRejection, satisfiesProofOfWork, signProofOfWorkVariant } from "./ProofOfWork.js";
import { FIRST_PARTY_RELAYS, RelayPublishBudget, classifyRelayRejection } from "./RelayPublishBudget.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import { RuntimeSessionClosedError } from "./sessionErrors.js";
export class NostrWriteQueuedError extends Error {
    code = "WRITE_QUEUED";
    retryable = true;
    constructor() {
        super("No relay acknowledged the write; it remains queued for retry.");
        this.name = "NostrWriteQueuedError";
    }
}
function signerFromInput(value) {
    if (!value)
        return undefined;
    if (typeof value === "string")
        return new NDKPrivateKeySigner(value);
    if (value instanceof Uint8Array) {
        const hex = Array.from(value)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        return new NDKPrivateKeySigner(hex);
    }
    return value;
}
function hashEventShape(event) {
    return JSON.stringify({
        kind: event.kind,
        content: event.content,
        tags: event.tags.filter(tag => tag[0] !== "nonce"),
    });
}
export class PublishCoordinator {
    replaceableCache = new Map();
    pending = new Map();
    closed = false;
    shutdownPromise = null;
    debounceDefault = 350;
    eventCache;
    resolveRelaySet;
    ndk;
    outboxStore;
    retryBaseMs;
    retryMaxMs;
    signal;
    recoverProofOfWorkSigner;
    knownProofOfWorkDifficulty;
    resolveProofOfWorkDifficulty;
    onMine;
    returnOnFirstAcknowledgement;
    backgroundPublishes = new Set();
    retrySigners = new Map();
    proofOfWork;
    onProofOfWorkRequired;
    activeOutboxIds = new Map();
    outboxLocks = new Map();
    relayDrains = new Map();
    relayRetryTimers = new Map();
    retryingRows = new Map();
    outboxMining = new Map();
    publishBudget;
    constructor(ndk, resolveRelaySet, cache, options) {
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
    buildReplaceableKey(event) {
        if (!event.isReplaceable())
            return null;
        const pubkey = event.pubkey || event.author?.pubkey || "";
        if (!pubkey)
            return null;
        const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
        if (event.isParamReplaceable())
            return `replaceable:${event.kind}:${pubkey}:${dTag}`;
        return `replaceable:${event.kind}:${pubkey}`;
    }
    async publishNow(event, relaySet, acknowledge) {
        const createdAt = event.created_at || Math.floor(Date.now() / 1000);
        const intendedRelays = relaySet ? relayUrlsFromRelaySet(relaySet) : [];
        let targetSet = relaySet;
        let notBefore = null;
        const attemptedRelays = [];
        if (this.publishBudget && intendedRelays.length) {
            const { ready, deferredUntil } = this.publishBudget.take(intendedRelays, Date.now());
            notBefore = deferredUntil;
            if (!ready.length) {
                return { createdAt, event: event.rawEvent(), ackedRelays: [], refusedRelays: [], notBefore, transientFailure: false };
            }
            attemptedRelays.push(...ready);
        }
        // NDK reports each relay's rejection as an event emission even when the publish as a whole
        // succeeds, and only throws when too few relays accepted.
        const relayErrors = new Map();
        const onRelayFailed = (relay, error) => {
            const url = normalizeRelayUrls([relay?.url || ""])[0];
            if (url)
                relayErrors.set(url, error);
        };
        const emitter = event;
        const onRelayPublished = (relay) => {
            const url = normalizeRelayUrls([relay?.url ?? ""])[0];
            if (url && (!intendedRelays.length || intendedRelays.includes(url)))
                acknowledge?.(url);
        };
        emitter.on?.("relay:publish:failed", onRelayFailed);
        if (acknowledge)
            emitter.on?.("relay:published", onRelayPublished);
        let publishedRelays;
        let thrown = null;
        try {
            if (this.publishBudget && targetSet && attemptedRelays.length < intendedRelays.length) {
                targetSet = await this.resolveRelaySetWithEnsure(attemptedRelays);
                if (!targetSet)
                    throw new NostrWriteQueuedError();
            }
            publishedRelays = await event.publish(targetSet);
        }
        catch (error) {
            thrown = error;
            publishedRelays = error?.publishedToRelays;
            const errors = error?.errors;
            // Without per-relay reasons there is nothing to classify: fail as before.
            if (!(errors instanceof Map))
                throw error;
            for (const [relay, relayError] of errors)
                onRelayFailed(relay, relayError);
        }
        finally {
            emitter.off?.("relay:publish:failed", onRelayFailed);
            if (acknowledge)
                emitter.off?.("relay:published", onRelayPublished);
            const releasedAt = Date.now();
            for (const relay of attemptedRelays)
                this.publishBudget?.release(relay, releasedAt);
        }
        const now = Date.now();
        const accepted = relayUrlsFromPublishResult(publishedRelays);
        for (const [url, relayError] of relayErrors) {
            if (!accepted.includes(url) && classifyRelayRejection(errorToMessageText(relayError)) === "superseded") {
                accepted.push(url);
            }
        }
        const refused = [];
        const proofOfWorkRequired = new Map();
        const rateLimited = [];
        let transientFailure = false;
        for (const [url, relayError] of relayErrors) {
            if (accepted.includes(url))
                continue;
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
                        !satisfiesProofOfWork(event.rawEvent(), required)) {
                        proofOfWorkRequired.set(url, required);
                        this.onProofOfWorkRequired?.(url, required);
                    }
                    else {
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
        for (const url of accepted)
            this.publishBudget?.recordAccepted(url, now);
        if (rateLimited.length && this.publishBudget) {
            const backoffUntil = this.publishBudget.nextAvailableAt(rateLimited, now);
            if (backoffUntil != null)
                notBefore = notBefore == null ? backoffUntil : Math.min(notBefore, backoffUntil);
        }
        const ackedRelays = normalizeRelayUrls(accepted);
        if (ackedRelays.length)
            acknowledge?.(ackedRelays[0]);
        const refusedRelays = normalizeRelayUrls(refused);
        // Relays still waiting on their budget or a rate-limit backoff will get the event from the
        // outbox shortly, so the write is queued rather than failed, even if every relay tried now
        // refused it or failed transiently. Fail only when no relay took it and none is pending.
        if (!ackedRelays.length && notBefore == null) {
            const failure = thrown ?? new NostrWriteQueuedError();
            // Carried to the outbox so a refusing relay is held back rather than retried at once.
            if (failure && typeof failure === "object")
                Object.assign(failure, { refusedRelays, proofOfWorkRequired });
            throw failure;
        }
        const raw = event.rawEvent();
        if (accepted.length)
            this.eventCache?.add(raw);
        return { createdAt, event: raw, ackedRelays, refusedRelays, notBefore, transientFailure, proofOfWorkRequired };
    }
    async resolveRelaySetWithEnsure(relayUrls) {
        return this.resolveRelaySet(normalizeRelayUrls(relayUrls || []));
    }
    scheduleDebouncedPublish(key, pending, delayMs) {
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.timer = setTimeout(() => void this.firePending(key, pending), delayMs);
    }
    /** Publishes a debounced event now and settles every caller waiting on it. */
    async firePending(key, pending) {
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.timer = null;
        try {
            const result = await this.publishForCaller(pending.event, pending.relaySet, pending.outboxId, pending.proofOfWorkSigner);
            pending.resolvers.forEach(({ resolve, returnEvent }) => resolve(returnEvent ? toPublicEventResult(result) : result.createdAt));
        }
        catch (error) {
            pending.rejecters.forEach((reject) => reject(error));
        }
        finally {
            if (this.pending.get(key) === pending)
                this.pending.delete(key);
        }
    }
    shouldSkipReplaceable(key, event, skipIfIdentical) {
        if (!skipIfIdentical)
            return false;
        const shape = hashEventShape(event);
        const prev = this.replaceableCache.get(key);
        if (prev === shape)
            return true;
        this.replaceableCache.set(key, shape);
        return false;
    }
    outboxMutationId(event, replaceableKey) {
        return replaceableKey ? `nostr:replaceable:${replaceableKey}` : `nostr:event:${event.id}`;
    }
    relayUrlsForPublish(relaySet, relayUrls) {
        const fromRelaySet = relaySet ? relayUrlsFromRelaySet(relaySet) : [];
        return normalizeRelayUrls(fromRelaySet.length ? fromRelaySet : relayUrls || []);
    }
    async outboxHasPending(id) {
        if (!this.outboxStore)
            return false;
        const mutation = await this.outboxStore.get(id).catch(() => undefined);
        return !!mutation;
    }
    withOutboxLock(id, work) {
        const previous = this.outboxLocks.get(id) || Promise.resolve();
        const operation = previous.catch(() => undefined).then(work);
        this.outboxLocks.set(id, operation);
        return operation.finally(() => {
            if (this.outboxLocks.get(id) === operation)
                this.outboxLocks.delete(id);
        });
    }
    async enqueueOutbox(args) {
        if (!this.outboxStore)
            return null;
        const id = this.outboxMutationId(args.event, args.replaceableKey);
        return this.withOutboxLock(id, async () => {
            const existing = await this.outboxStore.get(id).catch(() => undefined);
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
                await this.outboxStore.put(mutation);
            }
            catch (error) {
                if (args.replaceableKey)
                    this.replaceableCache.delete(args.replaceableKey);
                throw error;
            }
            return id;
        });
    }
    publishForCaller(event, relaySet, outboxId, signer) {
        if (!outboxId || !this.outboxStore || !this.returnOnFirstAcknowledgement) {
            return this.publishNowWithOutbox(event, relaySet, outboxId, signer);
        }
        const plain = event.rawEvent();
        let acknowledge;
        const first = new Promise(resolve => { acknowledge = resolve; });
        let sawAcknowledgement = false;
        const publish = this.publishNowWithOutbox(event, relaySet, outboxId, signer, relay => {
            if (sawAcknowledgement)
                return;
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
    async persistPartialAcknowledgements(id, eventId, relays) {
        await this.withOutboxLock(id, async () => {
            const current = await this.outboxStore.get(id);
            if (!current || current.payload.event.id !== eventId)
                return;
            const next = mergeOutboxRelayAcks(current, relays);
            if (next)
                await this.outboxStore.put({ ...next, attempts: current.attempts, nextAttemptAt: current.nextAttemptAt });
        });
    }
    async publishNowWithOutbox(event, relaySet, outboxId, signer, acknowledge) {
        const write = Symbol();
        if (outboxId) {
            this.activeOutboxIds.set(outboxId, write);
            if (signer) {
                this.retrySigners.delete(outboxId);
                this.retrySigners.set(outboxId, signer);
                if (this.retrySigners.size > 256)
                    this.retrySigners.delete(this.retrySigners.keys().next().value);
            }
        }
        try {
            const result = await this.publishByRelay(event, relaySet, outboxId, signer, acknowledge);
            if (outboxId) {
                await this.markOutboxSuccess(outboxId, result.ackedRelays, result.event.id, result.notBefore, result.refusedRelays, result.transientFailure);
            }
            return result;
        }
        catch (error) {
            if (outboxId)
                await this.markOutboxFailure(outboxId, error, event.id);
            throw error;
        }
        finally {
            if (outboxId && this.activeOutboxIds.get(outboxId) === write)
                this.activeOutboxIds.delete(outboxId);
        }
    }
    async publishByRelay(event, relaySet, outboxId, signer, acknowledge, retryRelay) {
        const relays = this.relayUrlsForPublish(relaySet);
        const plain = event.rawEvent();
        const row = outboxId ? await this.outboxStore?.get(outboxId) : undefined;
        if (outboxId && row?.payload.event.id !== plain.id)
            throw new NostrWriteQueuedError();
        const pending = row ? pendingOutboxRelays(row) : relays;
        const targets = relays.filter(relay => pending.includes(relay));
        if (retryRelay && !targets.includes(retryRelay))
            throw new NostrWriteQueuedError();
        if (!relays.length || (!this.knownProofOfWorkDifficulty && !this.resolveProofOfWorkDifficulty)) {
            return this.publishNow(event, relaySet, acknowledge);
        }
        const requirements = new Map(targets.map(relay => [relay, this.knownProofOfWorkDifficulty?.(relay) ?? 0]));
        const ordinary = targets.filter(relay => !requirements.get(relay));
        const aggregate = {
            createdAt: plain.created_at, event: plain, ackedRelays: [], refusedRelays: [],
            notBefore: null, transientFailure: false,
        };
        let failure;
        const submit = async (wireEvent, urls, set) => {
            try {
                const selected = set ?? await this.resolveRelaySetWithEnsure(urls);
                if (!selected)
                    throw new NostrWriteQueuedError();
                const result = await this.publishNow(wireEvent, selected, acknowledge);
                aggregate.ackedRelays.push(...result.ackedRelays);
                aggregate.refusedRelays.push(...result.refusedRelays);
                if (result.notBefore != null)
                    aggregate.notBefore = Math.min(aggregate.notBefore ?? Infinity, result.notBefore);
                aggregate.transientFailure ||= result.transientFailure;
                return result.proofOfWorkRequired;
            }
            catch (error) {
                failure = error;
                aggregate.ackedRelays.push(...relayUrlsFromPublishError(error));
                aggregate.refusedRelays.push(...(error?.refusedRelays ?? []));
                return error?.proofOfWorkRequired;
            }
        };
        if (ordinary.length) {
            const refused = await submit(event, ordinary, ordinary.length === relays.length ? relaySet : undefined);
            for (const [relay, difficulty] of refused ?? [])
                requirements.set(relay, difficulty);
        }
        // With a cold cache, ordinary delivery has already started. Only destinations that still
        // need a copy can affect this event's proof-of-work requirements.
        await Promise.all(targets.filter(relay => !requirements.get(relay) && !aggregate.ackedRelays.includes(relay))
            .map(async (relay) => {
            const difficulty = await this.resolveProofOfWorkDifficulty?.([relay]).catch(() => 0);
            if (difficulty)
                requirements.set(relay, difficulty);
        }));
        let variant = row?.payload.proofOfWorkEvent;
        let strict = targets.filter(relay => (requirements.get(relay) ?? 0) > 0 && !aggregate.ackedRelays.includes(relay));
        for (let attempt = 0; strict.length && attempt < 2; attempt += 1) {
            const required = Math.max(...strict.map(relay => requirements.get(relay)));
            const difficulty = retryRelay
                ? Math.max(required, ...pending.map(relay => this.knownProofOfWorkDifficulty?.(relay) ?? 0))
                : required;
            try {
                if (satisfiesProofOfWork(plain, difficulty)) {
                    variant = plain;
                }
                else if (!variant || !satisfiesProofOfWork(variant, difficulty)) {
                    if (signer?.pubkey !== plain.pubkey)
                        signer = row ? await this.recoverProofOfWorkSigner?.(row.payload) : undefined;
                    if (!signer)
                        throw new NostrProofOfWorkError("The original signer is required to prepare this relay's proof of work.");
                    variant = await this.mineVariant(plain, difficulty, signer, strict);
                }
                if (outboxId && this.outboxStore) {
                    const mined = variant;
                    const stored = await this.withOutboxLock(outboxId, async () => {
                        const current = await this.outboxStore.get(outboxId);
                        if (!current || current.payload.event.id !== plain.id ||
                            (retryRelay && !pendingOutboxRelays(current).includes(retryRelay)))
                            return undefined;
                        const existing = current.payload.proofOfWorkEvent;
                        const wireEvent = existing && satisfiesProofOfWork(existing, difficulty) ? existing : mined;
                        if (wireEvent === existing && !aggregate.ackedRelays.length)
                            return wireEvent;
                        const next = mergeOutboxRelayAcks(current, aggregate.ackedRelays);
                        if (!next)
                            return undefined;
                        await this.outboxStore.put({
                            ...next, attempts: current.attempts, nextAttemptAt: current.nextAttemptAt,
                            payload: { ...next.payload, proofOfWorkEvent: wireEvent },
                        });
                        return wireEvent;
                    });
                    if (!stored)
                        break;
                    variant = stored;
                }
                const refused = await submit(new NDKEvent(this.ndk, cloneNostrEvent(variant)), strict);
                strict = strict.filter(relay => refused?.has(relay) && !aggregate.ackedRelays.includes(relay));
                for (const relay of strict)
                    requirements.set(relay, refused.get(relay));
            }
            catch (error) {
                failure = error;
                aggregate.transientFailure = true;
                break;
            }
        }
        aggregate.refusedRelays = aggregate.refusedRelays.filter(relay => !aggregate.ackedRelays.includes(relay));
        if (!aggregate.ackedRelays.length && aggregate.notBefore == null) {
            const error = failure ?? new NostrWriteQueuedError();
            if (error && typeof error === "object")
                Object.assign(error, { refusedRelays: aggregate.refusedRelays });
            throw error;
        }
        return aggregate;
    }
    async mineVariant(event, difficulty, signer, relays) {
        const pending = this.outboxMining.get(event.id);
        if (pending) {
            const result = await pending.result;
            if (pending.difficulty >= difficulty)
                return result;
            return this.mineVariant(event, difficulty, signer, relays);
        }
        this.onMine?.(difficulty, relays);
        const result = signProofOfWorkVariant(event, difficulty, signer, { ...this.proofOfWork, signal: this.signal });
        this.outboxMining.set(event.id, { difficulty, result });
        try {
            return await result;
        }
        finally {
            this.outboxMining.delete(event.id);
        }
    }
    async markOutboxSuccess(outboxId, ackedRelays, eventId, notBefore = null, refusedRelays = [], transientFailure = false) {
        return this.withOutboxLock(outboxId, () => this.markOutboxSuccessLocked(outboxId, ackedRelays, eventId, notBefore, refusedRelays, transientFailure));
    }
    async markOutboxSuccessLocked(outboxId, ackedRelays, eventId, notBefore, refusedRelays, transientFailure) {
        if (!this.outboxStore)
            return;
        const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
        if (!mutation || mutation.payload.event.id !== eventId)
            return;
        const next = mergeOutboxRelayAcks(mutation, ackedRelays);
        if (!next) {
            await this.outboxStore.delete(outboxId).catch(() => undefined);
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
        await this.saveInitialRetry(base, pacedOnly ? now : now + this.retryDelayMs(next.attempts));
    }
    async markOutboxFailure(outboxId, error, eventId) {
        return this.withOutboxLock(outboxId, () => this.markOutboxFailureLocked(outboxId, error, eventId));
    }
    async markOutboxFailureLocked(outboxId, error, eventId) {
        if (!this.outboxStore)
            return;
        const mutation = await this.outboxStore.get(outboxId).catch(() => undefined);
        if (!mutation || mutation.payload.event.id !== eventId)
            return;
        const attempts = mutation.attempts + 1;
        const now = Date.now();
        const retryAt = now + this.retryDelayMs(attempts);
        const failed = markOutboxPublishFailure({
            mutation,
            error,
            ackedRelays: relayUrlsFromPublishError(error),
            nextAttemptAt: retryAt,
        });
        if (!failed) {
            await this.outboxStore.delete(outboxId).catch(() => undefined);
            this.retrySigners.delete(outboxId);
            return;
        }
        const refused = error?.refusedRelays ?? [];
        const next = recordOutboxRelayRejections(failed, refused, now);
        await this.saveInitialRetry(next, retryAt);
    }
    retryDelayMs(attempts) {
        const exponent = Math.max(0, attempts - 1);
        return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    }
    async saveInitialRetry(row, retryAt) {
        const now = Date.now();
        const pending = pendingOutboxRelays(row);
        const relayRetries = Object.fromEntries(pending.map(relay => [
            relay,
            {
                attempts: row.attempts,
                nextAttemptAt: Math.max(retryAt, this.publishBudget?.nextAvailableAt([relay], now) ?? 0),
            },
        ]));
        const updated = { ...row, relayRetries };
        const deadlines = pending.map(relay => outboxRelayRetryAt(updated, relay));
        await this.outboxStore.put({
            ...updated, nextAttemptAt: deadlines.length ? Math.min(...deadlines) : retryAt,
        }).catch(() => undefined);
        pending.forEach((relay, index) => this.scheduleRelayRetry(relay, deadlines[index]));
    }
    isDebouncedOutboxId(id) {
        for (const pending of this.pending.values()) {
            if (pending.outboxId === id && pending.timer)
                return true;
        }
        return false;
    }
    async drainOutbox(options) {
        if (this.closed || !this.outboxStore)
            return;
        const relayFilter = options?.relayUrl ? normalizeRelayUrls([options.relayUrl])[0] : undefined;
        if (options?.relayUrl && !relayFilter)
            return;
        const rows = await this.outboxStore.listPending();
        if (this.closed)
            return;
        const now = Date.now();
        const limit = options?.limit != null && Number.isFinite(options.limit) ? Math.max(0, options.limit) : rows.length;
        const jobsByRelay = new Map();
        let processed = 0;
        for (const row of rows.sort((a, b) => a.intentAt - b.intentAt)) {
            if (processed >= limit)
                break;
            if (this.activeOutboxIds.has(row.id) || this.isDebouncedOutboxId(row.id))
                continue;
            let selected = false;
            for (const relay of pendingOutboxRelays(row)) {
                if (relayFilter && relay !== relayFilter)
                    continue;
                const due = outboxRelayRetryAt(row, relay, options?.force);
                if (due > now) {
                    this.scheduleRelayRetry(relay, due);
                    continue;
                }
                const jobs = jobsByRelay.get(relay) ?? [];
                jobs.push({ id: row.id, eventId: row.payload.event.id, force: options?.force === true });
                jobsByRelay.set(relay, jobs);
                selected = true;
            }
            if (selected)
                processed += 1;
        }
        await Promise.all(Array.from(jobsByRelay, ([relay, jobs]) => this.enqueueRelayRetries(relay, jobs)));
    }
    enqueueRelayRetries(relay, jobs) {
        const active = this.relayDrains.get(relay);
        if (active) {
            for (const job of jobs) {
                if (active.current?.id === job.id && active.current.eventId === job.eventId)
                    continue;
                const previous = active.jobs.get(job.id);
                active.jobs.set(job.id, { ...job, force: job.force || (previous?.eventId === job.eventId && previous.force) });
            }
            return active.done;
        }
        const drain = { jobs: new Map(jobs.map(job => [job.id, job])), done: Promise.resolve() };
        this.relayDrains.set(relay, drain);
        drain.done = this.runRelayDrain(relay, drain).finally(() => {
            this.relayDrains.delete(relay);
        });
        return drain.done;
    }
    async runRelayDrain(relay, drain) {
        for (const job of drain.jobs.values()) {
            if (this.closed)
                return;
            const now = Date.now();
            const available = this.publishBudget?.nextAvailableAt([relay], now);
            if (available != null && available > now) {
                this.scheduleRelayRetry(relay, available);
                return;
            }
            drain.current = job;
            drain.jobs.delete(job.id);
            await this.retryOutboxMutation(job, relay);
            drain.current = undefined;
        }
    }
    scheduleRelayRetry(relay, at) {
        if (this.closed)
            return;
        const previous = this.relayRetryTimers.get(relay);
        if (previous && previous.at <= at)
            return;
        if (previous)
            clearTimeout(previous.timer);
        const timer = setTimeout(() => {
            this.relayRetryTimers.delete(relay);
            void this.drainOutbox({ relayUrl: relay }).catch(() => undefined);
        }, Math.max(0, at - Date.now()));
        this.relayRetryTimers.set(relay, { at, timer });
    }
    async retryOutboxMutation(job, relay) {
        const { id, eventId, force } = job;
        if (this.activeOutboxIds.has(id) || this.isDebouncedOutboxId(id))
            return;
        const row = await this.outboxStore.get(id).catch(() => undefined);
        if (this.closed || !row || row.payload.event.id !== eventId || !pendingOutboxRelays(row).includes(relay) ||
            this.activeOutboxIds.has(id) || this.isDebouncedOutboxId(id))
            return;
        const due = outboxRelayRetryAt(row, relay, force);
        if (due > Date.now()) {
            this.scheduleRelayRetry(relay, due);
            return;
        }
        this.retryingRows.set(id, (this.retryingRows.get(id) ?? 0) + 1);
        try {
            let result;
            let error;
            try {
                const set = await this.resolveRelaySetWithEnsure([relay]);
                if (!set)
                    throw new NostrWriteQueuedError();
                const event = new NDKEvent(this.ndk, cloneNostrEvent(row.payload.event));
                result = await this.publishByRelay(event, set, id, this.retrySigners.get(id), undefined, relay);
            }
            catch (failure) {
                error = failure;
            }
            await this.recordRelayRetry(job, relay, result, error);
        }
        finally {
            const remaining = (this.retryingRows.get(id) ?? 1) - 1;
            if (remaining)
                this.retryingRows.set(id, remaining);
            else
                this.retryingRows.delete(id);
        }
    }
    async recordRelayRetry(job, relay, result, error) {
        const { id, eventId } = job;
        await this.withOutboxLock(id, async () => {
            const current = await this.outboxStore.get(id);
            if (!current || current.payload.event.id !== eventId || !pendingOutboxRelays(current).includes(relay))
                return;
            const now = Date.now();
            const acked = (result?.ackedRelays ?? relayUrlsFromPublishError(error)).includes(relay);
            const next = mergeOutboxRelayAcks(current, acked ? [relay] : [], now);
            if (!next) {
                await this.outboxStore.delete(id);
                this.retrySigners.delete(id);
                return;
            }
            const pending = pendingOutboxRelays(next);
            // Seed older rows from their shared deadline once. Later retries only touch their own relay.
            const relayRetries = Object.fromEntries(pending.map(url => [url, outboxRelayRetry(current, url)]));
            let attempts = current.attempts;
            let updated = next;
            if (!acked) {
                const refused = (result?.refusedRelays ?? error?.refusedRelays ?? []).includes(relay);
                if (refused)
                    updated = recordOutboxRelayRejections(next, [relay], now);
                const paced = result?.notBefore != null && !result.transientFailure && !refused;
                const count = relayRetries[relay].attempts + (paced ? 0 : 1);
                const delayedUntil = result?.notBefore ?? 0;
                relayRetries[relay] = { attempts: count, nextAttemptAt: paced ? delayedUntil : Math.max(delayedUntil, now + this.retryDelayMs(count)) };
                attempts = Math.max(attempts, count);
            }
            const scoped = { ...updated, relayRetries, attempts, lastError: error ? errorToMessage(error) : current.lastError };
            const nextAttemptAt = Math.min(...pending.map(url => outboxRelayRetryAt(scoped, url)));
            await this.outboxStore.put({ ...scoped, nextAttemptAt: nextAttemptAt || null });
            if (!acked)
                this.scheduleRelayRetry(relay, outboxRelayRetryAt(scoped, relay));
        }).catch(() => {
            this.scheduleRelayRetry(relay, Date.now() + this.retryBaseMs);
        });
    }
    /**
     * Stops sending a board's queued republish to public relays; it still reaches `keptRelayUrls`
     * (Taskify's own relays by default). Returns how many queued rows changed.
     */
    async limitQueuedRepublish(boardTag, keptRelayUrls = FIRST_PARTY_RELAYS) {
        if (!this.outboxStore)
            return 0;
        const rows = await this.outboxStore.listPending();
        const { updated, completedIds } = narrowRepublishedMutations(rows, { boardTag, keptRelayUrls });
        const affected = new Set([...updated.map(row => row.id), ...completedIds]);
        let changed = 0;
        for (const row of rows) {
            if (!affected.has(row.id))
                continue;
            await this.withOutboxLock(row.id, async () => {
                if (this.activeOutboxIds.has(row.id) || this.retryingRows.has(row.id))
                    return;
                const current = await this.outboxStore.get(row.id).catch(() => undefined);
                if (!current || current.payload.event.id !== row.payload.event.id)
                    return;
                // The snapshot determined which legacy rows belong to the republish. Apply that
                // decision to the current row so any receipts saved since the scan survive.
                const narrowed = narrowRepublishedMutations([{ ...current, isRepublish: true }], { boardTag, keptRelayUrls });
                if (narrowed.completedIds.length) {
                    await this.outboxStore.delete(row.id);
                    this.retrySigners.delete(row.id);
                }
                else if (narrowed.updated.length) {
                    await this.outboxStore.put({ ...narrowed.updated[0], isRepublish: current.isRepublish });
                }
                else {
                    return;
                }
                changed += 1;
            });
        }
        return changed;
    }
    /**
     * Terminal. Debounced publishes still waiting are sent now, so their callers get the real
     * result rather than a promise that never settles; retries stop; later publishes fail with
     * `RuntimeSessionClosedError`. Idempotent: later calls wait for the first.
     */
    shutdown() {
        if (this.shutdownPromise)
            return this.shutdownPromise;
        this.closed = true;
        for (const { timer } of this.relayRetryTimers.values())
            clearTimeout(timer);
        this.relayRetryTimers.clear();
        const waiting = Array.from(this.pending.entries());
        this.shutdownPromise = Promise.all(waiting.map(([key, pending]) => this.firePending(key, pending))).then(async () => {
            await Promise.allSettled([...this.backgroundPublishes, ...Array.from(this.relayDrains.values(), drain => drain.done)]);
            this.pending.clear();
            this.retrySigners.clear();
        });
        return this.shutdownPromise;
    }
    async publish(templateOrEvent, options) {
        if (this.closed)
            throw new RuntimeSessionClosedError("publish");
        const relaySet = await this.resolveRelaySetWithEnsure(options?.relayUrls);
        const signer = signerFromInput(options?.signer) ?? (templateOrEvent instanceof NDKEvent && templateOrEvent.sig ? undefined : this.ndk.signer);
        const relayUrls = this.relayUrlsForPublish(relaySet, options?.relayUrls);
        const event = templateOrEvent instanceof NDKEvent
            ? templateOrEvent
            : new NDKEvent(this.ndk, {
                kind: templateOrEvent.kind,
                content: templateOrEvent.content || "",
                tags: templateOrEvent.tags || [],
                created_at: templateOrEvent.created_at || Math.floor(Date.now() / 1000),
            });
        if (!event.created_at)
            event.created_at = Math.floor(Date.now() / 1000);
        if (!event.sig)
            await event.sign(signer);
        const raw = event.rawEvent();
        const proofOfWorkSigner = options?.proofOfWorkSigner ?? (signer && (await signer.user()).pubkey === raw.pubkey ? {
            pubkey: raw.pubkey,
            sign: async (template) => {
                const id = getEventHash({ ...template, pubkey: raw.pubkey });
                const sig = await signer.sign({ ...template, pubkey: raw.pubkey, id });
                return { ...template, pubkey: raw.pubkey, id, sig };
            },
        } : undefined);
        const replaceableKey = options?.replaceableKey || this.buildReplaceableKey(event) || (event.isReplaceable() ? event.deduplicationKey() : null);
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
                return new Promise((resolve, reject) => {
                    existing.resolvers.push({ resolve, returnEvent: !!options?.returnEvent });
                    existing.rejecters.push(reject);
                });
            }
            const pending = { event, relaySet, outboxId: queuedOutboxId, proofOfWorkSigner, resolvers: [], rejecters: [], timer: null };
            this.pending.set(replaceableKey, pending);
            this.scheduleDebouncedPublish(replaceableKey, pending, delay);
            return new Promise((resolve, reject) => {
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
    async publishRaw(event, options) {
        const ndkEvent = new NDKEvent(this.ndk, event);
        return this.publish(ndkEvent, options);
    }
}
function toPublicEventResult(result) {
    return { createdAt: result.createdAt, event: result.event };
}
function relayUrlsFromRelaySet(relaySet) {
    const relayUrls = relaySet.relayUrls;
    if (Array.isArray(relayUrls))
        return normalizeRelayUrls(relayUrls);
    const relays = relaySet.relays;
    if (relays instanceof Set) {
        return normalizeRelayUrls(Array.from(relays).map((relay) => relay.url || ""));
    }
    return [];
}
function relayUrlsFromPublishResult(value) {
    if (!(value instanceof Set))
        return [];
    return normalizeRelayUrls(Array.from(value).map((relay) => relay.url || ""));
}
function relayUrlsFromPublishError(error) {
    const publishedToRelays = error?.publishedToRelays;
    if (!(publishedToRelays instanceof Set))
        return [];
    return relayUrlsFromPublishResult(publishedToRelays);
}
function errorToMessageText(error) {
    if (error instanceof Error)
        return error.message;
    return typeof error === "string" ? error : "";
}
