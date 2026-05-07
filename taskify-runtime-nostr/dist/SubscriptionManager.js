import { verifyEvent } from "nostr-tools";
import { normalizeRelayUrls } from "./relayUrls.js";
const MAX_SEEN_IDS = 4096;
const FLUSH_BATCH_SIZE = 64;
function scheduleFrame(fn) {
    if (typeof requestAnimationFrame === "function")
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
                const since = this.cursorStore.getSince(nf);
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
    flushPending(state) {
        state.flushScheduled = false;
        const batch = state.pendingEvents.splice(0, FLUSH_BATCH_SIZE);
        for (const { raw, relayUrl } of batch) {
            state.handlers.forEach((h) => {
                try {
                    h.onEvent?.(raw, relayUrl);
                }
                catch { }
            });
        }
        if (state.pendingEvents.length > 0)
            this.scheduleFlush(state);
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
            // NDK's built-in verification is probabilistic per relay (validation
            // ratio drops as relays prove trustworthy) and in async mode events
            // emit to subscribers before verification settles — so forged events
            // can reach handlers. Verifying here is deterministic and synchronous.
            let signatureValid = false;
            try {
                signatureValid = verifyEvent(raw);
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
            if (raw.created_at && Number.isFinite(raw.created_at))
                this.cursorStore.updateMany(state.filters, raw.created_at);
            state.pendingEvents.push({ raw, relayUrl: evt.relay?.url });
            this.scheduleFlush(state);
        });
        sub.on("eose", (relay) => {
            const relayUrl = relay && typeof relay === "object" && "url" in relay ? relay.url : undefined;
            // Drain all buffered events synchronously before notifying EOSE handlers.
            // Events are queued in pendingEvents and delivered via requestAnimationFrame
            // (FLUSH_BATCH_SIZE at a time). Without this drain, EOSE fires while
            // hundreds of events are still pending — the batch flush happens on partial
            // data, and the remaining events arrive post-flush as "live" individual
            // updates. This causes old tasks to temporarily appear (out-of-order CREATE
            // events without their DELETE counterparts) before being corrected, producing
            // the ~15-30 second flicker of stale state.
            if (state.pendingEvents.length > 0) {
                state.flushScheduled = false;
                const remaining = state.pendingEvents.splice(0);
                for (const { raw, relayUrl: evRelayUrl } of remaining) {
                    state.handlers.forEach((h) => {
                        try {
                            h.onEvent?.(raw, evRelayUrl);
                        }
                        catch { }
                    });
                }
            }
            state.handlers.forEach((h) => {
                try {
                    h.onEose?.(relayUrl);
                }
                catch { }
            });
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
