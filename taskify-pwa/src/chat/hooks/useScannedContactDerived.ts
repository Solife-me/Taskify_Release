// @ts-nocheck
import { useMemo } from "react";

export function useScannedContactDerived({
  scannedContact,
  contacts,
  normalizeNostrPubkey,
  compressedToRawHex,
  contactSyncMeta,
  sharedContactPreviewContact,
}) {
  const scannedContactSaved = useMemo(() => {
    if (!scannedContact) return false;
    const normalizedTarget = normalizeNostrPubkey(scannedContact.npub || "");
    const targetHex = normalizedTarget ? compressedToRawHex(normalizedTarget).toLowerCase() : null;
    return contacts.some((contact) => {
      if (contact.id === scannedContact.id) return true;
      if (targetHex) {
        const normalizedContact = normalizeNostrPubkey(contact.npub || "");
        const contactHex = normalizedContact ? compressedToRawHex(normalizedContact).toLowerCase() : null;
        if (contactHex && contactHex === targetHex) return true;
      }
      return false;
    });
  }, [compressedToRawHex, contacts, normalizeNostrPubkey, scannedContact]);
  const scannedContactFollowed = useMemo(() => {
    if (!scannedContact?.npub) return false;
    const normalized = normalizeNostrPubkey(scannedContact.npub);
    if (!normalized) return false;
    const targetHex = compressedToRawHex(normalized).toLowerCase();
    return (contactSyncMeta.publicFollows || []).some(
      (follow) => (follow.pubkey || "").toLowerCase() === targetHex,
    );
  }, [compressedToRawHex, contactSyncMeta.publicFollows, normalizeNostrPubkey, scannedContact]);
  const sharedContactPreviewSaved = useMemo(() => {
    if (!sharedContactPreviewContact) return false;
    const normalizedTarget = normalizeNostrPubkey(sharedContactPreviewContact.npub || "");
    const targetHex = normalizedTarget ? compressedToRawHex(normalizedTarget).toLowerCase() : null;
    return contacts.some((contact) => {
      if (contact.id === sharedContactPreviewContact.id) return true;
      if (targetHex) {
        const normalizedContact = normalizeNostrPubkey(contact.npub || "");
        const contactHex = normalizedContact ? compressedToRawHex(normalizedContact).toLowerCase() : null;
        if (contactHex && contactHex === targetHex) return true;
      }
      return false;
    });
  }, [compressedToRawHex, contacts, normalizeNostrPubkey, sharedContactPreviewContact]);
  return {
    scannedContactSaved,
    scannedContactFollowed,
    sharedContactPreviewSaved,
  };
}
