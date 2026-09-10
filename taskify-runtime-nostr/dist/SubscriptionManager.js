import { verifyEvent, matchFilter } from "nostr-tools";
import { normalizeRelayUrls } from "./relayUrls.js";
const MAX_SEEN_IDS = 4096;
const FLUSH_BATCH_SIZE = 64;
function scheduleFrame(fn) {
    if (typeof requestAnimationFrame === "function" && (typeof document === "undefined" || document.visibilityState !== "hidden"))
        requestAnimationFrame(fn);
    else
        setTimeout(fn, 0);
}
function uniqueSorted(values, sortFn) {
    const set = new Set(values);
    return Array.from(set).sort(sortFn);
}
function normalizeFilter(filter) {
    const normalized = {};
    Object.entries(filter).forEach(([key, value]) => {
        if (value == null)
            return;
        if (key === "kinds" && Array.isArray(value)) {
            normalized.kinds = uniqueSorted(value.filter((v) => typeof v === "number"), (a, b) => a - b);
        }
        else if (key === "authors" && Array.isArray(value)) {
            normalized.authors = uniqueSorted(value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean));
        }
        else if (key.startsWith("#") && Array.isArray(value)) {
            normalized[key] = uniqueSorted(value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean));
        }
        else if (key === "since" || key === "until" || key === "limit") {
            const num = Number(value);
            if (Number.isFinite(num))
                normalized[key] = num;
        }
        else {
            normalized[key] = value;
        }
    });
    return normalized;
}
function stableStringify(filter) {
    const ordered = {};
    Object.keys(filter).sort().forEach((key) => {
        const value = filter[key];
        ordered[key] = Array.isArray(value) ? value.slice() : value;
    });
    return JSON.stringify(ordered);
}
export class SubscriptionManager {
    ndk;
    cursorStore;
    eventCache;
    resolveRelaySet;
    relayLimitResolver;
    subs = new Map();
    constructor(ndk, cursorStore, resolveRelaySet, eventCache, relayLimitResolver) {
        this.ndk = ndk;
        this.cursorStore = cursorStore;
        this.resolveRelaySet = resolveRelaySet;
        this.eventCache = eventCache;
        this.relayLimitResolver = relayLimitResolver;
    }
    async clampFilters(filters, relayUrls) {
        if (!this.relayLimitResolver || !relayUrls.length)
            return filters;
        try {
            const maxLimit = await this.relayLimitResolver(relayUrls);
            const safeLimit = Number.isFinite(maxLimit) && maxLimit ? maxLimit : 5000;
            return filters.map((f) => (f.limit && f.limit > safeLimit ? { ...f, limit: safeLimit } : f));
        }
        catch {
            return filters;
        }
    }
    async normalizeFilters(filters, relayUrls, skipSince) {
        const normalized = await this.clampFilters(filters.map((f) => {
            const nf = normalizeFilter(f);
            if (!skipSince && nf.since == null) {
                const since = this.cursorStore.getSince(nf, relayUrls);
                if (since)
                    nf.since = since;
            }
            return nf;
        }), relayUrls);
        const signature = normalized.map((f) => stableStringify(f)).sort().join("|");
        return { normalized, key: `${relayUrls.join(",")}|${signature}` };
    }
    scheduleFlush(state) {
        if (state.flushScheduled)
            return;
        state.flushScheduled = true;
        scheduleFrame(() => this.flushPending(state));
    }
    scheduleEoseFlush(state) {
        if (state.eoseFlushScheduled)
            return;
        state.eoseFlushScheduled = true;
        scheduleFrame(() => this.flushEose(state));
    }
    flushPending(state) {
        state.flushScheduled = false;
        if (this.subs.get(state.key) !== state)
            return;
        const batch = state.pendingEvents.splice(0, FLUSH_BATCH_SIZE);
        for (const { raw, relayUrl } of batch) {
            state.handlers.forEach((h) => {
                try {
                    h.onEvent?.(raw, relayUrl);
                }
                catch { }
            });
            for (const filter of state.filters.filter((filter) => matchFilter(filter, raw))) {
                const key = this.cursorStore.keyFor(filter);
                const newest = Math.max(state.pendingCursors.get(key)?.createdAt || 0, raw.created_at);
                state.pendingCursors.set(key, { filter, createdAt: newest });
                if (state.historyComplete)
                    this.cursorStore.update(filter, newest, state.relayUrls);
            }
        }
        if (state.pendingEvents.length > 0)
            this.scheduleFlush(state);
        else if (state.pendingEoseRelays.length > 0)
            this.scheduleEoseFlush(state);
    }
    flushEose(state) {
        state.eoseFlushScheduled = false;
        if (state.pendingEvents.length > 0) {
            this.scheduleFlush(state);
            return;
        }
        if (this.subs.get(state.key) !== state)
            return;
        state.historyComplete = true;
        for (const { filter, createdAt } of state.pendingCursors.values()) {
            this.cursorStore.update(filter, createdAt, state.relayUrls);
        }
        const relays = state.pendingEoseRelays.splice(0);
        for (const relayUrl of relays) {
            state.handlers.forEach((h) => {
                try {
                    h.onEose?.(relayUrl);
                }
                catch { }
            });
        }
    }
    async subscribe(filtersInput, options) {
        const filters = Array.isArray(filtersInput) ? filtersInput : [filtersInput];
        const relayUrls = normalizeRelayUrls(options?.relayUrls || []);
        const { normalized, key } = await this.normalizeFilters(filters, relayUrls, options?.skipSince);
        const existing = this.subs.get(key);
        const handler = { onEvent: options?.onEvent, onEose: options?.onEose };
        if (existing) {
            existing.refCount += 1;
            existing.handlers.add(handler);
            return { key, subscription: existing.subscription, release: () => this.release(key, handler), filters: existing.filters, relayUrls: existing.relayUrls };
        }
        const relaySet = await this.resolveRelaySet(relayUrls);
        // Another caller can finish the same asynchronous relay lookup first.
        const raced = this.subs.get(key);
        if (raced) {
            raced.refCount += 1;
            raced.handlers.add(handler);
            return { key, subscription: raced.subscription, release: () => this.release(key, handler), filters: raced.filters, relayUrls: raced.relayUrls };
        }
        const opts = { ...options?.opts, closeOnEose: options?.opts?.closeOnEose ?? false, relaySet };
        const state = {
            key,
            subscription: null,
            filters: normalized,
            relayUrls,
            handlers: new Set(handler.onEvent || handler.onEose ? [handler] : []),
            refCount: 1,
            seenIds: new Set(),
            pendingEvents: [],
            flushScheduled: false,
            pendingEoseRelays: [],
            eoseFlushScheduled: false,
            historyComplete: false,
            pendingCursors: new Map(),
        };
        this.subs.set(key, state);
        const sub = this.ndk.subscribe(normalized, opts);
        state.subscription = sub;
        sub.on("event", (evt) => {
            let raw;
            try {
                raw = evt.rawEvent();
            }
            catch {
                return;
            }
            if (!raw?.id || typeof raw.id !== "string")
                return;
            if (state.seenIds.has(raw.id))
                return;
            if (!state.filters.some((filter) => matchFilter(filter, raw)))
                return;
            // NDK's built-in verification is probabilistic per relay (validation
            // ratio drops as relays prove trustworthy) and in async mode events
            // emit to subscribers before verification settles — so forged events
            // can reach handlers. Verifying here is deterministic and synchronous.
            let signatureValid = false;
            try {
                signatureValid = verifyEvent({ id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind, created_at: raw.created_at, tags: raw.tags, content: raw.content });
            }
            catch {
                signatureValid = false;
            }
            if (!signatureValid) {
                try {
                    console.warn("[nostr] dropping event with invalid signature", raw.id, "from", evt.relay?.url);
                }
                catch { }
                return;
            }
            state.seenIds.add(raw.id);
            if (state.seenIds.size > MAX_SEEN_IDS) {
                const [oldest] = state.seenIds;
                if (oldest)
                    state.seenIds.delete(oldest);
            }
            this.eventCache?.add(raw);
            state.pendingEvents.push({ raw, relayUrl: evt.relay?.url });
            this.scheduleFlush(state);
        });
        sub.on("eose", (relay) => {
            const relayUrl = relay && typeof relay === "object" && "url" in relay ? relay.url : undefined;
            state.pendingEoseRelays.push(relayUrl);
            if (state.pendingEvents.length > 0)
                this.scheduleFlush(state);
            else
                this.scheduleEoseFlush(state);
        });
        return { key, subscription: sub, release: () => this.release(key, handler), filters: normalized, relayUrls };
    }
    release(key, handler) {
        const state = this.subs.get(key);
        if (!state)
            return;
        if (handler)
            state.handlers.delete(handler);
        state.refCount -= 1;
        if (state.refCount > 0)
            return;
        try {
            state.subscription.stop();
        }
        catch { }
        this.subs.delete(key);
    }
    shutdown() {
        for (const [key, state] of this.subs) {
            try {
                state.subscription.stop();
            }
            catch { }
            this.subs.delete(key);
        }
    }
}
