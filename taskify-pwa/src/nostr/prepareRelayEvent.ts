import type { EventTemplate } from "nostr-tools";
import { NostrSession } from "./NostrSession";
import type { NostrSigner } from "../identity/signer";

/** Finalize work and signature before storing or referencing the event ID. */
export async function prepareRelayEvent(template: EventTemplate, secretKey: Uint8Array, relays: string[], signal?: AbortSignal) {
  const session = await NostrSession.init(relays);
  return session.prepareEvent(template, secretKey, relays, { signal });
}

/** The same, for the user's own events: signed by their signer, wherever their key is held. */
export async function prepareSignedRelayEvent(
  template: EventTemplate,
  signer: Pick<NostrSigner, "pubkey" | "sign">,
  relays: string[],
  signal?: AbortSignal,
) {
  const session = await NostrSession.init(relays);
  return session.prepareEventWith(template, signer as never, relays, { signal });
}
