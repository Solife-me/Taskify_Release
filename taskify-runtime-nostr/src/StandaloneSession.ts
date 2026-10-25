import NDK, { NDKEvent, NDKPrivateKeySigner, type NDKFilter } from "@nostr-dev-kit/ndk";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import { closeNdkPools, installNdkRelayTimerFix } from "./ndkLifecycle.js";
import { configureRelayAccess, publishStandaloneEvent } from "./RelayAccess.js";
import { normalizeRelayUrls } from "./relayUrls.js";
import { RuntimeSessionClosedError } from "./sessionErrors.js";

export type StandaloneSessionOptions = {
  relays: string[];
  /** The account that signs writes and answers AUTH; reads without one use an ephemeral key. */
  secretKeyHex?: string;
  /** How long to wait for relays before working with those that connected (default 3 s). */
  connectTimeoutMs?: number;
};

/**
 * A short-lived relay connection for one-off reads and writes outside a `RuntimeNostrSession`:
 * profiles, contact lists, bot command lists, inbox relays. It shares the session's AUTH and
 * proof-of-work handling, verifies every event it returns, bounds every wait, and closes
 * completely, so nothing it made keeps a process alive. Prefer `withStandaloneSession`.
 */
export class StandaloneNostrSession {
  private closed = false;
  private closing: Promise<void> | null = null;

  private constructor(private readonly ndk: NDK, readonly relays: string[]) {}

  static async open(options: StandaloneSessionOptions): Promise<StandaloneNostrSession> {
    const relays = normalizeRelayUrls(options.relays);
    if (!relays.length) throw new Error("No relays configured.");
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ndk.connect(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, options.connectTimeoutMs ?? 3_000); }),
      ]);
    } catch (error) {
      await session.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return session;
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new RuntimeSessionClosedError(operation);
  }

  /** Events matching `filter` whose signatures verify; whatever arrived by `timeoutMs`. */
  async fetchVerified(filter: NDKFilter, options: { timeoutMs?: number } = {}): Promise<NostrEvent[]> {
    this.assertOpen("fetchVerified");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race<Set<NDKEvent>>([
        this.ndk.fetchEvents(filter),
        new Promise<Set<NDKEvent>>((resolve) => { timer = setTimeout(() => resolve(new Set()), options.timeoutMs ?? 8_000); }),
      ]).catch(() => new Set<NDKEvent>());
      return verifiedRawEvents(events);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Signs (with proof of work where relays ask) and publishes, as `publishStandaloneEvent` does.
   * Returns the published event and the relays that took it.
   */
  async publish(template: { kind: number; content: string; tags: string[][]; created_at?: number }): Promise<{ event: NostrEvent; relays: string[] }> {
    this.assertOpen("publish");
    if (!this.ndk.signer) throw new Error("A signing identity is required.");
    const event = new NDKEvent(this.ndk);
    event.kind = template.kind;
    event.content = template.content;
    event.tags = template.tags;
    event.created_at = template.created_at ?? Math.floor(Date.now() / 1000);
    const published = await publishStandaloneEvent(event, this.relays);
    return {
      event: event.rawEvent() as NostrEvent,
      relays: normalizeRelayUrls(Array.from(published).map((relay) => relay.url)),
    };
  }

  /** Disconnects every relay and stops everything NDK started. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(() => closeNdkPools(this.ndk));
    return this.closing;
  }
}

/** Opens a standalone session, runs `work`, and closes the session however `work` ends. */
export async function withStandaloneSession<T>(
  options: StandaloneSessionOptions,
  work: (session: StandaloneNostrSession) => Promise<T>,
): Promise<T> {
  const session = await StandaloneNostrSession.open(options);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/**
 * Raw events whose signatures verify. NDK checks every signature on a new connection and then only
 * a sample; standalone reads check all of them, so a relay cannot hand back a forged profile or
 * list. A fresh object is verified because nostr-tools caches a "verified" mark on event objects.
 */
export function verifiedRawEvents(events: Iterable<NDKEvent>): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const event of events) {
    const raw = (event.rawEvent?.() ?? event) as unknown as NostrEvent;
    const plain: NostrEvent = {
      id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at, kind: raw.kind,
      tags: raw.tags, content: raw.content, sig: raw.sig,
    };
    try {
      if (verifyEvent(plain)) out.push(plain);
    } catch {
      // malformed: skip
    }
  }
  return out;
}
