import { nip19 } from "nostr-tools";
import { normalizeNostrPubkeyHex, planEventInvitations, type EventInvitationGenerators } from "taskify-core";

type Participant = { pubkey: string; relay?: string; role?: string };

/** Lowercase hex for an npub or hex public key, or null. */
export function participantPubkeyHex(value: string): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.toLowerCase().startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub" ? (decoded.data as string).toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return normalizeNostrPubkeyHex(trimmed);
}

/** `participants` with `pubkeyHex` added at the end unless one of them already is it. */
export function withInvitee(participants: Participant[] | undefined, pubkeyHex: string): Participant[] {
  const list = [...(participants ?? [])];
  if (!list.some((participant) => participantPubkeyHex(participant.pubkey) === pubkeyHex)) list.push({ pubkey: pubkeyHex });
  return list;
}

/**
 * The event key and invite tokens an event is published with for `participants`
 * (`planEventInvitations`, the rule the PWA and iOS share): a token per invitee, existing ones
 * kept, none for the sender.
 */
export function eventInvitationSecrets(
  event: { eventKey?: string | null; inviteTokens?: Record<string, string> | null },
  participants: Participant[] | undefined,
  senderPubkeyHex: string | undefined,
  /** How new keys and tokens are made (the runtime passes `calendarCrypto`'s generators). */
  generators: Pick<EventInvitationGenerators, "eventKey" | "inviteToken">,
): { eventKey: string; inviteTokens?: Record<string, string> } {
  const plan = planEventInvitations(
    {
      eventKey: event.eventKey,
      inviteTokens: event.inviteTokens,
      participantPubkeys: (participants ?? []).map((participant) => participant.pubkey),
      senderPubkey: senderPubkeyHex,
    },
    { ...generators, normalizePubkey: participantPubkeyHex },
  );
  return { eventKey: plan.eventKey, inviteTokens: plan.inviteTokens };
}
