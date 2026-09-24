import NDK, { NDKEvent, NDKKind, NDKPrivateKeySigner, type NDKRelay } from "@nostr-dev-kit/ndk";

type AuthState = { challenge: string; authedAt: number; pending?: boolean };

type RelayAuthOptions = {
  loadSecretKeyHex: () => string | null;
};

export class RelayAuthManager {
  private readonly ndk: NDK;
  private readonly authPerConnection = new Map<string, AuthState>();
  private readonly loadSecretKeyHex: () => string | null;

  constructor(ndk: NDK, options: RelayAuthOptions) {
    this.ndk = ndk;
    this.loadSecretKeyHex = options.loadSecretKeyHex;
  }

  private connectionKey(relay: NDKRelay): string {
    const connectedAt = relay.connectionStats?.connectedAt;
    return `${relay.url}|${connectedAt ?? "none"}`;
  }

  private loadSigner(): NDKPrivateKeySigner | null {
    const raw = (this.loadSecretKeyHex() || "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
    return new NDKPrivateKeySigner(raw.toLowerCase());
  }

  async buildAuthEvent(relayUrl: string, challenge: string): Promise<NDKEvent | null> {
    const signer = this.loadSigner();
    if (!signer) return null;
    const event = new NDKEvent(this.ndk);
    event.kind = NDKKind.ClientAuth;
    event.tags = [["relay", relayUrl], ["challenge", challenge]];
    event.content = "";
    await event.sign(signer);
    return event;
  }

  async respond(relay: NDKRelay, challenge: string): Promise<NDKEvent | undefined> {
    const key = this.connectionKey(relay);
    const previous = this.authPerConnection.get(key);
    if (previous && previous.challenge === challenge) return undefined;
    // Reserve before signing: repeated challenges must not start parallel signatures.
    const state: AuthState = { challenge, authedAt: Date.now(), pending: true };
    this.authPerConnection.set(key, state);
    try {
      const event = await this.buildAuthEvent(relay.url, challenge);
      // A reset or newer challenge invalidates an in-flight signature.
      if (this.authPerConnection.get(key) !== state) return undefined;
      state.pending = false;
      if (!event) this.authPerConnection.delete(key);
      return event ?? undefined;
    } catch (error) {
      if (this.authPerConnection.get(key) === state) this.authPerConnection.delete(key);
      throw error;
    }
  }

  markAuthed(relay: NDKRelay): void {
    const key = this.connectionKey(relay);
    const existing = this.authPerConnection.get(key);
    this.authPerConnection.set(key, existing ? { ...existing, authedAt: Date.now() } : { challenge: "", authedAt: Date.now() });
  }

  reset(relayUrl: string): void {
    for (const key of Array.from(this.authPerConnection.keys())) {
      if (key.startsWith(`${relayUrl}|`)) this.authPerConnection.delete(key);
    }
  }
}
