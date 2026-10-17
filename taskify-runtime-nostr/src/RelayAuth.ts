import NDK, { NDKEvent, NDKKind, NDKPrivateKeySigner, type NDKRelay } from "@nostr-dev-kit/ndk";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { normalizeRelayUrls } from "./relayUrls.js";

type AuthState = { challenge: string; authedAt: number; pending?: boolean; authed?: boolean };

/** The account's signer, for keys held outside this process (an extension or a remote signer). */
export type RelayAuthAccountSigner = {
  pubkey: string;
  sign: (template: EventTemplate) => Promise<NostrEvent>;
};

type RelayAuthOptions = {
  /** The account's secret key, for clients that hold it. */
  loadSecretKeyHex?: () => string | null;
  /** Preferred when set: the account's signer, or null while signed out. */
  loadAccountSigner?: () => RelayAuthAccountSigner | null;
  /**
   * Answer challenges with a throwaway key when no account key is available, so relays that
   * gate reads behind NIP-42 still serve signed-out clients. Off by default.
   */
  allowEphemeralKey?: boolean;
};

export type RelayAuthOutcome = {
  state: "authenticated" | "failed" | "no-key";
  at: number;
  reason?: string;
  /** True when the relay was answered with a throwaway key rather than the account's. */
  ephemeral?: boolean;
};

export class RelayAuthManager {
  private readonly ndk: NDK;
  private readonly authPerConnection = new Map<string, AuthState>();
  private readonly outcomes = new Map<string, RelayAuthOutcome>();
  private readonly loadSecretKeyHex: () => string | null;
  private readonly loadAccountSigner?: () => RelayAuthAccountSigner | null;
  private readonly allowEphemeralKey: boolean;
  private ephemeralSigner: NDKPrivateKeySigner | null = null;
  /** AUTH events signed with the throwaway key, so their outcome can say so. */
  private readonly ephemeralAuthEvents = new Set<string>();

  constructor(ndk: NDK, options: RelayAuthOptions) {
    this.ndk = ndk;
    this.loadSecretKeyHex = options.loadSecretKeyHex ?? (() => null);
    this.loadAccountSigner = options.loadAccountSigner;
    this.allowEphemeralKey = Boolean(options.allowEphemeralKey);
  }

  private connectionKey(relay: NDKRelay): string {
    const connectedAt = relay.connectionStats?.connectedAt;
    return `${relay.url}|${connectedAt ?? "none"}`;
  }

  private outcomeKey(relayUrl: string): string {
    return normalizeRelayUrls([relayUrl])[0] || relayUrl;
  }

  private loadSigner(): { signer: NDKPrivateKeySigner; ephemeral: boolean } | null {
    const raw = (this.loadSecretKeyHex() || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return { signer: new NDKPrivateKeySigner(raw.toLowerCase()), ephemeral: false };
    if (!this.allowEphemeralKey) return null;
    this.ephemeralSigner ??= NDKPrivateKeySigner.generate();
    return { signer: this.ephemeralSigner, ephemeral: true };
  }

  async buildAuthEvent(relayUrl: string, challenge: string): Promise<NDKEvent | null> {
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
    if (loaded.ephemeral) this.ephemeralAuthEvents.add(event.id);
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

  markAuthed(relay: NDKRelay, authEventId?: string): void {
    const key = this.connectionKey(relay);
    const existing = this.authPerConnection.get(key);
    this.authPerConnection.set(key, existing
      ? { ...existing, authedAt: Date.now(), authed: true }
      : { challenge: "", authedAt: Date.now(), authed: true });
    const ephemeral = authEventId ? this.ephemeralAuthEvents.has(authEventId) : this.outcomes.get(this.outcomeKey(relay.url))?.ephemeral;
    if (authEventId) this.ephemeralAuthEvents.delete(authEventId);
    this.outcomes.set(this.outcomeKey(relay.url), { state: "authenticated", at: Date.now(), ...(ephemeral ? { ephemeral: true } : {}) });
  }

  /** The relay refused the AUTH event (or never answered it). Its next challenge is answered afresh. */
  markFailed(relay: NDKRelay, reason: string, authEventId?: string): void {
    const key = this.connectionKey(relay);
    this.authPerConnection.delete(key);
    if (authEventId) this.ephemeralAuthEvents.delete(authEventId);
    this.outcomes.set(this.outcomeKey(relay.url), { state: "failed", at: Date.now(), reason });
  }

  isAuthed(relay: NDKRelay): boolean {
    return Boolean(this.authPerConnection.get(this.connectionKey(relay))?.authed);
  }

  /** The latest NIP-42 outcome seen for a relay, or null if it never challenged this client. */
  outcome(relayUrl: string): RelayAuthOutcome | null {
    return this.outcomes.get(this.outcomeKey(relayUrl)) ?? null;
  }

  reset(relayUrl: string): void {
    for (const key of Array.from(this.authPerConnection.keys())) {
      if (key.startsWith(`${relayUrl}|`)) this.authPerConnection.delete(key);
    }
  }
}

export type RelayAuthResponder = {
  respond: (relay: NDKRelay, challenge: string) => Promise<unknown>;
  markAuthed: (relay: NDKRelay, authEventId?: string) => void;
  markFailed?: (relay: NDKRelay, reason: string, authEventId?: string) => void;
  isAuthed?: (relay: NDKRelay) => boolean;
};

type RelayConnectivityLike = {
  auth?: (event: NDKEvent) => Promise<unknown>;
  retryPendingAuthPublishes?: () => void;
  rejectPendingAuthPublishes?: (error: Error) => void;
  _status?: number;
};

// NDKRelayStatus values (stable since NDK 2): CONNECTED, AUTH_REQUESTED, AUTHENTICATING, AUTHENTICATED.
const STATUS_CONNECTED = 5;
const STATUS_AUTHENTICATED = 8;

function setConnectivityStatus(connectivity: RelayConnectivityLike, status: number): void {
  // Only adjust a live connection; a relay that dropped meanwhile keeps its disconnected status.
  if (typeof connectivity._status === "number" && connectivity._status >= STATUS_CONNECTED) connectivity._status = status;
}

function emit(relay: NDKRelay, name: string, ...args: unknown[]): void {
  (relay as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(name, ...args);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "authentication failed";
}

/**
 * NIP-42 policy for NDK relays. NDK 3 sends a returned AUTH event itself, but lets a refused or
 * dropped AUTH escape as an unhandled rejection (which ends a Node process) and never resends
 * writes the relay answered with `auth-required:`. This policy sends the AUTH event, waits for the
 * relay's verdict, and then finishes what NDK leaves undone: resend held writes, or fail them.
 */
export function createRelayAuthPolicy(
  responder: RelayAuthResponder,
  options: { timeoutMs?: number } = {},
): (relay: NDKRelay, challenge: string) => Promise<boolean | NDKEvent> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (relay, challenge) => {
    const connectivity = (relay as unknown as { connectivity?: RelayConnectivityLike }).connectivity;
    let event: NDKEvent | undefined;
    try {
      event = (await responder.respond(relay, challenge)) as NDKEvent | undefined;
    } catch (error) {
      responder.markFailed?.(relay, errorMessage(error));
      event = undefined;
    }
    if (!event) {
      // NDK marked the relay as authenticating before asking; put it back so a later challenge
      // is still answered.
      if (connectivity) setConnectivityStatus(connectivity, responder.isAuthed?.(relay) ? STATUS_AUTHENTICATED : STATUS_CONNECTED);
      return false;
    }
    if (!connectivity || typeof connectivity.auth !== "function") return event;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connectivity.auth(event),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("auth timed out")), timeoutMs);
        }),
      ]);
    } catch (error) {
      const reason = errorMessage(error);
      setConnectivityStatus(connectivity, STATUS_CONNECTED);
      responder.markFailed?.(relay, reason, event.id);
      connectivity.rejectPendingAuthPublishes?.(new Error(reason));
      try { emit(relay, "auth:failed", new Error(reason)); } catch { /* listeners are best effort */ }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    setConnectivityStatus(connectivity, STATUS_AUTHENTICATED);
    responder.markAuthed(relay, event.id);
    connectivity.retryPendingAuthPublishes?.();
    // Resubscribes reads the relay closed with `auth-required:` and lets the pool react.
    emit(relay, "authed");
    return false;
  };
}
