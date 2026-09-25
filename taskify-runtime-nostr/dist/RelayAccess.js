import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { RelayInfoCache } from "./RelayInfoCache.js";
import { RelayAuthManager } from "./RelayAuth.js";
import { applyProofOfWork } from "./ProofOfWork.js";
import { normalizeRelayUrls } from "./relayUrls.js";
const relayInfoCache = new RelayInfoCache();
export async function relayProofOfWorkDifficulty(relays) {
    const targets = normalizeRelayUrls(relays);
    await Promise.all(targets.map(relay => relayInfoCache.prime(relay, async (url) => {
        const response = await fetch(url, {
            headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5_000),
        });
        return response.ok ? await response.json() : null;
    })));
    return relayInfoCache.getLimits(targets).minPowDifficulty;
}
/** Standalone clients share the same auth policy; anonymous reads use an ephemeral key. */
export function configureRelayAccess(ndk, secretKeyHex) {
    const signer = secretKeyHex ? new NDKPrivateKeySigner(secretKeyHex) : NDKPrivateKeySigner.generate();
    const manager = new RelayAuthManager(ndk, { loadSecretKeyHex: () => signer.privateKey ?? null });
    ndk.relayAuthDefaultPolicy = (relay, challenge) => manager.respond(relay, challenge);
    ndk.pool.on("relay:disconnect", relay => manager.reset(relay.url));
}
export async function prepareStandaloneEvent(event, relays) {
    const signer = event.ndk?.signer;
    if (!signer)
        throw new Error("A signing identity is required.");
    const difficulty = await relayProofOfWorkDifficulty(relays);
    if (difficulty > 0)
        await applyProofOfWork(event, signer, difficulty);
    else
        await event.sign(signer);
}
