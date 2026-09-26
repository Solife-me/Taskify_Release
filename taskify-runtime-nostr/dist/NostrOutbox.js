import { normalizeRelayUrls } from "./relayUrls.js";
const REJECTION_FIRST_BACKOFF_MS = 60 * 60_000;
const REJECTION_MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
/** Records outright refusals: 1 hour after the first, doubling each time, capped at a week. */
export function recordOutboxRelayRejections(mutation, relayUrls, nowMs = Date.now()) {
    const relays = normalizeRelayUrls(relayUrls);
    if (!relays.length)
        return mutation;
    const rejections = { ...(mutation.relayRejections ?? {}) };
    for (const relay of relays) {
        const count = (rejections[relay]?.count ?? 0) + 1;
        const delay = Math.min(REJECTION_MAX_BACKOFF_MS, REJECTION_FIRST_BACKOFF_MS * 2 ** (count - 1));
        rejections[relay] = { count, retryAfter: nowMs + delay };
    }
    return { ...mutation, relayRejections: rejections };
}
/** When the earliest held-back relay may be retried, or null when none are held back. */
export function earliestRejectionRelease(mutation, nowMs = Date.now()) {
    let earliest = null;
    for (const relay of normalizeRelayUrls(mutation.pendingRelays)) {
        const retryAfter = mutation.relayRejections?.[relay]?.retryAfter;
        if (!retryAfter || retryAfter <= nowMs)
            continue;
        earliest = earliest == null ? retryAfter : Math.min(earliest, retryAfter);
    }
    return earliest;
}
export function cloneNostrEvent(event) {
    return {
        ...event,
        tags: Array.isArray(event.tags) ? event.tags.map((tag) => [...tag]) : [],
    };
}
export function createNostrOutboxMutation(args) {
    const nowMs = args.nowMs ?? Date.now();
    const relayUrls = normalizeRelayUrls(args.relayUrls);
    const existing = args.existing;
    const sameEvent = existing?.payload.event.id === args.event.id;
    const ackedRelays = sameEvent
        ? normalizeRelayUrls(existing.ackedRelays).filter((relay) => relayUrls.includes(relay))
        : [];
    const pendingRelays = relayUrls.filter((relay) => !ackedRelays.includes(relay));
    return {
        id: args.id,
        kind: "nostr.publish",
        payload: {
            event: cloneNostrEvent(args.event),
            relayUrls,
            replaceableKey: args.replaceableKey ?? null,
        },
        intentAt: sameEvent && existing ? existing.intentAt : nowMs,
        attempts: sameEvent && existing ? existing.attempts : 0,
        lastError: sameEvent && existing ? existing.lastError : null,
        ackedRelays,
        pendingRelays,
        nextAttemptAt: args.nextAttemptAt ?? null,
        updatedAt: nowMs,
        ...(sameEvent && existing?.relayRejections ? { relayRejections: existing.relayRejections } : {}),
        isRepublish: args.isRepublish ?? false,
    };
}
/**
 * Stops sending a board's republished rows anywhere but `keptRelayUrls` (Taskify's own relays).
 * A republish resends current state that other devices already have, but a row can still carry
 * the only copy of an edit it replaced in the queue, so rows are narrowed rather than dropped:
 * they still reach a kept relay, which every client reads. A row that targets none of the kept
 * relays is left untouched. Matches native `NostrOutboxStore.limitRepublishedEntries`.
 *
 * Rows from before `isRepublish` existed can't say which a republish queued, so there a burst of
 * at least `legacyBurstMinimum` rows for the board, queued no more than `legacyBurstGapMs` apart,
 * counts: ordinary edits never queue that many at once.
 */
export function narrowRepublishedMutations(rows, options) {
    const kept = new Set(normalizeRelayUrls([...options.keptRelayUrls]));
    const minimum = options.legacyBurstMinimum ?? 50;
    const gap = options.legacyBurstGapMs ?? 2_000;
    const boardRows = rows.filter((row) => row.payload.event.tags.some((tag) => tag[0] === "b" && tag[1] === options.boardTag));
    const legacy = boardRows.filter((row) => row.isRepublish === undefined).sort((a, b) => a.intentAt - b.intentAt);
    const legacyBurstIds = new Set();
    let run = [];
    const closeRun = () => {
        if (run.length >= minimum)
            run.forEach((row) => legacyBurstIds.add(row.id));
        run = [];
    };
    for (const row of legacy) {
        if (run.length && row.intentAt - run[run.length - 1].intentAt > gap)
            closeRun();
        run.push(row);
    }
    closeRun();
    const updated = [];
    const completedIds = [];
    for (const row of boardRows) {
        if (!(row.isRepublish === true || legacyBurstIds.has(row.id)))
            continue;
        const relays = normalizeRelayUrls(row.payload.relayUrls);
        if (!relays.some((relay) => kept.has(relay)))
            continue;
        const acked = new Set(normalizeRelayUrls(row.ackedRelays));
        const narrowed = relays.filter((relay) => kept.has(relay) || acked.has(relay));
        if (narrowed.length === relays.length)
            continue;
        const pendingRelays = narrowed.filter((relay) => !acked.has(relay));
        if (!pendingRelays.length) {
            completedIds.push(row.id);
            continue;
        }
        const relayRejections = row.relayRejections
            ? Object.fromEntries(Object.entries(row.relayRejections).filter(([relay]) => narrowed.includes(relay)))
            : undefined;
        updated.push({
            ...row,
            payload: { ...row.payload, relayUrls: narrowed },
            pendingRelays,
            ...(relayRejections ? { relayRejections } : {}),
        });
    }
    return { updated, completedIds };
}
/** The relays to send to now: still pending, and not held back after refusing the event. */
export function pendingRelayUrlsForMutation(mutation, nowMs = Date.now()) {
    const pending = normalizeRelayUrls(mutation.pendingRelays);
    const relays = pending.length ? pending : normalizeRelayUrls(mutation.payload.relayUrls);
    return relays.filter((relay) => !((mutation.relayRejections?.[relay]?.retryAfter ?? 0) > nowMs));
}
export function mergeOutboxRelayAcks(mutation, ackedRelays, nowMs = Date.now()) {
    const intendedRelays = normalizeRelayUrls(mutation.payload.relayUrls);
    const nextAcked = normalizeRelayUrls([...mutation.ackedRelays, ...ackedRelays]).filter((relay) => !intendedRelays.length || intendedRelays.includes(relay));
    if (!intendedRelays.length || intendedRelays.every((relay) => nextAcked.includes(relay))) {
        return null;
    }
    return {
        ...mutation,
        attempts: mutation.attempts + 1,
        lastError: null,
        ackedRelays: nextAcked,
        pendingRelays: intendedRelays.filter((relay) => !nextAcked.includes(relay)),
        nextAttemptAt: null,
        updatedAt: nowMs,
    };
}
export function markOutboxPublishFailure(args) {
    const nowMs = args.nowMs ?? Date.now();
    const intendedRelays = normalizeRelayUrls(args.mutation.payload.relayUrls);
    const nextAcked = normalizeRelayUrls([
        ...args.mutation.ackedRelays,
        ...(args.ackedRelays ?? []),
    ]).filter((relay) => !intendedRelays.length || intendedRelays.includes(relay));
    if (intendedRelays.length && intendedRelays.every((relay) => nextAcked.includes(relay))) {
        return null;
    }
    return {
        ...args.mutation,
        attempts: args.mutation.attempts + 1,
        lastError: errorToMessage(args.error),
        ackedRelays: nextAcked,
        pendingRelays: intendedRelays.length ? intendedRelays.filter((relay) => !nextAcked.includes(relay)) : [],
        nextAttemptAt: args.nextAttemptAt,
        updatedAt: nowMs,
    };
}
export function errorToMessage(error) {
    if (error instanceof Error && error.message)
        return error.message;
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return "Publish failed";
    }
}
