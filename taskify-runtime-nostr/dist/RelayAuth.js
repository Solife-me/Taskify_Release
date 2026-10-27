import { NDKEvent, NDKKind, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { normalizeRelayUrls } from "./relayUrls.js";
export class RelayAuthManager {
    ndk;
    authPerConnection = new Map();
    outcomes = new Map();
    loadSecretKeyHex;
    loadAccountSigner;
    allowEphemeralKey;
    ephemeralSigner = null;
    /** AUTH events signed with the throwaway key, so their outcome can say so. */
    ephemeralAuthEvents = new Set();
    constructor(ndk, options) {
        this.ndk = ndk;
        this.loadSecretKeyHex = options.loadSecretKeyHex ?? (() => null);
        this.loadAccountSigner = options.loadAccountSigner;
        this.allowEphemeralKey = Boolean(options.allowEphemeralKey);
    }
    connectionKey(relay) {
        const connectedAt = relay.connectionStats?.connectedAt;
        return `${relay.url}|${connectedAt ?? "none"}`;
    }
    outcomeKey(relayUrl) {
        return normalizeRelayUrls([relayUrl])[0] || relayUrl;
    }
    loadSigner() {
        const raw = (this.loadSecretKeyHex() || "").trim();
        if (/^[0-9a-fA-F]{64}$/.test(raw))
            return { signer: new NDKPrivateKeySigner(raw.toLowerCase()), ephemeral: false };
        if (!this.allowEphemeralKey)
            return null;
        this.ephemeralSigner ??= NDKPrivateKeySigner.generate();
        return { signer: this.ephemeralSigner, ephemeral: true };
    }
    async buildAuthEvent(relayUrl, challenge) {
        const tags = [["relay", relayUrl], ["challenge", challenge]];
        const account = this.loadAccountSigner?.();
        if (account) {
            const signed = await account.sign({
                kind: NDKKind.ClientAuth,
                tags,
                content: "",
                created_at: Math.floor(Date.now() / 1000),
            });
            return new NDKEvent(this.ndk, signed);
        }
        const loaded = this.loadSigner();
        if (!loaded) {
            this.outcomes.set(this.outcomeKey(relayUrl), { state: "no-key", at: Date.now() });
            return null;
        }
        const event = new NDKEvent(this.ndk);
        event.kind = NDKKind.ClientAuth;
        event.tags = [["relay", relayUrl], ["challenge", challenge]];
        event.content = "";
        await event.sign(loaded.signer);
        if (loaded.ephemeral)
            this.ephemeralAuthEvents.add(event.id);
        return event;
    }
    async respond(relay, challenge) {
        const key = this.connectionKey(relay);
        const previous = this.authPerConnection.get(key);
        if (previous && previous.challenge === challenge)
            return undefined;
        // Reserve before signing: repeated challenges must not start parallel signatures.
        const state = { challenge, authedAt: Date.now(), pending: true };
        this.authPerConnection.set(key, state);
        try {
            const event = await this.buildAuthEvent(relay.url, challenge);
            // A reset or newer challenge invalidates an in-flight signature.
            if (this.authPerConnection.get(key) !== state)
                return undefined;
            state.pending = false;
            if (!event)
                this.authPerConnection.delete(key);
            return event ?? undefined;
        }
        catch (error) {
            if (this.authPerConnection.get(key) === state)
                this.authPerConnection.delete(key);
            throw error;
        }
    }
    markAuthed(relay, authEventId) {
        const key = this.connectionKey(relay);
        const existing = this.authPerConnection.get(key);
        this.authPerConnection.set(key, existing
            ? { ...existing, authedAt: Date.now(), authed: true }
            : { challenge: "", authedAt: Date.now(), authed: true });
        const ephemeral = authEventId ? this.ephemeralAuthEvents.has(authEventId) : this.outcomes.get(this.outcomeKey(relay.url))?.ephemeral;
        if (authEventId)
            this.ephemeralAuthEvents.delete(authEventId);
        this.outcomes.set(this.outcomeKey(relay.url), { state: "authenticated", at: Date.now(), ...(ephemeral ? { ephemeral: true } : {}) });
    }
    /** The relay refused the AUTH event (or never answered it). Its next challenge is answered afresh. */
    markFailed(relay, reason, authEventId) {
        const key = this.connectionKey(relay);
        this.authPerConnection.delete(key);
        if (authEventId)
            this.ephemeralAuthEvents.delete(authEventId);
        this.outcomes.set(this.outcomeKey(relay.url), { state: "failed", at: Date.now(), reason });
    }
    isAuthed(relay) {
        return Boolean(this.authPerConnection.get(this.connectionKey(relay))?.authed);
    }
    /** The latest NIP-42 outcome seen for a relay, or null if it never challenged this client. */
    outcome(relayUrl) {
        return this.outcomes.get(this.outcomeKey(relayUrl)) ?? null;
    }
    reset(relayUrl) {
        for (const key of Array.from(this.authPerConnection.keys())) {
            if (key.startsWith(`${relayUrl}|`))
                this.authPerConnection.delete(key);
        }
    }
}
// NDKRelayStatus values (stable since NDK 2): CONNECTED, AUTH_REQUESTED, AUTHENTICATING, AUTHENTICATED.
const STATUS_CONNECTED = 5;
const STATUS_AUTHENTICATED = 8;
function setConnectivityStatus(connectivity, status) {
    // Only adjust a live connection; a relay that dropped meanwhile keeps its disconnected status.
    if (typeof connectivity._status === "number" && connectivity._status >= STATUS_CONNECTED)
        connectivity._status = status;
}
function emit(relay, name, ...args) {
    relay.emit(name, ...args);
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return typeof error === "string" ? error : "authentication failed";
}
/**
 * NIP-42 policy for NDK relays. NDK 3 sends a returned AUTH event itself, but lets a refused or
 * dropped AUTH escape as an unhandled rejection (which ends a Node process) and never resends
 * writes the relay answered with `auth-required:`. This policy sends the AUTH event, waits for the
 * relay's verdict, and then finishes what NDK leaves undone: resend held writes, or fail them.
 */
export function createRelayAuthPolicy(responder, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    return async (relay, challenge) => {
        const connectivity = relay.connectivity;
        let event;
        try {
            event = (await responder.respond(relay, challenge));
        }
        catch (error) {
            responder.markFailed?.(relay, errorMessage(error));
            event = undefined;
        }
        if (!event) {
            // NDK marked the relay as authenticating before asking; put it back so a later challenge
            // is still answered.
            if (connectivity)
                setConnectivityStatus(connectivity, responder.isAuthed?.(relay) ? STATUS_AUTHENTICATED : STATUS_CONNECTED);
            return false;
        }
        if (!connectivity || typeof connectivity.auth !== "function")
            return event;
        let timer;
        try {
            await Promise.race([
                connectivity.auth(event),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("auth timed out")), timeoutMs);
                }),
            ]);
        }
        catch (error) {
            const reason = errorMessage(error);
            setConnectivityStatus(connectivity, STATUS_CONNECTED);
            responder.markFailed?.(relay, reason, event.id);
            connectivity.rejectPendingAuthPublishes?.(new Error(reason));
            try {
                emit(relay, "auth:failed", new Error(reason));
            }
            catch { /* listeners are best effort */ }
            return false;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        setConnectivityStatus(connectivity, STATUS_AUTHENTICATED);
        responder.markAuthed(relay, event.id);
        connectivity.retryPendingAuthPublishes?.();
        // Resubscribes reads the relay closed with `auth-required:` and lets the pool react.
        emit(relay, "authed");
        return false;
    };
}
