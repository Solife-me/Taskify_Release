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
export declare function isValidEventKey(value: string | null | undefined): boolean;
export declare function planEventInvitations(input: EventInvitationInput, generators: EventInvitationGenerators): EventInvitationPlan;
