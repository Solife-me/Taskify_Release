import { normalizeNostrPubkeyHex } from "./contactContracts.js";
import { b64decode } from "./nostrPrimitives.js";

/**
 * A calendar event's invitation secrets for its participants, the rule the PWA, iOS and the CLI
 * share (fixtures/event-invitation-vectors.json).
 *
 * Every invitee has their own token, kept across edits because an RSVP refers to it. Tokens of
 * people no longer invited are dropped, so a later edit can't re-share the event with them. The
 * sender is never their own invitee. The event key (32 bytes, base64) encrypts the invitees' view
 * copy; it is kept unless missing or malformed.
 */
export type EventInvitationPlan = {
  eventKey: string;
  /** Invitee public key (lowercase hex) to their token; undefined when nobody is invited. */
  inviteTokens?: Record<string, string>;
  /** The invitees, normalized, in participant order, without duplicates or the sender. */
  inviteePubkeys: string[];
  /** Invitees who were not among `previousPubkeys`: the ones to send an invite to. */
  addedPubkeys: string[];
  /** Whether the event key or tokens differ from the input, so the event must be saved. */
  changed: boolean;
};

export type EventInvitationInput = {
  eventKey?: string | null;
  inviteTokens?: Record<string, string> | null;
  /** Participant public keys, in any spelling `normalizePubkey` accepts. */
  participantPubkeys: string[];
  /** Participants before this change, for `addedPubkeys`. */
  previousPubkeys?: string[];
  senderPubkey?: string | null;
};

export type EventInvitationGenerators = {
  eventKey: () => string;
  inviteToken: () => string;
  /** Lowercase hex for a public key, or null. Defaults to hex-only; pass an npub-aware one. */
  normalizePubkey?: (value: string) => string | null;
};

export function isValidEventKey(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return b64decode(value.trim()).length === 32;
  } catch {
    return false;
  }
}

export function planEventInvitations(input: EventInvitationInput, generators: EventInvitationGenerators): EventInvitationPlan {
  const normalize = generators.normalizePubkey ?? ((value: string) => normalizeNostrPubkeyHex(value));
  const sender = input.senderPubkey ? normalize(input.senderPubkey) : null;

  const inviteePubkeys: string[] = [];
  for (const candidate of input.participantPubkeys) {
    const pubkey = normalize(candidate);
    if (!pubkey || pubkey === sender || inviteePubkeys.includes(pubkey)) continue;
    inviteePubkeys.push(pubkey);
  }

  // Two spellings of one key normalize to the same key. Object order isn't portable, so the token
  // stored under the canonical spelling wins, then the smallest token.
  const existing = new Map<string, { token: string; canonical: boolean }>();
  for (const [key, token] of Object.entries(input.inviteTokens ?? {})) {
    const pubkey = normalize(key);
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (!pubkey || !trimmed) continue;
    const candidate = { token: trimmed, canonical: key === pubkey };
    const current = existing.get(pubkey);
    if (!current
      || (candidate.canonical && !current.canonical)
      || (candidate.canonical === current.canonical && candidate.token < current.token)) {
      existing.set(pubkey, candidate);
    }
  }

  const inviteTokens: Record<string, string> = {};
  for (const pubkey of inviteePubkeys) inviteTokens[pubkey] = existing.get(pubkey)?.token ?? generators.inviteToken();

  const eventKey = isValidEventKey(input.eventKey) ? input.eventKey!.trim() : generators.eventKey();
  const previous = new Set((input.previousPubkeys ?? []).map((value) => normalize(value)).filter(Boolean));
  const before = input.inviteTokens ?? {};
  const changed =
    eventKey !== input.eventKey ||
    Object.keys(before).length !== inviteePubkeys.length ||
    inviteePubkeys.some((pubkey) => before[pubkey] !== inviteTokens[pubkey]);

  return {
    eventKey,
    inviteTokens: inviteePubkeys.length ? inviteTokens : undefined,
    inviteePubkeys,
    addedPubkeys: inviteePubkeys.filter((pubkey) => !previous.has(pubkey)),
    changed,
  };
}
