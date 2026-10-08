import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { verifyEvent, type NostrEvent } from "nostr-tools";

/**
 * Raw events from a direct NDK fetch whose signatures verify. NDK checks every signature on a new
 * connection and then only a sample; reads that bypass the runtime session (which verifies all of
 * them) use this instead, so a relay cannot hand back a forged profile or list.
 */
export function verifiedRawEvents(events: Iterable<NDKEvent>): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const event of events) {
    const raw = (event.rawEvent?.() ?? event) as unknown as NostrEvent;
    // A fresh object with only the event's fields: nostr-tools caches a "verified" mark on event
    // objects, which a copy would carry over and which would skip the check.
    const plain: NostrEvent = {
      id: raw.id,
      pubkey: raw.pubkey,
      created_at: raw.created_at,
      kind: raw.kind,
      tags: raw.tags,
      content: raw.content,
      sig: raw.sig,
    };
    try {
      if (verifyEvent(plain)) out.push(plain);
    } catch {
      // malformed: skip
    }
  }
  return out;
}
