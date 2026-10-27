import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { verifyEvent } from "nostr-tools";
import { closeNdkPools, installNdkRelayTimerFix } from "./ndkLifecycle.js";
import { configureRelayAccess, publishStandaloneEvent } from "./RelayAccess.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import { RuntimeSessionClosedError } from "./sessionErrors.js";
/**
 * A short-lived relay connection for one-off reads and writes outside a `RuntimeNostrSession`:
 * profiles, contact lists, bot command lists, inbox relays. It shares the session's AUTH and
 * proof-of-work handling, verifies every event it returns, bounds every wait, and closes
 * completely, so nothing it made keeps a process alive. Prefer `withStandaloneSession`.
 */
export class StandaloneNostrSession {
    ndk;
    relays;
    closed = false;
    closing = null;
    constructor(ndk, relays) {
        this.ndk = ndk;
        this.relays = relays;
    }
    static async open(options) {
        const relays = normalizeRelayUrls(options.relays);
        if (!relays.length)
            throw new Error("No relays configured.");
        installNdkRelayTimerFix();
        const ndk = new NDK({
            explicitRelayUrls: relays,
            // Only the relays named: NDK's outbox model would also connect to its discovery relays.
            enableOutboxModel: false,
            autoConnectUserRelays: false,
            ...(options.secretKeyHex ? { signer: new NDKPrivateKeySigner(options.secretKeyHex) } : {}),
        });
        configureRelayAccess(ndk, options.secretKeyHex);
        const session = new StandaloneNostrSession(ndk, relays);
        let timer;
        try {
            await Promise.race([
                ndk.connect(),
                new Promise((resolve) => { timer = setTimeout(resolve, options.connectTimeoutMs ?? 3_000); }),
            ]);
        }
        catch (error) {
            await session.close();
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
        return session;
    }
    assertOpen(operation) {
        if (this.closed)
            throw new RuntimeSessionClosedError(operation);
    }
    /** Events matching `filter` whose signatures verify; whatever arrived by `timeoutMs`. */
    async fetchVerified(filter, options = {}) {
        this.assertOpen("fetchVerified");
        let timer;
        try {
            const events = await Promise.race([
                this.ndk.fetchEvents(filter),
                new Promise((resolve) => { timer = setTimeout(() => resolve(new Set()), options.timeoutMs ?? 8_000); }),
            ]).catch(() => new Set());
            return verifiedRawEvents(events);
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * Signs (with proof of work where relays ask) and publishes, as `publishStandaloneEvent` does.
     * Returns the published event and the relays that took it.
     */
    async publish(template) {
        this.assertOpen("publish");
        if (!this.ndk.signer)
            throw new Error("A signing identity is required.");
        const event = new NDKEvent(this.ndk);
        event.kind = template.kind;
        event.content = template.content;
        event.tags = template.tags;
        event.created_at = template.created_at ?? Math.floor(Date.now() / 1000);
        const published = await publishStandaloneEvent(event, this.relays);
        return {
            event: event.rawEvent(),
            relays: normalizeRelayUrls(Array.from(published).map((relay) => relay.url)),
        };
    }
    /** Disconnects every relay and stops everything NDK started. Idempotent. */
    close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        this.closing = Promise.resolve().then(() => closeNdkPools(this.ndk));
        return this.closing;
    }
}
/** Opens a standalone session, runs `work`, and closes the session however `work` ends. */
export async function withStandaloneSession(options, work) {
    const session = await StandaloneNostrSession.open(options);
    try {
        return await work(session);
    }
    finally {
        await session.close();
    }
}
/**
 * Raw events whose signatures verify. NDK checks every signature on a new connection and then only
 * a sample; standalone reads check all of them, so a relay cannot hand back a forged profile or
 * list. A fresh object is verified because nostr-tools caches a "verified" mark on event objects.
 */
export function verifiedRawEvents(events) {
    const out = [];
    for (const event of events) {
        const raw = (event.rawEvent?.() ?? event);
        const plain = {
            id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at, kind: raw.kind,
            tags: raw.tags, content: raw.content, sig: raw.sig,
        };
        try {
            if (verifyEvent(plain))
                out.push(plain);
        }
        catch {
            // malformed: skip
        }
    }
    return out;
}
