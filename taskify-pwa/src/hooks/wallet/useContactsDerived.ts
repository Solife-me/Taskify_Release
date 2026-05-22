// @ts-nocheck
import { useMemo } from "react";
import { contactHasNpub, sanitizeUsername } from "../../lib/contacts";
import type { Contact } from "../../lib/contacts";

export function useContactsDerived({
  contacts,
  contactsContext,
  shareContactSource,
  compressedToRawHex,
  normalizeNostrPubkey,
  contactSyncMeta,
  formatNpub,
}) {
  const sortedContacts = useMemo(() => {
    return [...contacts].sort((a, b) => {
      const baseA = (a.name || a.address || a.nip05 || a.npub || "").toLowerCase();
      const baseB = (b.name || b.address || b.nip05 || b.npub || "").toLowerCase();
      if (baseA < baseB) return -1;
      if (baseA > baseB) return 1;
      const fallbackA = a.address || a.npub || "";
      const fallbackB = b.address || b.npub || "";
      return fallbackA.localeCompare(fallbackB);
    });
  }, [contacts]);

  const visibleContacts = useMemo(() => {
    if (!contactsContext) return sortedContacts;
    return sortedContacts.filter((contact) =>
      contactsContext === "lightning"
        ? contact.address.trim().length > 0
        : contactHasNpub(contact) || contact.paymentRequest.trim().length > 0,
    );
  }, [contactsContext, sortedContacts]);

  const shareRecipientOptions = useMemo(() => {
    const sourceHex = shareContactSource?.npub
      ? compressedToRawHex(
          normalizeNostrPubkey(shareContactSource.npub) ?? shareContactSource.npub,
        ).toLowerCase()
      : null;
    return contacts.filter((contact) => {
      if (!contactHasNpub(contact)) return false;
      const normalized = normalizeNostrPubkey(contact.npub);
      const contactHex = normalized
        ? compressedToRawHex(normalized).toLowerCase()
        : contact.npub.trim().toLowerCase();
      if (sourceHex && contactHex && contactHex === sourceHex) return false;
      return true;
    });
  }, [compressedToRawHex, contacts, normalizeNostrPubkey, shareContactSource]);

  const publicFollowOptions = useMemo(
    () => {
      const seen = new Set<string>();
      return (contactSyncMeta.publicFollows || [])
        .map((follow) => {
          const pubkey = (follow.pubkey || "").trim();
          if (!pubkey) return null;
          const key = pubkey.toLowerCase();
          if (seen.has(key)) return null;
          seen.add(key);
          const username = sanitizeUsername(follow.username || "");
          const nip05 = (follow.nip05 || "").trim();
          return {
            pubkey,
            npub: formatNpub(pubkey),
            relay: (follow.relay || "").trim(),
            petname: (follow.petname || "").trim(),
            username: username || undefined,
            nip05: nip05 || undefined,
          };
        })
        .filter(Boolean) as Array<{
          pubkey: string;
          npub: string;
          relay?: string;
          petname?: string;
          username?: string;
          nip05?: string;
        }>;
    },
    [contactSyncMeta.publicFollows, formatNpub],
  );

  const lightningContactCount = useMemo(
    () => contacts.reduce((count, contact) => (contact.address.trim().length > 0 ? count + 1 : count), 0),
    [contacts],
  );

  return {
    sortedContacts,
    visibleContacts,
    shareRecipientOptions,
    publicFollowOptions,
    lightningContactCount,
  };
}
