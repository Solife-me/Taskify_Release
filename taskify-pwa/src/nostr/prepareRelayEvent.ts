import type { EventTemplate } from "nostr-tools";
import { NostrSession } from "./NostrSession";

/** Finalize work and signature before storing or referencing the event ID. */
export async function prepareRelayEvent(template: EventTemplate, secretKey: Uint8Array, relays: string[], signal?: AbortSignal) {
  const session = await NostrSession.init(relays);
  return session.prepareEvent(template, secretKey, relays, { signal });
}
