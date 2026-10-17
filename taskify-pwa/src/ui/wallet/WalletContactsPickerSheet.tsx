import type { Contact } from "../../lib/contacts";
import { ActionSheet } from "../../components/ActionSheet";
import { WalletContactsListPanel } from "./WalletContactsListPanel";
import { useWalletContactsRuntime } from "./useWalletContactsRuntime";

type WalletContactsPickerSheetProps = {
  onClose: () => void;
  onSelectContact: (contact: Contact) => void;
};

export function WalletContactsPickerSheet({
  onClose,
  onSelectContact,
}: WalletContactsPickerSheetProps) {
  const {
    contactsOpen,
    contactsContext,
    visibleContacts,
    contactSubtitle,
    isNip05VerifiedForRef,
    normalizeNip05,
    contactInitials,
    truncateContactName,
  } = useWalletContactsRuntime();

  return (
    <ActionSheet
      open={contactsOpen && contactsContext !== null}
      onClose={onClose}
      title={contactsContext === "ecash" ? "eCash contacts" : "Lightning contacts"}
      stackLevel={60}
    >
      {contactsContext && (
        <div className="wallet-section space-y-3 text-sm">
          <WalletContactsListPanel
            context={contactsContext}
            activeContext={contactsContext}
            contacts={visibleContacts}
            contactSubtitle={contactSubtitle}
            isNip05VerifiedForRef={isNip05VerifiedForRef}
            onSelectContact={onSelectContact}
            normalizeNip05={normalizeNip05}
            initialsFor={contactInitials}
            truncateContactName={truncateContactName}
          />
        </div>
      )}
    </ActionSheet>
  );
}
