import {
  RuntimeNostrSession,
  type ManagedSubscription,
  type SubscribeOptions,
  type PublishResult,
  type RelayHealthLike,
  type RelayInfoCacheLike,
} from "taskify-runtime-nostr";
import { RelayInfoCache } from "./RelayInfoCache";
import { RelayHealthTracker } from "./RelayHealth";
import { RelayAuthManager } from "./RelayAuth";
import { WalletNostrClient } from "./WalletNostrClient";

type PwaRuntimeSession = RuntimeNostrSession<WalletNostrClient>;
export type NostrPublishOptions = NonNullable<Parameters<PwaRuntimeSession["publish"]>[1]>;
export type NostrPublishSigner = NonNullable<NostrPublishOptions["signer"]>;

export class NostrSession {
  private static singleton: PwaRuntimeSession | null = null;

  static get instance(): PwaRuntimeSession {
    if (!this.singleton) throw new Error("NostrSession not initialised");
    return this.singleton;
  }

  static async init(relays: string[]): Promise<PwaRuntimeSession> {
    if (!this.singleton) {
      const relayInfoCache = new RelayInfoCache();
      const relayHealth = new RelayHealthTracker();
      const relayInfoCacheAdapter: RelayInfoCacheLike = {
        prime: (relayUrl, loader) =>
          relayInfoCache.prime(relayUrl, loader as (nip11Url: string) => Promise<any>) as Promise<{ info?: unknown } | null>,
        needsRefresh: (relayUrl) => relayInfoCache.needsRefresh(relayUrl),
        get: (relayUrl) => relayInfoCache.get(relayUrl),
        getAgeMs: (relayUrl) => relayInfoCache.getAgeMs(relayUrl),
        getLimits: (relayUrls) => relayInfoCache.getLimits(relayUrls),
      };
      const relayHealthAdapter: RelayHealthLike = {
        canAttempt: (relayUrl) => relayHealth.canAttempt(relayUrl),
        markFailure: (relayUrl, meta) => {
          const severity =
            meta?.severity === "low" || meta?.severity === "normal" || meta?.severity === "high"
              ? meta.severity
              : undefined;
          relayHealth.markFailure(relayUrl, { reason: meta?.reason, ...(severity ? { severity } : {}) });
        },
        markSuccess: (relayUrl) => relayHealth.markSuccess(relayUrl),
        onBackoffExpiry: (relayUrl, fn) => relayHealth.onBackoffExpiry(relayUrl, fn),
        nextAttemptIn: (relayUrl) => relayHealth.nextAttemptIn(relayUrl),
        status: (relayUrl) => relayHealth.status(relayUrl),
      };
      this.singleton = new RuntimeNostrSession(relays, {
        relayInfoCache: relayInfoCacheAdapter,
        relayHealth: relayHealthAdapter,
        createAuthManager: (ndk) => new RelayAuthManager(ndk),
        createWalletClient: ({ ndk, publisher, subscriptions, resolveRelaySet }) =>
          new WalletNostrClient(ndk, publisher, subscriptions, resolveRelaySet),
        isDev: Boolean((import.meta as any)?.env?.DEV),
      });
    }
    await this.singleton.init(relays);
    return this.singleton;
  }

  static async shutdown(): Promise<void> {
    if (!this.singleton) return;
    await this.singleton.shutdown();
    this.singleton = null;
  }
}

export type { ManagedSubscription, SubscribeOptions, PublishResult };
