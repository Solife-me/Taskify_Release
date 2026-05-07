import {
  RuntimeNostrSession,
  type ManagedSubscription,
  type SubscribeOptions,
  type PublishResult,
} from "taskify-runtime-nostr";
import { RelayInfoCache } from "./RelayInfoCache";
import { RelayHealthTracker } from "./RelayHealth";
import { RelayAuthManager } from "./RelayAuth";
import { WalletNostrClient } from "./WalletNostrClient";
import { nostrOutboxStore } from "./NostrOutboxStore";

type PwaRuntimeSession = RuntimeNostrSession<WalletNostrClient>;

export class NostrSession {
  private static singleton: PwaRuntimeSession | null = null;
  private static browserDrainHooksInstalled = false;

  static get instance(): PwaRuntimeSession {
    if (!this.singleton) throw new Error("NostrSession not initialised");
    return this.singleton;
  }

  static async init(relays: string[]): Promise<PwaRuntimeSession> {
    if (!this.singleton) {
      const relayInfoCache = new RelayInfoCache();
      const relayHealth = new RelayHealthTracker();
      this.singleton = new RuntimeNostrSession(relays, {
        relayInfoCache,
        relayHealth,
        createAuthManager: (ndk) => new RelayAuthManager(ndk),
        createWalletClient: ({ ndk, publisher, subscriptions, resolveRelaySet }) =>
          new WalletNostrClient(ndk, publisher, subscriptions, resolveRelaySet),
        outboxStore: nostrOutboxStore,
        isDev: Boolean((import.meta as any)?.env?.DEV),
      });
      this.installBrowserDrainHooks();
    }
    await this.singleton.init(relays);
    void this.singleton.publisher.drainOutbox({ force: true }).catch((err) => {
      if ((import.meta as any)?.env?.DEV) console.warn("[nostr] outbox startup drain failed", err);
    });
    return this.singleton;
  }

  static async shutdown(): Promise<void> {
    if (!this.singleton) return;
    await this.singleton.shutdown();
    this.singleton = null;
  }

  private static installBrowserDrainHooks(): void {
    if (this.browserDrainHooksInstalled) return;
    if (typeof window === "undefined") return;
    const drain = () => {
      void this.singleton?.publisher.drainOutbox({ force: true }).catch((err) => {
        if ((import.meta as any)?.env?.DEV) console.warn("[nostr] outbox drain failed", err);
      });
    };
    window.addEventListener("online", drain);
    window.addEventListener("focus", drain);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") drain();
      });
    }
    this.browserDrainHooksInstalled = true;
  }
}

export type { ManagedSubscription, SubscribeOptions, PublishResult };
