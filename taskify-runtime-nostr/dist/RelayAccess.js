import { NDKPrivateKeySigner, NDKRelaySet } from "@nostr-dev-kit/ndk";
import { RelayInfoCache } from "./RelayInfoCache.js";
import { RelayAuthManager, createRelayAuthPolicy } from "./RelayAuth.js";
import { applyProofOfWork, countLeadingZeroBits, parseProofOfWorkRejection } from "./ProofOfWork.js";
import { normalizeRelayUrls } from "./relayUrls.js";
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
    const floor = Number.isInteger(proofOfWork.minDifficulty) ? Math.max(0, proofOfWork.minDifficulty) : 0;
    return Math.max(relayInfoCache.getLimits(targets).minPowDifficulty, floor);
}
/** Records a relay's `pow:` rejection so later writes are mined to its target. */
export function recordRelayProofOfWorkRejection(relayUrl, message) {
    const required = parseProofOfWorkRejection(message);
    if (required != null)
        relayInfoCache.recordProofOfWorkRequirement(relayUrl, required);
    return required;
}
/** Standalone clients share the same auth policy; anonymous reads use an ephemeral key. */
export function configureRelayAccess(ndk, secretKeyHex) {
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
    const refusals = new Map();
    const note = (relay, error) => {
        const url = relay?.url;
        if (!url)
            return;
        const required = recordRelayProofOfWorkRejection(url, messageOf(error));
        if (required != null)
            refusals.set(url, required);
    };
    const emitter = event;
    emitter.on?.("relay:publish:failed", note);
    try {
        return { published: await event.publish(relaySet), failure: null, refusals };
    }
    catch (error) {
        const errors = error?.errors;
        if (errors instanceof Map)
            for (const [relay, relayError] of errors)
                note(relay, relayError);
        return { failure: error, refusals };
    }
    finally {
        emitter.off?.("relay:publish:failed", note);
    }
}
/**
 * Signs (with proof of work where relays ask for it) and publishes an event from a standalone
 * NDK instance. A relay that refuses it for too little work and names a target gets one
 * re-mined copy, as `RuntimeNostrSession.publishSigned` does.
 */
export async function publishStandaloneEvent(event, relays) {
    const ndk = event.ndk;
    if (!ndk)
        throw new Error("The event is not attached to a relay pool.");
    await prepareStandaloneEvent(event, relays);
    const first = await publishCollectingProofOfWorkRefusals(event, undefined);
    const achieved = /^[0-9a-f]{64}$/i.test(event.id || "") ? countLeadingZeroBits(event.id) : 0;
    const shortfall = Array.from(first.refusals).filter(([, required]) => required > achieved).map(([url]) => url);
    if (!shortfall.length) {
        if (first.failure)
            throw first.failure;
        return first.published ?? new Set();
    }
    const replaceable = event.isReplaceable();
    const targets = replaceable ? normalizeRelayUrls(relays) : normalizeRelayUrls(shortfall);
    event.tags = event.tags.filter(tag => tag[0] !== "nonce");
    event.sig = undefined;
    event.id = "";
    if (replaceable)
        event.created_at = Math.max(Math.floor(Date.now() / 1000), (event.created_at ?? 0) + 1);
    await prepareStandaloneEvent(event, targets);
    const retry = await publishCollectingProofOfWorkRefusals(event, NDKRelaySet.fromRelayUrls(targets, ndk));
    if (retry.failure && !first.published?.size)
        throw retry.failure;
    return new Set([...(first.published ?? []), ...(retry.published ?? [])]);
}
