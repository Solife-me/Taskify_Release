/** "Send task" / "Send event": pick a contact to send the item to by private message. */
import { ActionSheet } from "../../../components/ActionSheet";
import type { Contact } from "../../../lib/contacts";
import { ContactRow } from "./ContactRow";

export function ContactShareSheet({
  open,
  title,
  itemLabel,
  contacts,
  busy,
  status,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  /** What is being sent, as the prompt names it ("Buy milk", or "this task"). */
  itemLabel: string;
  /** Contacts that can receive it (those with an npub). */
  contacts: Contact[];
  busy: boolean;
  status: string | null;
  onPick: (contact: Contact) => void;
  onClose: () => void;
}) {
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <ActionSheet open={open} onClose={close} title={title} stackLevel={85}>
      <div className="text-sm text-secondary mb-2">
        Choose a contact to send <span className="font-semibold">{itemLabel}</span>.
      </div>
      {status && <div className="text-sm text-rose-400 mb-2">{status}</div>}
      {contacts.length ? (
        <div className="space-y-2">
          {contacts.map((contact) => (
            <ContactRow key={contact.id} contact={contact} disabled={busy} onClick={() => onPick(contact)} />
          ))}
        </div>
      ) : (
        <div className="text-sm text-secondary">Add a contact with an npub to share.</div>
      )}
      <div className="flex gap-2 mt-3">
        <button type="button" className="ghost-button button-sm pressable flex-1 justify-center" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
    </ActionSheet>
  );
}
