import type { RefObject } from "react";
import { contactDisplayLabel, type Contact } from "../../lib/contacts";
import { CONTACT_PANEL_HEIGHT } from "../../wallet/walletModalHelpers";
import { VerifiedBadgeIcon } from "./walletModalUi";

type IsNip05VerifiedFor = (
  contactId: string,
  nip05?: string | null,
  npub?: string | null
) => boolean;

export interface WalletContactsListPanelProps {
  context: "lightning" | "ecash";
  activeContext: "lightning" | "ecash" | null;
  contacts: Contact[];
  contactSubtitle: (contact: Contact) => string;
  isNip05VerifiedForRef: RefObject<IsNip05VerifiedFor | null>;
  onSelectContact: (contact: Contact) => void;
  normalizeNip05: (value: string | null | undefined) => string | null;
  initialsFor: (value: string) => string;
  truncateContactName: (value: string, maxLength?: number) => string;
}

export function WalletContactsListPanel({
  context,
  activeContext,
  contacts,
  contactSubtitle,
  isNip05VerifiedForRef,
  onSelectContact,
  normalizeNip05,
  initialsFor,
  truncateContactName,
}: WalletContactsListPanelProps) {
  if (activeContext !== context) return null;
  const hasContacts = contacts.length > 0;
  return (
    <div
      className="flex flex-col gap-3 text-xs"
      style={{ minHeight: CONTACT_PANEL_HEIGHT, maxHeight: CONTACT_PANEL_HEIGHT }}
    >
      <div className="contacts-list-view flex-1 min-h-0">
        {hasContacts ? (
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            <div className="contact-list">
              {contacts.map((contact) => {
                const displayName = contactDisplayLabel(contact);
                const displayNameTrimmed = truncateContactName(displayName);
                const subtitle = contactSubtitle(contact) || "No details added";
                const subtitleIsNip05 =
                  !!contact.nip05 &&
                  !!subtitle &&
                  normalizeNip05(contact.nip05) === normalizeNip05(subtitle);
                const nip05Verified =
                  subtitleIsNip05 &&
                  isNip05VerifiedForRef.current?.(contact.id, contact.nip05, contact.npub);
                const photo = contact.picture?.trim();
                return (
                  <button
                    key={contact.id}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => onSelectContact(contact)}
                  >
                    <div className={photo ? "contact-avatar contact-avatar--image" : "contact-avatar"}>
                      {photo ? (
                        <img src={photo} alt={displayName} className="contact-avatar__img" />
                      ) : (
                        initialsFor(displayName)
                      )}
                    </div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{displayNameTrimmed}</div>
                      <div
                        className={`contact-row__meta${subtitleIsNip05 ? " contact-row__meta--nip05" : ""}`}
                      >
                        <span className="contact-row__meta-text">{subtitle}</span>
                        {subtitleIsNip05 && nip05Verified && (
                          <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                        )}
                      </div>
                    </div>
                    <span className="contact-chevron">›</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="contact-empty text-secondary">
            {context === "ecash"
              ? "Add a contact with an npub from the Contacts tab."
              : "Save a lightning address from the Contacts tab."}
          </div>
        )}
      </div>
    </div>
  );
}
