/**
 * NIP-17 for the PWA: the protocol is taskify-core's (`nip17.ts`); this adds where to send
 * (the recipient's signed inbox relays) and how wraps are signed here (proof of work for the
 * relays that want it). Chat and the share inbox both send through it.
 */
import {
  buildNip17GiftWraps,
  nip17Timestamp,
  type Nip17Account,
  type Nip17Rumor,
  type Nip17SignedEvent,
} from "taskify-core";
import { inboxReadRelays, newNip17WrapKey } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";
import { NostrSession } from "../nostr/NostrSession";
import { prepareRelayEvent } from "../nostr/prepareRelayEvent";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Where to deliver to `recipient`: the relays in their newest signed inbox list (kind 10050),
 * plus `fallback`. Only a list the recipient signed counts.
 */
export async function recipientInboxRelays(recipient: string, fallback: string[]): Promise<string[]> {
  const relays = Array.from(new Set(fallback.map((relay) => (typeof relay === "string" ? relay.trim() : "")).filter(Boolean)));
  if (!relays.length) return relays;
  const pubkey = (recipient || "").toLowerCase();
  if (!HEX_64.test(pubkey)) return relays;
  try {
    const session = await NostrSession.init(relays);
    const events = await session.fetchEvents([{ kinds: [10050], authors: [pubkey] }], relays);
    return inboxReadRelays((events ?? []) as NostrEvent[], pubkey, relays);
  } catch {
    return relays;
  }
}

/** Seal and wrap timestamps: now, or randomized up to two days back (NIP-59). */
export function nip17TimestampSource(mode: "now" | "random"): () => number {
  return () => nip17Timestamp(Date.now() / 1000, mode === "now" ? null : Math.random);
}

/** The rumor's gift wraps for its recipients and the sender, signed for `relays`. */
export function giftWrapNip17Rumor(
  rumor: Nip17Rumor,
  account: Nip17Account,
  relays: string[],
  timestamp: () => number,
): Promise<Array<{ recipient: string; wrap: Nip17SignedEvent }>> {
  return buildNip17GiftWraps(rumor, account, {
    newWrapKey: newNip17WrapKey,
    signWrap: async (template, key) => (await prepareRelayEvent(template, key.secretKey, relays)) as Nip17SignedEvent,
    timestamp,
  });
}
