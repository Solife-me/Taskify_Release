/**
 * What happens when a share (a Taskify share envelope in a private message) reaches this device.
 * Chat's message pipeline opens every message once and hands shares here; the inbox then records
 * it locally. Nothing is published: the message stays on the relays for the user's other devices
 * (which apply the same rules, and learn this device's responses through chat-state sync).
 *
 * Only real share envelopes count, as on iOS: a message that merely contains an npub is a
 * message, not a contact share.
 */
import type {
  InboxSender,
  ShareEnvelope,
  SharedCalendarEventInvitePayload,
  SharedContactPayload,
  SharedTaskAssignmentResponsePayload,
} from "taskify-core";

export type IncomingShare = {
  /** The message's event id (the gift wrap's, for NIP-17). */
  eventId: string;
  envelope: ShareEnvelope;
  senderPubkey: string;
  /** Who the message names; empty when it names no one (then it is for this account). */
  recipientPubkeys: string[];
};

type ProfileNames = { name?: string; displayName?: string; username?: string; nip05?: string };

export type ShareInboxDeps = {
  viewerPubkey: string;
  alreadyHandled: (eventId: string) => boolean;
  markHandled: (eventId: string) => void;
  fetchProfile: (pubkey: string) => Promise<ProfileNames | null>;
  addCalendarInvite: (invite: SharedCalendarEventInvitePayload, sender: InboxSender, eventId: string) => void;
  applyAssignmentResponse: (response: SharedTaskAssignmentResponsePayload, sender: InboxSender) => void;
  addInboxItem: (item: Exclude<ShareEnvelope["item"], SharedCalendarEventInvitePayload | SharedTaskAssignmentResponsePayload>, sender: InboxSender, eventId: string) => void;
};

function hasName(contact: SharedContactPayload): boolean {
  return !!(contact.name || contact.displayName || contact.username || contact.nip05);
}

/** Records an incoming share in the inbox. Resolves to whether it was taken. */
export async function receiveIncomingShare(share: IncomingShare, deps: ShareInboxDeps): Promise<boolean> {
  if (!share.eventId || deps.alreadyHandled(share.eventId)) return false;
  const viewer = deps.viewerPubkey.toLowerCase();
  const recipients = share.recipientPubkeys.map((key) => key.toLowerCase());
  if (recipients.length && viewer && !recipients.includes(viewer)) return false;
  deps.markHandled(share.eventId);

  const { envelope } = share;
  let senderName = envelope.sender?.name;
  if (!senderName) {
    const profile = await deps.fetchProfile(share.senderPubkey);
    senderName = profile?.displayName || profile?.name || profile?.username || profile?.nip05;
  }
  const sender: InboxSender = { pubkey: share.senderPubkey, name: senderName, npub: envelope.sender?.npub };

  const item = envelope.item;
  if (item.type === "event") {
    deps.addCalendarInvite(item, sender, share.eventId);
    return true;
  }
  if (item.type === "task-assignment-response") {
    deps.applyAssignmentResponse(item, sender);
    return true;
  }
  if (item.type === "contact" && !hasName(item)) {
    const profile = await deps.fetchProfile(item.npub);
    deps.addInboxItem(
      profile
        ? {
            ...item,
            name: profile.displayName || profile.name || undefined,
            displayName: profile.displayName,
            username: profile.username,
            nip05: profile.nip05,
          }
        : item,
      sender,
      share.eventId,
    );
    return true;
  }
  deps.addInboxItem(item, sender, share.eventId);
  return true;
}
