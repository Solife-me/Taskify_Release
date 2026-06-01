import NDK, { NDKEvent, type NDKRelay } from "@nostr-dev-kit/ndk";
type RelayAuthOptions = {
    loadSecretKeyHex: () => string | null;
};
export declare class RelayAuthManager {
    private readonly ndk;
    private readonly authPerConnection;
    private readonly loadSecretKeyHex;
    constructor(ndk: NDK, options: RelayAuthOptions);
    private connectionKey;
    private loadSigner;
    buildAuthEvent(relayUrl: string, challenge: string): Promise<NDKEvent | null>;
    respond(relay: NDKRelay, challenge: string): Promise<NDKEvent | undefined>;
    markAuthed(relay: NDKRelay): void;
    reset(relayUrl: string): void;
}
export {};
