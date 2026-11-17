import { NDKEvent, NDKPrivateKeySigner, NDKRelaySet } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools";
import { RelayInfoCache } from "./RelayInfoCache.js";
import { RelayAuthManager, createRelayAuthPolicy } from "./RelayAuth.js";
import { applyProofOfWork, MAX_PROOF_OF_WORK_DIFFICULTY, parseProofOfWorkRejection, satisfiesProofOfWork, signProofOfWorkVariant } from "./ProofOfWork.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import { installNdkRelayTimerFix } from "./ndkLifecycle.js";
import { classifyRelayRejection, takeWhenPublishSlotIsAvailable, } from "./RelayPublishBudget.js";
let relayInfoCache = new RelayInfoCache();
let proofOfWork = {};
let authTimeoutMs;
/**
 * Settings for clients that talk to relays outside a `RuntimeNostrSession` (profile and contact
 * updates, one-off lookups). A CLI passes its persistent relay-info cache here so NIP-11 limits
 * and learned proof-of-work targets carry over between runs.
 */
export function configureStandaloneRelayAccess(options) {
    if (options.relayInfoCache)
        relayInfoCache = options.relayInfoCache;
    if (options.proofOfWork)
        proofOfWork = options.proofOfWork;
    if (options.authTimeoutMs !== undefined)
        authTimeoutMs = options.authTimeoutMs;
}
export async function relayProofOfWorkDifficulty(relays) {
    const targets = normalizeRelayUrls(relays);
    await Promise.all(targets.map(relay => relayInfoCache.prime(relay, async (url) => {
        const response = await fetch(url, {
            headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5_000),
        });
        return response.ok ? await response.json() : null;
    })));
    return knownRelayProofOfWorkDifficulty(targets);
}
function knownRelayProofOfWorkDifficulty(targets) {
    const floor = Number.isInteger(proofOfWork.minDifficulty) ? Math.max(0, proofOfWork.minDifficulty) : 0;
    return Math.max(relayInfoCache.getLimits(targets).minPowDifficulty, floor);
}
/** Records a relay's `pow:` rejection so later writes are mined to its target. */
export function recordRelayProofOfWorkRejection(relayUrl, message) {
    const required = parseProofOfWorkRejection(message);
    if (required == null || required > MAX_PROOF_OF_WORK_DIFFICULTY)
        return null;
    relayInfoCache.recordProofOfWorkRequirement(relayUrl, required);
    return required;
}
/** Standalone clients share the same auth policy; anonymous reads use an ephemeral key. */
export function configureRelayAccess(ndk, secretKeyHex) {
    // NDK's relays already exist by now; this covers relays it adds later, and any pool made after.
    installNdkRelayTimerFix();
    const signer = secretKeyHex ? new NDKPrivateKeySigner(secretKeyHex) : NDKPrivateKeySigner.generate();
    const manager = new RelayAuthManager(ndk, { loadSecretKeyHex: () => signer.privateKey ?? null });
    ndk.relayAuthDefaultPolicy = createRelayAuthPolicy(manager, { timeoutMs: authTimeoutMs });
    ndk.pool.on("relay:connect", relay => manager.reset(relay.url));
    ndk.pool.on("relay:disconnect", relay => manager.reset(relay.url));
}
export async function prepareStandaloneEvent(event, relays) {
    const signer = event.ndk?.signer;
    if (!signer)
        throw new Error("A signing identity is required.");
    const difficulty = await relayProofOfWorkDifficulty(relays);
    if (difficulty > 0) {
        proofOfWork.onMine?.(difficulty, normalizeRelayUrls(relays));
        await applyProofOfWork(event, signer, difficulty, { hashFactory: proofOfWork.hashFactory, timeoutMs: proofOfWork.timeoutMs });
    }
    else
        await event.sign(signer);
}
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return typeof error === "string" ? error : "";
}
async function publishCollectingProofOfWorkRefusals(event, relaySet) {
    const rejections = new Map();
    const note = (relay, error) => {
        const url = normalizeRelayUrls([relay?.url ?? ""])[0];
        if (!url)
            return;
        const message = messageOf(error);
        rejections.set(url, message);
    };
    const emitter = event;
    emitter.on?.("relay:publish:failed", note);
    try {
        return { published: await event.publish(relaySet), failure: null, rejections };
    }
    catch (error) {
        const errors = error?.errors;
        if (errors instanceof Map)
            for (const [relay, relayError] of errors)
                note(relay, relayError);
        return { failure: error, published: error?.publishedToRelays, rejections };
    }
    finally {
        emitter.off?.("relay:publish:failed", note);
    }
}
function recordPublishBudgetResult(budget, result, now, attemptedRelays) {
    if (!budget)
        return;
    for (const relay of attemptedRelays)
        budget.release(relay, now);
    const accepted = new Set(Array.from(result.published ?? []).map((relay) => relay.url));
    for (const relay of accepted)
        budget.recordAccepted(relay, now);
    for (const [relay, message] of result.rejections) {
        if (accepted.has(relay))
            continue;
        const kind = classifyRelayRejection(message);
        if (kind === "rate-limited")
            budget.recordRateLimited(relay, now);
        else if (kind === "banned")
            budget.recordBanned(relay, now);
    }
}
/** Relay-specific delivery for one-shot clients, where there is no durable publisher. */
export async function publishWithRelayProofOfWork(original, relays, signer, submit, settings = proofOfWork) {
    const targets = normalizeRelayUrls(relays);
    const requirements = new Map(targets.map(relay => [relay, knownRelayProofOfWorkDifficulty([relay])]));
    const accepted = new Set();
    let failure;
    const send = async (event, urls) => {
        try {
            const result = await submit(event, urls);
            for (const relay of normalizeRelayUrls(result.accepted))
                accepted.add(relay);
            for (const [relay, reason] of result.rejections) {
                const url = normalizeRelayUrls([relay])[0];
                if (!urls.includes(url) || accepted.has(url))
                    continue;
                const required = parseProofOfWorkRejection(reason);
                if (required == null || satisfiesProofOfWork(event, required))
                    continue;
                if (recordRelayProofOfWorkRejection(url, reason) != null)
                    requirements.set(url, required);
            }
        }
        catch (error) {
            failure = error;
        }
    };
    const ordinary = targets.filter(relay => !requirements.get(relay));
    if (ordinary.length)
        await send(original, ordinary);
    await Promise.all(ordinary.filter(relay => !requirements.get(relay) && !accepted.has(relay)).map(async (relay) => {
        requirements.set(relay, await relayProofOfWorkDifficulty([relay]));
    }));
    let strict = targets.filter(relay => requirements.get(relay) > 0 && !accepted.has(relay));
    for (let attempt = 0; attempt < 2 && strict.length; attempt += 1) {
        const difficulty = Math.max(...strict.map(relay => requirements.get(relay)));
        try {
            settings.onMine?.(difficulty, strict);
            const variant = await signProofOfWorkVariant(original, difficulty, signer, settings);
            await send(variant, strict);
            strict = strict.filter(relay => !accepted.has(relay) && requirements.get(relay) > difficulty);
        }
        catch (error) {
            failure = error;
            break;
        }
    }
    if (!accepted.size)
        throw failure ?? new Error("No relay accepted the event.");
}
/** Signs the original in place and uses relay-specific proof for one-off writes. */
export async function publishStandaloneEvent(event, relays, publishBudget) {
    const ndk = event.ndk;
    if (!ndk)
        throw new Error("The event is not attached to a relay pool.");
    const signer = ndk.signer;
    if (!signer)
        throw new Error("A signing identity is required.");
    await event.sign(signer);
    const original = event.rawEvent();
    const accepted = new Set();
    const attempted = new Set();
    const sign = async (template) => {
        const id = getEventHash({ ...template, pubkey: original.pubkey });
        const sig = await signer.sign({ ...template, pubkey: original.pubkey, id });
        return { ...template, pubkey: original.pubkey, id, sig };
    };
    await publishWithRelayProofOfWork(original, relays, { pubkey: original.pubkey, sign }, async (wireEvent, urls) => {
        const selection = publishBudget && (urls.some(relay => attempted.has(relay))
            ? await takeWhenPublishSlotIsAvailable(publishBudget, urls) : publishBudget.take(urls, Date.now()));
        const targets = selection ? selection.ready : urls;
        if (!targets.length) {
            const wait = selection && selection.deferredUntil != null ? new Date(selection.deferredUntil).toISOString() : "later";
            throw new Error(`All target relays are being paced; the next publish slot is ${wait}.`);
        }
        targets.forEach(relay => attempted.add(relay));
        const outbound = wireEvent.id === original.id ? event : new NDKEvent(ndk, wireEvent);
        const result = await publishCollectingProofOfWorkRefusals(outbound, NDKRelaySet.fromRelayUrls(targets, ndk));
        recordPublishBudgetResult(publishBudget, result, Date.now(), targets);
        for (const relay of result.published ?? [])
            accepted.add(relay);
        if (!result.rejections.size && !result.published?.size && result.failure)
            throw result.failure;
        return { accepted: Array.from(result.published ?? []).map(relay => relay.url), rejections: result.rejections };
    });
    return accepted;
}
