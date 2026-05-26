import { NDKEvent, NDKKind, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
export class RelayAuthManager {
    ndk;
    authPerConnection = new Map();
    loadSecretKeyHex;
    constructor(ndk, options) {
        this.ndk = ndk;
        this.loadSecretKeyHex = options.loadSecretKeyHex;
    }
    connectionKey(relay) {
        const connectedAt = relay.connectionStats?.connectedAt;
        return `${relay.url}|${connectedAt ?? "none"}`;
    }
    loadSigner() {
        const raw = (this.loadSecretKeyHex() || "").trim();
        if (!/^[0-9a-fA-F]{64}$/.test(raw))
            return null;
        return new NDKPrivateKeySigner(raw.toLowerCase());
    }
    async buildAuthEvent(relayUrl, challenge) {
        const signer = this.loadSigner();
        if (!signer)
            return null;
        const event = new NDKEvent(this.ndk);
        event.kind = NDKKind.ClientAuth;
        event.tags = [["relay", relayUrl], ["challenge", challenge]];
        event.content = "";
        await event.sign(signer);
        return event;
    }
    async respond(relay, challenge) {
        const key = this.connectionKey(relay);
        const previous = this.authPerConnection.get(key);
        if (previous && previous.challenge === challenge && Date.now() - previous.authedAt < 15_000)
            return undefined;
        const event = await this.buildAuthEvent(relay.url, challenge);
        if (!event)
            return undefined;
        this.authPerConnection.set(key, { challenge, authedAt: Date.now() });
        return event;
    }
    markAuthed(relay) {
        const key = this.connectionKey(relay);
        const existing = this.authPerConnection.get(key);
        this.authPerConnection.set(key, existing ? { ...existing, authedAt: Date.now() } : { challenge: "", authedAt: Date.now() });
    }
    reset(relayUrl) {
        for (const key of Array.from(this.authPerConnection.keys())) {
            if (key.startsWith(`${relayUrl}|`))
                this.authPerConnection.delete(key);
        }
    }
}
