/**
 * Where a peer's messages are waiting.
 *
 * A Nostr peer publishes a kind-10050 list naming the relays it reads its inbox from. The panel
 * looks that list up (signed by the peer, so it can be trusted) and sends the gift wraps there.
 * When the peer publishes no list, the default relays are used.
 */
import { inboxReadRelays } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";
import { getSession } from "./session";

const INBOX_LIST_KIND = 10050;

/** The relays to deliver to `recipient`: the ones in their signed inbox list, plus the fallback. */
export async function recipientInboxRelays(recipient: string, fallback: string[]): Promise<string[]> {
  const pubkey = (recipient || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return fallback;
  try {
    const session = await getSession(fallback);
    const events = await session.fetchEvents([{ kinds: [INBOX_LIST_KIND], authors: [pubkey] }], fallback, 6000);
    return inboxReadRelays((events ?? []) as NostrEvent[], pubkey, fallback);
  } catch {
    // No inbox list, or the relays were unreachable: the fallback is the best guess.
    return fallback;
  }
}
