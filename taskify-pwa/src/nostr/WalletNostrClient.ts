import type { NDKFilter } from "@nostr-dev-kit/ndk";
import { getPublicKey, nip19, type EventTemplate, type NostrEvent } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { PublishCoordinator, type PublishResult } from "./PublishCoordinator";
import { SubscriptionManager, type ManagedSubscription } from "./SubscriptionManager";

type RelayResolver = (relayUrls?: string[]) => Promise<unknown>;

type SubscribeHandlers = {
  onEvent?: (event: NostrEvent) => void;
  onEose?: (relay?: string) => void;
  closeOnEose?: boolean;
};

export class WalletNostrClient {
  private readonly ndk: any;
  private readonly publisher: PublishCoordinator;
  private readonly subscriptions: SubscriptionManager;
  private readonly resolveRelaySet: RelayResolver;

  constructor(
    ndk: any,
    publisher: PublishCoordinator,
    subscriptions: SubscriptionManager,
    resolveRelaySet: RelayResolver,
  ) {
    this.ndk = ndk;
    this.publisher = publisher;
    this.subscriptions = subscriptions;
    this.resolveRelaySet = resolveRelaySet;
  }

  async publishWalletState(event: EventTemplate, relays: string[], opts: { signer?: Uint8Array | string } = {}): Promise<PublishResult> {
    const replaceableKey = this.buildReplaceableKey(event, opts.signer);
    return this.publisher.publish(event, {
      relayUrls: relays,
      signer: opts.signer,
      replaceableKey,
      debounceMs: 400,
      returnEvent: true,
    });
  }

  async publishWalletEvent(
    event: EventTemplate,
    relays: string[],
    opts: { signer?: Uint8Array | string; replaceableKey?: string; returnEvent?: boolean } = {},
  ): Promise<PublishResult> {
    return this.publisher.publish(event, {
      relayUrls: relays,
      signer: opts.signer,
      replaceableKey: opts.replaceableKey || this.buildReplaceableKey(event, opts.signer),
      returnEvent: opts.returnEvent,
    });
  }

  async fetchEvents(filters: NDKFilter[], relays: string[]): Promise<NostrEvent[]> {
    const relaySet = await this.resolveRelaySet(relays);
    const fetched = await this.ndk.fetchEvents(filters, { closeOnEose: true }, relaySet);
    return Array.from(fetched as Iterable<any>)
      .map((ev) => ev.rawEvent?.() ?? (ev as NostrEvent))
      .filter((ev): ev is NostrEvent => !!ev?.id);
  }

  async subscribe(filters: NDKFilter[], relays: string[], handlers: SubscribeHandlers): Promise<ManagedSubscription> {
    return this.subscriptions.subscribe(filters, {
      relayUrls: relays,
      onEvent: handlers.onEvent,
      onEose: handlers.onEose,
      opts: { closeOnEose: !!handlers.closeOnEose },
    });
  }

  async initWalletSubscriptions(filters: NDKFilter[], relays: string[], handlers: SubscribeHandlers): Promise<ManagedSubscription> {
    return this.subscribe(filters, relays, handlers);
  }

  private derivePubkey(signer?: Uint8Array | string): string | undefined {
    if (!signer) return undefined;
    try {
      if (signer instanceof Uint8Array) return getPublicKey(signer);
      let hex = signer.trim();
      if (hex.startsWith("nsec")) {
        const decoded = nip19.decode(hex);
        if (decoded.type === "nsec" && decoded.data) {
          if (typeof decoded.data === "string") {
            hex = decoded.data;
          } else if (decoded.data instanceof Uint8Array) {
            hex = Array.from(decoded.data)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          } else if (Array.isArray(decoded.data)) {
            hex = Array.from(decoded.data as number[])
              .map((b) => Number(b).toString(16).padStart(2, "0"))
              .join("");
          }
        }
      }
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        return getPublicKey(hexToBytes(hex));
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private buildReplaceableKey(event: EventTemplate, signer?: Uint8Array | string): string | undefined {
    const kind = event.kind;
    const pubkey = this.derivePubkey(signer);
    const dTag = Array.isArray(event.tags) ? event.tags.find((t) => t[0] === "d")?.[1] : undefined;
    if (kind == null || !pubkey) return undefined;
    if (dTag) return `replaceable:${kind}:${pubkey}:${dTag}`;
    return `replaceable:${kind}:${pubkey}`;
  }
}
