/**
 * The panel's Nostr session: one connection to the relays, shared by every feature.
 *
 * It is Taskify's own `RuntimeNostrSession` (from `taskify-runtime-nostr`), wired up the same way
 * the PWA wires it, with the account's key as the signer. Boards, chat and the account backup all
 * travel over this one session.
 */
import {
  RelayAuthManager,
  RelayHealthTracker,
  RelayInfoCache,
  RuntimeNostrSession,
  type ManagedSubscription,
  type PublishResult,
  type RelayHealthLike,
  type RelayInfoCacheLike,
} from "taskify-runtime-nostr";
import { finalizeEvent, type EventTemplate, type NostrEvent } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.solife.me",
];

export type AccountSigner = {
  pubkey: string;
  sign: (template: EventTemplate) => Promise<NostrEvent>;
};

let session: RuntimeNostrSession<unknown> | null = null;
let sessionRelays = "";

/** The account's signer, built from the stored secret key. */
export function signerFromSecret(secretKeyHex: string): AccountSigner {
  return {
    pubkey: "",
    sign: async (template: EventTemplate) => finalizeEvent(template, hexToBytes(secretKeyHex)),
  };
}

export function createAccountSigner(secretKeyHex: string, pubkey: string): AccountSigner {
  return {
    pubkey,
    sign: async (template: EventTemplate) => finalizeEvent(template, hexToBytes(secretKeyHex)),
  };
}

/**
 * Opens (or reuses) the session. The relays are fixed for the life of the panel: a panel that
 * reconnects to a different set of relays mid-use would leave subscriptions behind.
 */
export async function getSession(relays: string[] = DEFAULT_RELAYS): Promise<RuntimeNostrSession<unknown>> {
  const key = relays.join(",");
  if (session && sessionRelays === key) {
    await session.init(relays);
    return session;
  }
  if (session) await session.shutdown().catch(() => {});

  const relayInfoCache = new RelayInfoCache();
  const relayHealth = new RelayHealthTracker();
  const relayInfoCacheAdapter: RelayInfoCacheLike = {
    prime: (relayUrl, loader) => relayInfoCache.prime(relayUrl, loader as (nip11Url: string) => Promise<any>) as Promise<{ info?: unknown } | null>,
    needsRefresh: (relayUrl) => relayInfoCache.needsRefresh(relayUrl),
    get: (relayUrl) => relayInfoCache.get(relayUrl),
    getAgeMs: (relayUrl) => relayInfoCache.getAgeMs(relayUrl),
    getLimits: (relayUrls) => relayInfoCache.getLimits(relayUrls),
  };
  const relayHealthAdapter: RelayHealthLike = {
    canAttempt: (relayUrl) => relayHealth.canAttempt(relayUrl),
    markFailure: (relayUrl, meta) => {
      const severity = meta?.severity === "low" || meta?.severity === "normal" || meta?.severity === "high" ? meta.severity : undefined;
      relayHealth.markFailure(relayUrl, { reason: meta?.reason, ...(severity ? { severity } : {}) });
    },
    markSuccess: (relayUrl) => relayHealth.markSuccess(relayUrl),
    onBackoffExpiry: (relayUrl, fn) => relayHealth.onBackoffExpiry(relayUrl, fn),
    nextAttemptIn: (relayUrl) => relayHealth.nextAttemptIn(relayUrl),
    status: (relayUrl) => ({ ...(relayHealth.status(relayUrl) ?? {}) }),
  };

  session = new RuntimeNostrSession(relays, {
    relayInfoCache: relayInfoCacheAdapter,
    relayHealth: relayHealthAdapter,
    createAuthManager: (ndk) => new RelayAuthManager(ndk, { allowEphemeralKey: true }),
    createWalletClient: ({ publisher, subscriptions }) => ({ publisher, subscriptions }) as unknown,
    // The panel names its relays explicitly, so it never needs NDK's own outbox model.
    enableOutboxModel: false,
  });
  sessionRelays = key;
  await session.init(relays);
  return session;
}

export async function shutdownSession(): Promise<void> {
  if (!session) return;
  await session.shutdown().catch(() => {});
  session = null;
  sessionRelays = "";
}

export type { ManagedSubscription, PublishResult, NostrEvent };
